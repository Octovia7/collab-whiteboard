import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Camera } from '../canvas/Camera';
import { NOTE_FONT_SIZE, NOTE_PADDING, NOTE_TEXT_COLOR } from '../canvas/draw/note';
import type { BoardStore } from '../store/BoardStore';
import type { ToolController } from '../tools/ToolController';

interface Props {
  tools: ToolController;
  store: BoardStore;
  camera: Camera;
}

/**
 * The textarea over a note while its text is edited (system-design.md: "TextEditor.ts,
 * textarea overlay for notes"). The text is saved once, on blur (or Escape), as one LWW update
 * of the whole text. React renders the value: nothing user-typed is ever set as HTML.
 * It re-renders on camera moves only while open, to stay over the note.
 */
export function NoteEditor({ tools, store, camera }: Props) {
  const onTools = useCallback((notify: () => void) => tools.events.on('change', notify), [tools]);
  const editing = useSyncExternalStore(onTools, () => tools.editingNote);
  const onCamera = useCallback(
    (notify: () => void) => (editing ? camera.events.on('change', notify) : () => {}),
    [camera, editing],
  );
  // A string snapshot (stable while unchanged) so pans re-render but nothing else does.
  const view = useSyncExternalStore(onCamera, () => `${camera.x},${camera.y},${camera.zoom}`);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) return null;
  const note = store.get(editing);
  if (!note) return null;
  void view;
  const topLeft = camera.toScreen(Math.min(note.x, note.x + note.w), Math.min(note.y, note.y + note.h));
  const z = camera.zoom;
  return (
    <textarea
      key={editing}
      ref={ref}
      className="note-editor"
      aria-label="Note text"
      defaultValue={note.text ?? ''}
      maxLength={10_000}
      spellCheck
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: Math.abs(note.w) * z,
        height: Math.abs(note.h) * z,
        fontSize: NOTE_FONT_SIZE * z,
        padding: NOTE_PADDING * z,
        color: NOTE_TEXT_COLOR,
        borderColor: note.color,
        // The note's own tint, so the editor looks like the note it replaces.
        background: `color-mix(in srgb, ${note.color} 22%, white)`,
      }}
      onBlur={(e) => tools.finishEditing(e.currentTarget.value)}
      onKeyDown={(e) => {
        // Keys typed into the note must not reach the board's shortcuts (Delete, tool keys).
        e.stopPropagation();
        if (e.key === 'Escape') e.currentTarget.blur();
      }}
    />
  );
}
