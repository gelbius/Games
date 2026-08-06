/**
 * The "what am I looking at" panel.
 *
 * The game opens on eight nameless boxes flailing at nothing, with no title
 * screen and no instructions. That is a fine second impression and a terrible
 * first one — the first person shown it asked exactly that question. This
 * answers it in about fifteen seconds of reading, once, and then never appears
 * again unless asked for.
 *
 * Deliberately not a tutorial. Three steps and one sentence about what the game
 * is actually for. Anything longer would be read by nobody.
 */

const SEEN_KEY = 'derby.intro.seen';

export interface IntroOptions {
  /**
   * Called when the panel is dismissed for the very first time, so the race can
   * start over. Without it a new player reads for fifteen seconds, closes the
   * panel, and finds the race they came to watch already finished.
   */
  onFirstDismiss?: () => void;
}

/**
 * Whether this browser has seen the intro before.
 *
 * localStorage throws rather than returns null in a few situations — Safari's
 * private mode historically, and any browser with site data blocked. A player
 * who has locked down storage should still get the game, so a failure here is
 * treated as "not seen", which shows the panel every time rather than never.
 */
function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Nothing to do. The panel will appear again next visit, which is a far
    // smaller problem than refusing to start.
  }
}

export class Intro {
  private firstDismissPending = false;

  constructor(
    private readonly dialog: HTMLDialogElement,
    startButton: HTMLButtonElement,
    reopenButton: HTMLButtonElement,
    private readonly options: IntroOptions = {},
  ) {
    startButton.addEventListener('click', () => this.close());
    reopenButton.addEventListener('click', () => this.open());

    // Clicking the darkened area outside the panel closes it, which is what
    // people try before looking for a button.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.close();
    });

    // A native dialog closes itself on Escape without telling us, so the
    // bookkeeping hangs off the close event rather than off any one control.
    this.dialog.addEventListener('close', () => {
      markSeen();
      if (this.firstDismissPending) {
        this.firstDismissPending = false;
        this.options.onFirstDismiss?.();
      }
    });
  }

  /** Show the panel because the player asked for it. */
  open(): void {
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Show the panel only if this browser has never seen it. */
  openIfNew(): boolean {
    if (hasSeen()) return false;
    this.firstDismissPending = true;
    this.dialog.showModal();
    return true;
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }
}

/** Forget that the intro was seen. Exposed for the browser console and tests. */
export function forgetIntro(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // Same as above: nothing sensible to do, and nothing depends on it.
  }
}
