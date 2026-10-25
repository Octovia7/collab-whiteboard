import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardSummary, User } from './api';
import { openBoardList, socketUrl } from './boardId';
import { Camera } from './canvas/Camera';
import { drawPresence } from './canvas/draw/presence';
import { PanZoomInput } from './canvas/PanZoomInput';
import { Renderer } from './canvas/Renderer';
import { ToolInput } from './canvas/ToolInput';
import { installDebugHandle } from './debug';
import { demoCountFromUrl, seedDemo } from './demo';
import { BoardStore } from './store/BoardStore';
import { History } from './store/History';
import { Presence } from './store/Presence';
import { Selection } from './store/Selection';
import { openBrowserQueue } from './sync/OfflineQueue';
import type { OfflineQueue } from './sync/OfflineQueue';
import { SyncClient } from './sync/SyncClient';
import { ToolController } from './tools/ToolController';
import { ConnectionBadge } from './ui/ConnectionBadge';
import { NoteEditor } from './ui/NoteEditor';
import { OnlineList } from './ui/OnlineList';
import { BackArrowIcon, ShareIcon } from './ui/icons';
import { ShareDialog } from './ui/ShareDialog';
import { Toolbar } from './ui/Toolbar';
import { UndoControls } from './ui/UndoControls';
import { UserMenu } from './ui/UserMenu';
import { ZoomControls } from './ui/ZoomControls';

/** 8 random characters per tab: the clientId part of shape IDs and the Lamport tie-breaker. */
const newClientId = () => crypto.randomUUID().slice(0, 8);

interface Board {
  boardId: string;
  store: BoardStore;
  sync: SyncClient;
  presence: Presence;
  history: History;
  camera: Camera;
  selection: Selection;
  tools: ToolController;
  /** Set once the renderer exists; tools ask for overlay redraws through it. */
  redrawOverlay: { current: () => void };
  /** This tab's offline queue, once opened (null where IndexedDB or Web Locks are unavailable). */
  queue: { current: OfflineQueue | null };
}

function createBoard(boardId: string): Board {
  const store = new BoardStore(newClientId());
  const presence = new Presence();
  const queue: Board['queue'] = { current: null };
  const sync = new SyncClient(store, { url: socketUrl(boardId), boardId, presence, queue: { save: (ops) => queue.current?.save(ops) } });
  const camera = new Camera();
  // Start with a small margin so the first shapes aren't flush against the corner.
  camera.x = -40;
  camera.y = -40;
  const selection = new Selection();
  const redrawOverlay = { current: () => {} };
  const history = new History(store);
  const tools = new ToolController(store, selection, camera, () => redrawOverlay.current(), undefined, history);
  return { boardId, store, sync, presence, history, camera, selection, tools, redrawOverlay, queue };
}

interface Props {
  board: BoardSummary;
  user: User;
  onLogout: () => void;
}

/** One open board: canvas, tools, sync and presence. Rendered by Root once access is confirmed. */
export function App({ board: summary, user, onLogout }: Props) {
  // Created once per mount and never put in React state that changes: the canvas reads the
  // store directly, so shape edits never re-render React.
  const [board] = useState(() => createBoard(summary.id));
  const [sharing, setSharing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const scene = sceneRef.current;
    const overlay = overlayRef.current;
    if (!container || !scene || !overlay) return;
    const { store, sync, presence, camera, selection, tools, redrawOverlay, queue } = board;

    const renderer = new Renderer(container, scene, overlay, store, camera);
    const visibleBounds = (id: string) => (store.isVisible(id) ? store.boundsOf(id) : undefined);
    renderer.setOverlayDrawer((ctx, cam) => {
      tools.drawOverlay(ctx, cam);
      // Ease remote cursors toward their latest position; keep requesting frames only while
      // one is still moving, so an idle board draws nothing.
      const moving = presence.step();
      drawPresence(ctx, cam.zoom, presence.visible(), visibleBounds);
      if (moving) renderer.markOverlayDirty();
    });
    redrawOverlay.current = () => renderer.markOverlayDirty();
    renderer.start();

    // Input goes on the overlay because it's the top canvas. PanZoomInput attaches first so
    // it sees space/middle-button presses before the tools do. Every pointer position (in
    // world coordinates) also becomes my presence cursor.
    const panZoom = new PanZoomInput(overlay, camera);
    const detachPanZoom = panZoom.attach();
    const detachTools = new ToolInput(overlay, camera, tools, panZoom, (p) => sync.sendCursor(p.x, p.y)).attach();

    const offSelection = selection.events.on('change', () => {
      renderer.markOverlayDirty();
      sync.sendSelection(selection.list());
    });
    const offMoved = presence.events.on('moved', () => renderer.markOverlayDirty());
    const offPeers = presence.events.on('peers', () => renderer.markOverlayDirty());
    // A selected shape deleted by someone else (or by undo, later) drops out of the selection.
    const offPrune = store.events.on('change', () => selection.retain((id) => store.isVisible(id)));
    // Viewers get a read-only UI, switched live when the owner changes their role.
    const offRole = sync.events.on('role', (role) => tools.setReadOnly(role === 'viewer'));
    // Sticky notes: a note someone else is typing in is soft-locked here, and my own editing
    // is announced so other tabs show "… is typing".
    tools.setNoteLock((id) => presence.typingIn(id) !== undefined);
    const offEditing = tools.events.on('change', () => sync.sendTyping(tools.editingNote));
    // Logged out in another tab (on any server): this session is dead, go back to the login page.
    const offStatus = sync.events.on('status', (status) => {
      if (status === 'disconnected' && sync.closeReason === 'logged_out') onLogout();
    });

    // ?demo=N seeds only an empty board, after the server's snapshot has arrived, so a second
    // tab on the same board doesn't add another copy.
    const demo = demoCountFromUrl();
    const offWelcome = sync.events.on('welcome', () => {
      if (demo > 0 && store.size === 0) seedDemo(store, demo);
    });
    // Offline queue first: edits saved by an earlier load of this tab, or by closed tabs, are
    // restored (and the clock observes their stamps) before this tab can make any edit of its
    // own, so tools stay read-only until then. Only then connect, so they go out with the hello.
    let disposed = false;
    tools.setReadOnly(true);
    void openBrowserQueue(board.boardId, user.id, () => disposed).then((opened) => {
      if (disposed) {
        opened?.queue.close();
        return;
      }
      if (opened) {
        queue.current = opened.queue;
        sync.restore(opened.restored);
      }
      tools.setReadOnly(sync.role === 'viewer');
      sync.start();
    });
    // Development and E2E builds only: the constant check lets the production bundle drop debug.ts.
    const uninstallDebug = __DEBUG_HANDLE__ ? installDebugHandle(board) : () => {};

    return () => {
      uninstallDebug();
      disposed = true;
      sync.stop();
      // Unsent edits stay saved; releasing the lock lets the next load adopt them.
      queue.current?.close();
      queue.current = null;
      offRole();
      offStatus();
      offEditing();
      offWelcome();
      offPrune();
      offPeers();
      offMoved();
      offSelection();
      detachTools();
      detachPanZoom();
      redrawOverlay.current = () => {};
      renderer.stop();
    };
  }, [board, user.id, onLogout]);

  const getCenter = useCallback(() => {
    const el = containerRef.current;
    return { x: (el?.clientWidth ?? 0) / 2, y: (el?.clientHeight ?? 0) / 2 };
  }, []);

  return (
    <>
      <div ref={containerRef} className="board">
        <canvas ref={sceneRef} />
        <canvas ref={overlayRef} />
      </div>
      <Toolbar tools={board.tools} selection={board.selection} />
      <ZoomControls camera={board.camera} getCenter={getCenter} />
      <UndoControls tools={board.tools} history={board.history} />
      <header className="board-header panel">
        <button type="button" className="ghost-button back-button" onClick={openBoardList} title="All boards">
          <BackArrowIcon />
          Boards
        </button>
        <span className="board-title" title={summary.title}>
          {summary.title}
        </span>
      </header>
      <div className="board-actions panel">
        <OnlineList presence={board.presence} />
        {summary.role === 'owner' && (
          <button type="button" className="primary-button share-button" onClick={() => setSharing(true)}>
            <ShareIcon />
            Share
          </button>
        )}
        <UserMenu user={user} onLogout={onLogout} />
      </div>
      <ConnectionBadge sync={board.sync} boardId={board.boardId} />
      <NoteEditor tools={board.tools} store={board.store} camera={board.camera} />
      {sharing && <ShareDialog boardId={board.boardId} onClose={() => setSharing(false)} />}
    </>
  );
}
