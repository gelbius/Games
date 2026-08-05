/**
 * The family tree: how the creatures on screen came to be.
 *
 * Every generation descends from exactly two chosen parents, so the ancestry is
 * not a branching tree but a chain of couples — generation 1's pair produced
 * generation 2, whose pair produced generation 3, and so on. Drawing it as a
 * left-to-right strip says that honestly and reads at a glance; drawing it as a
 * conventional tree would imply branching that cannot happen.
 *
 * This is also where the payoff of the whole design becomes visible. Watching
 * the strip, you can see a body plan appear a few generations back and
 * gradually take over — which is the thing the game is actually about.
 */

import { encodeGenome } from '../genome/codec.ts';
import type { Genome } from '../genome/types.ts';
import { renderThumbnail } from '../render/thumbnail.ts';

export interface Ancestry {
  /** The generation these two were chosen *from*. */
  generation: number;
  parents: [Genome, Genome];
}

export class Lineage {
  private readonly steps: Ancestry[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly onPick: (genome: Genome) => void,
  ) {}

  get length(): number {
    return this.steps.length;
  }

  /** Record the pair that was just chosen to produce the next generation. */
  record(generation: number, a: Genome, b: Genome): void {
    this.steps.push({ generation, parents: [a, b] });
    this.render();
  }

  reset(): void {
    this.steps.length = 0;
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();

    if (this.steps.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lineage-empty';
      empty.textContent =
        'No ancestors yet. Pick two creatures and breed them, and their line will appear here.';
      this.root.appendChild(empty);
      return;
    }

    for (const [index, step] of this.steps.entries()) {
      if (index > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'lineage-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '→';
        this.root.appendChild(arrow);
      }
      this.root.appendChild(this.buildStep(step));
    }

    // The newest generation is the interesting end, so keep it in view.
    this.root.scrollLeft = this.root.scrollWidth;
  }

  private buildStep(step: Ancestry): HTMLElement {
    const group = document.createElement('div');
    group.className = 'lineage-step';

    const caption = document.createElement('div');
    caption.className = 'lineage-gen';
    caption.textContent = `gen ${step.generation}`;
    group.appendChild(caption);

    const pair = document.createElement('div');
    pair.className = 'lineage-pair';

    for (const [side, genome] of step.parents.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lineage-thumb';
      button.title = `Parent ${side === 0 ? 'A' : 'B'} of generation ${step.generation + 1} — click to copy its link`;

      const img = document.createElement('img');
      img.width = 64;
      img.height = 48;
      img.alt = `parent ${side === 0 ? 'A' : 'B'} of generation ${step.generation + 1}`;
      img.src = renderThumbnail(genome);
      button.appendChild(img);

      button.addEventListener('click', () => this.onPick(genome));
      pair.appendChild(button);
    }

    group.appendChild(pair);
    return group;
  }

  /** Every ancestor pair, for saving the whole run into a URL. */
  toCodes(): string[] {
    return this.steps.flatMap((s) => s.parents.map(encodeGenome));
  }
}
