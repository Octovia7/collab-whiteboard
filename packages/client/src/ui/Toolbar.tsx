import { useCallback, useSyncExternalStore } from 'react';
import type { Selection } from '../store/Selection';
import type { ToolName } from '../tools/Tool';
import { COLORS } from '../tools/ToolController';
import type { ToolController } from '../tools/ToolController';

const TOOLS: { name: ToolName; label: string; key: string }[] = [
  { name: 'select', label: 'Select', key: 'V' },
  { name: 'rect', label: 'Rectangle', key: 'R' },
  { name: 'ellipse', label: 'Ellipse', key: 'O' },
  { name: 'arrow', label: 'Arrow', key: 'A' },
];

interface Props {
  tools: ToolController;
  selection: Selection;
}

/**
 * Tool picker, colors and selection actions. Subscribes only to tool/color changes and the
 * selection size, never to the board, so drawing and dragging don't re-render React.
 */
export function Toolbar({ tools, selection }: Props) {
  const onTools = useCallback((notify: () => void) => tools.events.on('change', notify), [tools]);
  const onSelection = useCallback((notify: () => void) => selection.events.on('change', notify), [selection]);
  const tool = useSyncExternalStore(onTools, () => tools.tool);
  const color = useSyncExternalStore(onTools, () => tools.color);
  const selected = useSyncExternalStore(onSelection, () => selection.size);
  const readOnly = useSyncExternalStore(onTools, () => tools.readOnly);

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.name}
          type="button"
          className={t.name === tool ? 'active' : undefined}
          disabled={readOnly && t.name !== 'select'}
          aria-pressed={t.name === tool}
          title={`${t.label} (${t.key})`}
          onClick={() => tools.setTool(t.name)}
        >
          {t.label}
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
          onClick={() => tools.setColor(c)}
        />
      ))}
      <span className="divider" />
      <button type="button" disabled={readOnly || selected === 0} title="Bring to front (])" onClick={() => tools.bringToFront()}>
        Front
      </button>
      <button type="button" disabled={readOnly || selected === 0} title="Send to back ([)" onClick={() => tools.sendToBack()}>
        Back
      </button>
      <button type="button" disabled={readOnly || selected === 0} title="Delete (Del)" onClick={() => tools.deleteSelection()}>
        Delete
      </button>
    </div>
  );
}
