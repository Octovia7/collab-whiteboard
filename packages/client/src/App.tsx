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
import { Presence } from './store/Presence';
import { Selection } from './store/Selection';
import { SyncClient } from './sync/SyncClient';
import { ToolController } from './tools/ToolController';
import { ConnectionBadge } from './ui/ConnectionBadge';
import { OnlineList } from './ui/OnlineList';
import { Toolbar } from './ui/Toolbar';
import { UserMenu } from './ui/UserMenu';
import { ZoomControls } from './ui/ZoomControls';

/** 8 random characters per tab: the clientId part of shape IDs and the Lamport tie-breaker. */
const newClientId = () => crypto.randomUUID().slice(0, 8);

interface Board {
  boardId: string;
  store: BoardStore;
  sync: SyncClient;
  presence: Presence;
  camera: Camera;
  selection: Selection;
  tools: ToolController;
  /** Set once the renderer exists; tools ask for overlay redraws through it. */
  redrawOverlay: { current: () => void };
}

function createBoard(boardId: string): Board {
  const store = new BoardStore(newClientId());
  const presence = new Presence();
  const sync = new SyncClient(store, { url: socketUrl(boardId), boardId, presence });
  const camera = new Camera();
  // Start with a small margin so the first shapes aren't flush against the corner.
  camera.x = -40;
  camera.y = -40;
  const selection = new Selection();
  const redrawOverlay = { current: () => {} };
  const tools = new ToolController(store, selection, camera, () => redrawOverlay.current());
  return { boardId, store, sync, presence, camera, selection, tools, redrawOverlay };
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
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const scene = sceneRef.current;
    const overlay = overlayRef.current;
    if (!container || !scene || !overlay) return;
    const { store, sync, presence, camera, selection, tools, redrawOverlay } = board;

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

    // ?demo=N seeds only an empty board, after the server's snapshot has arrived, so a second
    // tab on the same board doesn't add another copy.
    const demo = demoCountFromUrl();
    const offWelcome = sync.events.on('welcome', () => {
      if (demo > 0 && store.size === 0) seedDemo(store, demo);
    });
    sync.start();
    // Dev/test builds only: the constant check lets the production bundle drop debug.ts.
    const uninstallDebug = import.meta.env.DEV ? installDebugHandle(board) : () => {};

    return () => {
      uninstallDebug();
      sync.stop();
      offRole();
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
  }, [board]);

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
      <header className="board-header">
        <button type="button" className="link" onClick={openBoardList}>
          ← Boards
        </button>
        <span className="board-title">{summary.title}</span>
        <OnlineList presence={board.presence} />
        <UserMenu user={user} onLogout={onLogout} />
      </header>
      <ConnectionBadge sync={board.sync} boardId={board.boardId} />
    </>
  );
}
