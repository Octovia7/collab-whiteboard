import { useCallback, useSyncExternalStore } from 'react';
import type { History } from '../store/History';
import type { ToolController } from '../tools/ToolController';
import { RedoIcon, UndoIcon } from './icons';

/** Undo / redo for this tab's own edits (algorithms.md §9). Bottom left, next to zoom. */
export function UndoControls({ tools, history }: { tools: ToolController; history: History }) {
  const onHistory = useCallback((notify: () => void) => history.events.on('change', notify), [history]);
  const onTools = useCallback((notify: () => void) => tools.events.on('change', notify), [tools]);
  const canUndo = useSyncExternalStore(onHistory, () => history.canUndo);
  const canRedo = useSyncExternalStore(onHistory, () => history.canRedo);
  const readOnly = useSyncExternalStore(onTools, () => tools.readOnly);
  return (
    <div className="undo-controls panel">
      <button type="button" className="icon-button" disabled={readOnly || !canUndo} aria-label="Undo" title="Undo (Ctrl+Z)" onClick={() => tools.undo()}>
        <UndoIcon />
      </button>
      <button type="button" className="icon-button" disabled={readOnly || !canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={() => tools.redo()}>
        <RedoIcon />
      </button>
    </div>
  );
}
