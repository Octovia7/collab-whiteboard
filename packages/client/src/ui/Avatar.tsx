/** Up to two initials from a display name ("Ada Lovelace" -> "AL"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters.map((p) => (p ?? '?').charAt(0).toUpperCase()).join('');
}

/** A round badge with someone's initials; `color` is their cursor color when they have one. */
export function Avatar({ name, color, size = 24 }: { name: string; color?: string; size?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: color ?? 'var(--accent)' }}
    >
      {initials(name)}
    </span>
  );
}
