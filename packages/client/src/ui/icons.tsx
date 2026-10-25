import type { ReactNode } from 'react';

/**
 * Small inline SVG icons (24x24 grid, stroked with currentColor), so buttons follow the text
 * color of their state. Drawn here rather than pulled from an icon library: a dozen paths.
 */
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SelectIcon = () => (
  <Icon>
    <path d="M5 3.5 18.5 10l-6 1.6L9.8 17.5z" />
    <path d="m12.6 11.7 4.6 4.6" />
  </Icon>
);
export const RectIcon = () => (
  <Icon>
    <rect x="4" y="5.5" width="16" height="13" rx="2" />
  </Icon>
);
export const EllipseIcon = () => (
  <Icon>
    <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
  </Icon>
);
export const ArrowIcon = () => (
  <Icon>
    <path d="M5 19 19 5" />
    <path d="M10 5h9v9" />
  </Icon>
);
export const PenIcon = () => (
  <Icon>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
    <path d="m14.5 5.5 3 3" />
  </Icon>
);
export const EraserIcon = () => (
  <Icon>
    <path d="m7 20-3.3-3.3a1.5 1.5 0 0 1 0-2.1L13.6 4.7a1.5 1.5 0 0 1 2.1 0l4.6 4.6a1.5 1.5 0 0 1 0 2.1L11.5 20z" />
    <path d="M7 20h13" />
    <path d="m9 11 5.5 5.5" />
  </Icon>
);
export const NoteIcon = () => (
  <Icon>
    <path d="M5 4h14v10l-5 6H5z" />
    <path d="M14 20v-6h5" />
    <path d="M8.5 8.5h7M8.5 11.5h4" />
  </Icon>
);
export const FrontIcon = () => (
  <Icon>
    <rect x="8" y="3.5" width="12" height="12" rx="2" fill="currentColor" fillOpacity="0.18" />
    <path d="M4 8.5v10a2 2 0 0 0 2 2h10" />
  </Icon>
);
export const BackIcon = () => (
  <Icon>
    <path d="M10 3.5h8a2 2 0 0 1 2 2v8" />
    <rect x="4" y="8.5" width="12" height="12" rx="2" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4 7h16" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M6.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5L17.5 7" />
    <path d="M10 11v6M14 11v6" />
  </Icon>
);
export const UndoIcon = () => (
  <Icon>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
);
export const RedoIcon = () => (
  <Icon>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
);
export const MinusIcon = () => (
  <Icon size={16}>
    <path d="M5 12h14" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon size={16}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const ShareIcon = () => (
  <Icon size={16}>
    <path d="M12 15V3.5" />
    <path d="m7.5 8 4.5-4.5L16.5 8" />
    <path d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" />
  </Icon>
);
export const BackArrowIcon = () => (
  <Icon size={16}>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Icon>
);
export const BoardIcon = () => (
  <Icon size={20}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M7.5 15.5c2-3.5 3.5-5 5.5-3s3 .5 4-1.5" />
  </Icon>
);

/** The app's mark: a rounded tile with a scribble, in the accent color. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M8 20.5c2.5-6 5-8.5 7.5-5.5s4 3.5 8.5-4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23.5" cy="10.5" r="2" fill="#fff" />
    </svg>
  );
}
