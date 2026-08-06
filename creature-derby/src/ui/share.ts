/**
 * Putting a creature in the address bar.
 *
 * The genome codec was built in the second commit precisely so this could be a
 * few lines rather than a feature. A creature's entire description — every
 * part, every joint, every oscillator — fits in a link, so sharing one needs no
 * server, no database and no accounts, and a link keeps working forever without
 * anything being hosted.
 */

import { decodeGenome, encodeGenome } from '../genome/codec.ts';
import type { Genome } from '../genome/types.ts';

const KEY = 'c';

/** A full URL that will open this exact creature. */
export function linkTo(genome: Genome): string {
  return `${location.origin}${location.pathname}#${KEY}=${encodeGenome(genome)}`;
}

/**
 * The creature named in the current URL, if there is one and it is valid.
 *
 * Returns null rather than throwing. The string came from a link somebody was
 * sent, so it may have been truncated by a chat client, mangled by an email
 * wrapper, or simply typed wrong — none of which should stop the game loading.
 */
export function genomeFromUrl(): { genome: Genome } | { error: string } | null {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const code = params.get(KEY);
  if (!code) return null;

  try {
    return { genome: decodeGenome(code) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop the creature from the address bar without reloading the page. */
export function clearUrl(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/**
 * Copy text, falling back to a hidden textarea.
 *
 * navigator.clipboard is unavailable on plain-HTTP origins, which includes the
 * `npm run dev` server as soon as you open it from another machine on your
 * network — exactly when you are most likely to want to share something.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
