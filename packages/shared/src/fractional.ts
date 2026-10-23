/**
 * Fractional indexing for z-order. Keys are base-36 strings compared with plain `<`.
 * There is always room for a new key between two others (the key just gets longer),
 * so moving a shape changes only that shape's `z`, as one LWW update.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

/** '' is allowed as an open bound. Real keys must use DIGITS and must not end in '0'. */
export function isValidKey(key: string): boolean {
  if (key === '') return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  // A key ending in '0' has no key between it and its prefix ("a" < ? < "a0"),
  // because '0' is the smallest digit and shorter strings sort first.
  return !key.endsWith('0');
}

/**
 * Returns a key strictly between `a` and `b`. `a = ''` means "before everything",
 * `b = ''` means "after everything". Throws on invalid keys or `a >= b`.
 */
export function keyBetween(a: string, b: string): string {
  if (a !== '' && !isValidKey(a)) throw new Error(`invalid fractional key: "${a}"`);
  if (b !== '' && !isValidKey(b)) throw new Error(`invalid fractional key: "${b}"`);
  if (a !== '' && b !== '' && a >= b) throw new Error(`keyBetween: "${a}" is not before "${b}"`);

  let result = '';
  for (let i = 0; ; i++) {
    // Past the end of `a`, treat it as padded with the smallest digit (0).
    const lo = i < a.length ? DIGITS.indexOf(a.charAt(i)) : 0;
    // Past the end of `b` (or no upper bound), anything goes: one past the largest digit.
    const hi = b !== '' && i < b.length ? DIGITS.indexOf(b.charAt(i)) : BASE;
    if (hi - lo > 1) {
      // Room at this digit: the midpoint is > lo >= 0, so the key never ends in '0'.
      return result + DIGITS.charAt(Math.floor((lo + hi) / 2));
    }
    // No room here: copy a's digit and look one position deeper. Once our prefix is
    // already smaller than b's, hi no longer constrains correctness; the loop still ends
    // because once `a` runs out lo is 0, and once `b` runs out hi is BASE.
    result += DIGITS.charAt(lo);
  }
}

/**
 * Draw order: by z key, then by shape id. Two clients inserting at the same spot compute
 * the same key; the id tie-break makes their order identical on every screen.
 */
export function compareDrawOrder(a: { z: string; id: string }, b: { z: string; id: string }): number {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
