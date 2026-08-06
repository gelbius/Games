/**
 * Picking the two creatures that get to breed.
 *
 * This is the entire fitness function. There is no scoring anywhere in the
 * project — no distance threshold, no gait analysis, nothing that decides one
 * creature is better than another. Whatever the player finds interesting is,
 * by definition, what gets selected for. That is the whole design, and it is
 * also why the simulation stays cheap: only eight creatures ever run.
 */

export const PARENTS_NEEDED = 2;

export interface PanelRefs {
  root: HTMLButtonElement;
  distance: HTMLElement;
  tag: HTMLElement;
  /** Shows "1st" or "2nd" while the race runs. Owned by the Ranking readout. */
  place: HTMLElement;
}

export class Selection {
  /** Lane indices, in the order they were picked. */
  private picked: number[] = [];

  /**
   * Lanes carried over unchanged from the previous generation — the two the
   * player picked. Nothing to do with how fast anything is.
   */
  private inherited = new Set<number>();

  constructor(
    private readonly panels: readonly PanelRefs[],
    private readonly onChange: (picked: readonly number[]) => void,
  ) {
    this.panels.forEach((panel, index) => {
      panel.root.addEventListener('click', () => this.toggle(index));
    });

    addEventListener('keydown', (e) => {
      // Number keys select too, which is much faster once you know what you are
      // looking at.
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= this.panels.length) this.toggle(n - 1);
    });
  }

  get chosen(): readonly number[] {
    return this.picked;
  }

  get complete(): boolean {
    return this.picked.length === PARENTS_NEEDED;
  }

  toggle(index: number): void {
    const at = this.picked.indexOf(index);
    if (at >= 0) {
      this.picked.splice(at, 1);
    } else if (this.picked.length < PARENTS_NEEDED) {
      this.picked.push(index);
    } else {
      // Already holding two. Rather than refuse the click — which feels broken —
      // drop the older pick and take the new one, so a player can keep
      // comparing without having to deselect first.
      this.picked.shift();
      this.picked.push(index);
    }
    this.render();
    this.onChange(this.picked);
  }

  clear(): void {
    this.picked = [];
    this.render();
    this.onChange(this.picked);
  }

  /** Mark which lanes are the untouched parents of this generation. */
  setInherited(lanes: readonly number[]): void {
    this.inherited = new Set(lanes);
    this.render();
  }

  private render(): void {
    this.panels.forEach((panel, index) => {
      const rank = this.picked.indexOf(index);
      const isPicked = rank >= 0;

      panel.root.dataset.selected = isPicked ? '1' : '';
      panel.root.dataset.parent = !isPicked && this.inherited.has(index) ? '1' : '';
      panel.root.setAttribute('aria-pressed', String(isPicked));

      if (isPicked) panel.tag.textContent = rank === 0 ? 'parent A' : 'parent B';
      // Deliberately not "survivor" or anything else that hints at performance.
      // These two are the creatures the player chose last round, carried through
      // unmutated, and that is all this badge has ever meant. How well they are
      // doing is shown separately, by the placing in the corner label.
      else if (this.inherited.has(index)) panel.tag.textContent = 'your pick';
      else panel.tag.textContent = '';
    });
  }
}
