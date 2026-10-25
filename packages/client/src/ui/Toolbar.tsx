import { useCallback, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Selection } from '../store/Selection';
import type { ToolName } from '../tools/Tool';
import { COLORS } from '../tools/ToolController';
import type { ToolController } from '../tools/ToolController';
import { ArrowIcon, BackIcon, EllipseIcon, EraserIcon, FrontIcon, NoteIcon, PenIcon, RectIcon, SelectIcon, TrashIcon } from './icons';

const TOOLS: { name: ToolName; label: string; key: string; icon: ReactNode }[] = [
  { name: 'select', label: 'Select', key: 'V', icon: <SelectIcon /> },
  { name: 'rect', label: 'Rectangle', key: 'R', icon: <RectIcon /> },
  { name: 'ellipse', label: 'Ellipse', key: 'O', icon: <EllipseIcon /> },
  { name: 'arrow', label: 'Arrow', key: 'A', icon: <ArrowIcon /> },
  { name: 'pen', label: 'Pen', key: 'P', icon: <PenIcon /> },
  { name: 'eraser', label: 'Eraser', key: 'E', icon: <EraserIcon /> },
  { name: 'note', label: 'Note', key: 'N', icon: <NoteIcon /> },
];

interface Props {
  tools: ToolController;
  selection: Selection;
}

/**
 * Tool picker, colors and selection actions. Subscribes only to tool/color changes and the
 * selection size, never to the board, so drawing and dragging don't re-render React.
 * Icon buttons keep their names as aria-labels (and tooltips with the shortcut).
 */
export function Toolbar({ tools, selection }: Props) {
  const onTools = useCallback((notify: () => void) => tools.events.on('change', notify), [tools]);
  const onSelection = useCallback((notify: () => void) => selection.events.on('change', notify), [selection]);
  const tool = useSyncExternalStore(onTools, () => tools.tool);
  const color = useSyncExternalStore(onTools, () => tools.color);
  const selected = useSyncExternalStore(onSelection, () => selection.size);
  const readOnly = useSyncExternalStore(onTools, () => tools.readOnly);

  return (
    <div className="toolbar panel" role="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.name}
          type="button"
          className={`icon-button${t.name === tool ? ' active' : ''}`}
          disabled={readOnly && t.name !== 'select'}
          aria-pressed={t.name === tool}
          aria-label={t.label}
          title={`${t.label} (${t.key})`}
          onClick={() => tools.setTool(t.name)}
        >
          {t.icon}
          <span className="shortcut" aria-hidden="true">
            {t.key}
          </span>
        </button>
      ))}
      <span className="divider" />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${c === color ? ' active' : ''}`}
          disabled={readOnly}
          style={{ background: c }}
          aria-label={`Color ${c}`}
          aria-pressed={c === color}
          title={c}
          onClick={() => tools.setColor(c)}
        />
      ))}
      <span className="divider" />
      <button type="button" className="icon-button" disabled={readOnly || selected === 0} aria-label="Front" title="Bring to front (])" onClick={() => tools.bringToFront()}>
        <FrontIcon />
      </button>
      <button type="button" className="icon-button" disabled={readOnly || selected === 0} aria-label="Back" title="Send to back ([)" onClick={() => tools.sendToBack()}>
        <BackIcon />
      </button>
      <button type="button" className="icon-button danger" disabled={readOnly || selected === 0} aria-label="Delete" title="Delete (Del)" onClick={() => tools.deleteSelection()}>
        <TrashIcon />
      </button>
    </div>
  );
}
