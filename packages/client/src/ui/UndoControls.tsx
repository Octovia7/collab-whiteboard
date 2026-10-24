import { useCallback, useSyncExternalStore } from 'react';
import type { History } from '../store/History';
import type { ToolController } from '../tools/ToolController';

/** Undo / redo for this tab's own edits (algorithms.md §9). Bottom left, next to zoom. */
export function UndoControls({ tools, history }: { tools: ToolController; history: History }) {
  const onHistory = useCallback((notify: () => void) => history.events.on('change', notify), [history]);
  const onTools = useCallback((notify: () => void) => tools.events.on('change', notify), [tools]);
  const canUndo = useSyncExternalStore(onHistory, () => history.canUndo);
  const canRedo = useSyncExternalStore(onHistory, () => history.canRedo);
  const readOnly = useSyncExternalStore(onTools, () => tools.readOnly);
  return (
    <div className="undo-controls">
      <button type="button" disabled={readOnly || !canUndo} title="Undo (Ctrl+Z)" onClick={() => tools.undo()}>
        Undo
      </button>
      <button type="button" disabled={readOnly || !canRedo} title="Redo (Ctrl+Shift+Z)" onClick={() => tools.redo()}>
        Redo
      </button>
    </div>
  );
}
