/**
 * Fractional indexing for z-order (algorithms.md §5). Keys are strings compared with plain
 * `<`; there is always room for a new key between two others, so moving a shape changes only
 * that shape's `z`, as one LWW update.
 *
 * A key is an INTEGER part followed by an optional FRACTION:
 *
 *   key = head + digits    + fraction
 *         'k'    'a3'        'i'           e.g. "ka3i"
 *
 * The head character encodes how many digits the integer has, so integers of different
 * lengths still sort correctly as strings:
 *   head 'i'..'z' -> 1..18 digits, the non-negative side: i0 < i1 < ... < iz < j00 < ... < jzz < k000
 *   head 'h'..'0' -> 1..18 digits, below i0:  ... gzz < h0 < ... < hz < i0
 *
 * Inserting on top or at the bottom (the common case: every new shape goes on top) just
 * increments or decrements the integer, so keys grow logarithmically: 36 keys fit in 2 chars,
 * 1,296 more in 3, 46,656 more in 4. Only inserts between two neighbours use the fraction,
 * which grows by about one character per ~6 inserts at the same spot.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
/** Index of 'i': heads at or above it are the non-negative side. */
const ZERO_HEAD = 18;
/** The first key ever handed out. */
const FIRST_KEY = 'i0';

const digitAt = (s: string, i: number) => DIGITS.indexOf(s.charAt(i));

/** Number of integer digits encoded by a head character, or -1 if it isn't one. */
function integerDigits(head: string): number {
  const h = DIGITS.indexOf(head);
  if (h < 0) return -1;
  return h >= ZERO_HEAD ? h - ZERO_HEAD + 1 : ZERO_HEAD - h;
}

/** The integer part (head + digits) of a valid key. */
function integerPart(key: string): string {
  return key.slice(0, 1 + integerDigits(key.charAt(0)));
}

/**
 * Valid keys: a head, exactly the right number of integer digits, and a fraction that
 * doesn't end in '0' (a trailing 0 would leave no room between "x" and "x0").
 */
export function isValidKey(key: string): boolean {
  if (key === '') return false;
  for (const ch of key) if (!DIGITS.includes(ch)) return false;
  const n = integerDigits(key.charAt(0));
  if (key.length < 1 + n) return false;
  return !key.slice(1 + n).endsWith('0');
}

/**
 * Returns a key strictly between `a` and `b`. `a = ''` means "before everything",
 * `b = ''` means "after everything". Throws on invalid keys or `a >= b`.
 */
export function keyBetween(a: string, b: string): string {
  if (a !== '' && !isValidKey(a)) throw new Error(`invalid fractional key: "${a}"`);
  if (b !== '' && !isValidKey(b)) throw new Error(`invalid fractional key: "${b}"`);
  if (a !== '' && b !== '' && a >= b) throw new Error(`keyBetween: "${a}" is not before "${b}"`);

  if (a === '' && b === '') return FIRST_KEY;

  if (a === '') {
    // Before b. If b has a fraction, its bare integer is already smaller; otherwise step down.
    const ib = integerPart(b);
    return ib < b ? ib : decrementInteger(ib);
  }

  if (b === '') {
    // After a: a bigger integer beats any fraction, so drop a's fraction and step up.
    return incrementInteger(integerPart(a));
  }

  const ia = integerPart(a);
  const ib = integerPart(b);
  if (ia === ib) {
    // Same integer: only the fractions differ, so split the gap between them.
    return ia + midpoint(a.slice(ia.length), b.slice(ib.length));
  }
  // Different integers: the next integer up from a is the shortest candidate, if it fits.
  const next = incrementInteger(ia);
  if (next < b) return next;
  // a and b are adjacent integers (e.g. i4 and i5): extend a with a fraction. Any fraction
  // keeps the key below b, because b's integer is bigger.
  return ia + midpoint(a.slice(ia.length), '');
}

/**
 * A fraction strictly between fractions `a` and `b` ('' = no bound). This is the original
 * digit-by-digit midpoint: where the two digits have room between them, take the middle;
 * otherwise copy a's digit and look one position deeper.
 */
function midpoint(a: string, b: string): string {
  let result = '';
  for (let i = 0; ; i++) {
    // Past the end of `a`, treat it as padded with the smallest digit (0).
    const lo = i < a.length ? digitAt(a, i) : 0;
    // Past the end of `b` (or no upper bound), one past the largest digit.
    const hi = b !== '' && i < b.length ? digitAt(b, i) : BASE;
    if (hi - lo > 1) {
      // The midpoint is > lo >= 0, so the result never ends in '0'.
      return result + DIGITS.charAt(Math.floor((lo + hi) / 2));
    }
    // No room here. Once our prefix is already below b's, hi stops mattering; the loop still
    // ends because lo becomes 0 once `a` runs out and hi becomes BASE once `b` runs out.
    result += DIGITS.charAt(lo);
  }
}

/** The next integer up. Past the largest integer of this length, moves to the next head. */
function incrementInteger(int: string): string {
  const head = DIGITS.indexOf(int.charAt(0));
  const digits = addOne(int.slice(1));
  if (digits !== null) return int.charAt(0) + digits;
  // e.g. "iz" + 1 = "j00", "gzz" + 1 = "h0", "hz" + 1 = "i0"
  if (head + 1 >= BASE) throw new Error('fractional key space exhausted');
  const nextHead = DIGITS.charAt(head + 1);
  return nextHead + '0'.repeat(integerDigits(nextHead));
}

/** The next integer down. Below the smallest integer of this length, moves to the previous head. */
function decrementInteger(int: string): string {
  const head = DIGITS.indexOf(int.charAt(0));
  const digits = subtractOne(int.slice(1));
  if (digits !== null) return int.charAt(0) + digits;
  // e.g. "j00" - 1 = "iz", "i0" - 1 = "hz", "h0" - 1 = "gzz"
  if (head - 1 < 0) throw new Error('fractional key space exhausted');
  const prevHead = DIGITS.charAt(head - 1);
  return prevHead + DIGITS.charAt(BASE - 1).repeat(integerDigits(prevHead));
}

/** Base-36 increment of a fixed-length digit string; null on overflow ("zz" + 1). */
function addOne(digits: string): string | null {
  const out = [...digits];
  for (let i = out.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(out[i] as string);
    if (d < BASE - 1) {
      out[i] = DIGITS.charAt(d + 1);
      return out.join('');
    }
    out[i] = '0'; // carry
  }
  return null;
}

/** Base-36 decrement of a fixed-length digit string; null on underflow ("00" - 1). */
function subtractOne(digits: string): string | null {
  const out = [...digits];
  for (let i = out.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(out[i] as string);
    if (d > 0) {
      out[i] = DIGITS.charAt(d - 1);
      return out.join('');
    }
    out[i] = DIGITS.charAt(BASE - 1); // borrow
  }
  return null;
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
