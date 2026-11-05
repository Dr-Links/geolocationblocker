import { createHash, randomInt } from 'node:crypto';

// 31 characters without look-alikes (no 0/O, 1/I/L): 16 of them give about 79 bits — impossible to guess.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A new code, e.g. AWM-7KQ2-M9XD-4TPH-ZC3R. */
export function generateActivationCode(): string {
  const body = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `AWM-${body.match(/.{4}/g)!.join('-')}`;
}

/** What the user typed, reduced to the 16 code characters (spaces, dashes, case and the AWM prefix don't matter). */
export function normalizeActivationCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('AWM') && s.length === 19) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1'); // typed look-alikes never match a real code
  return /^[2-9A-HJKMNP-Z]{16}$/.test(s) ? s : null;
}

export const activationCodeHash = (normalized: string) => createHash('sha256').update(`awm-activation:${normalized}`).digest();
