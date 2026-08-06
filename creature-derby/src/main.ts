/**
 * Creature Derby.
 *
 * Eight procedurally generated creatures race for fifteen seconds. You pick the
 * two you like. Those two breed, and their children race. Repeat.
 *
 * There is no fitness function anywhere in this project. Nothing scores a
 * creature or decides one is better than another — the player is the entire
 * selection pressure. That is what makes it a game rather than a demo, and it
 * is also why it runs comfortably in a browser: only ever eight creatures are
 * simulated, instead of the thousands an automatic search would need.
 *
 * After Karl Sims, "Evolving Virtual Creatures", SIGGRAPH 1994. See CREDITS.md.
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { randomPopulation } from './genome/random.ts';
import { breed, populationFrom } from './genome/breed.ts';
import type { Genome } from './genome/types.ts';
import { randomSeed } from './rng.ts';
import { createRenderer } from './render/scene.ts';
import { LANE_COUNT, Race } from './race/race.ts';
import { PARENTS_NEEDED, Selection, type PanelRefs } from './ui/selection.ts';
import { Lineage } from './ui/lineage.ts';
import { placeLabel, Ranking } from './ui/ranking.ts';
import { clearUrl, copyText, genomeFromUrl, linkTo } from './ui/share.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const gridEl = document.querySelector<HTMLDivElement>('#grid')!;
const bootEl = document.querySelector<HTMLDivElement>('#boot')!;
const clockEl = document.querySelector<HTMLElement>('#clock b')!;
const generationEl = document.querySelector<HTMLElement>('#generation b')!;
const timerFill = document.querySelector<HTMLDivElement>('#timerfill')!;
const hintEl = document.querySelector<HTMLDivElement>('#hint')!;
const replayBtn = document.querySelector<HTMLButtonElement>('#replay')!;
const breedBtn = document.querySelector<HTMLButtonElement>('#breed')!;
const shareBtn = document.querySelector<HTMLButtonElement>('#share')!;
const rateInput = document.querySelector<HTMLInputElement>('#rate')!;
const rateLabel = document.querySelector<HTMLOutputElement>('#ratelabel')!;
const lineageBar = document.querySelector<HTMLElement>('#lineagebar')!;
const lineageEl = document.querySelector<HTMLDivElement>('#lineage')!;
const lineageToggle = document.querySelector<HTMLButtonElement>('#lineagetoggle')!;

/** Plain words for the mutation slider. "0.35" means nothing to anybody. */
function describeRate(rate: number): string {
  if (rate <= 0.001) return 'clones';
  if (rate < 0.2) return 'subtle';
  if (rate < 0.45) return 'tame';
  if (rate < 0.7) return 'lively';
  if (rate < 0.9) return 'wild';
  return 'feral';
}

/** Build the eight overlay panels once; only their text changes afterwards. */
function buildPanels(): PanelRefs[] {
  const panels: PanelRefs[] = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    const root = document.createElement('button');
    root.className = 'panel';
    root.type = 'button';
    root.dataset.lane = String(i);
    root.setAttribute('aria-pressed', 'false');
    root.setAttribute('aria-label', `creature ${i + 1}`);
    // Corner readouts stack in a column so the "your pick" badge sits *below*
    // the distance rather than beside it. Side by side, the two collide on a
    // phone-width panel. The placing lives separately at the bottom of the
    // panel, well clear of both.
    root.innerHTML =
      `<span class="panel-hud">` +
      `<span class="panel-label"><span class="panel-num">${i + 1}</span>` +
      `<span class="panel-dist">0.00m</span></span>` +
      `<span class="panel-tag"></span>` +
      `</span>` +
      `<span class="panel-place"></span>`;
    gridEl.appendChild(root);
    panels.push({
      root,
      distance: root.querySelector('.panel-dist')!,
      tag: root.querySelector('.panel-tag')!,
      place: root.querySelector('.panel-place')!,
    });
  }
  return panels;
}

async function main(): Promise<void> {
  await RAPIER.init();
  bootEl.classList.add('gone');

  const { renderer } = createRenderer(canvas);
  const panels = buildPanels();
  const ranking = new Ranking();

  let seed = randomSeed();
  let generation = 1;
  let survivors: number[] = [];
  let openingMessage = '';

  // A shared link, if we arrived by one.
  const shared = genomeFromUrl();
  let opening: Genome[];
  if (shared && 'genome' in shared) {
    opening = populationFrom(shared.genome, 0.35, seed);
    openingMessage = 'opened a shared creature — it is number 1, with seven variations on it';
  } else {
    if (shared) openingMessage = "that link did not contain a readable creature, so here are eight new ones";
    opening = randomPopulation(seed, LANE_COUNT);
  }
  // The address bar is a starting point, not a running record of state; leaving
  // a stale creature in it would reload the wrong thing later.
  clearUrl();

  let race = new Race(opening);

  const selection = new Selection(panels, (picked) => {
    breedBtn.disabled = picked.length !== PARENTS_NEEDED;
    shareBtn.disabled = picked.length === 0;
    updateHint();
  });

  const lineage = new Lineage(lineageEl, (genome) => {
    void copyText(linkTo(genome)).then((ok) =>
      flash(ok ? 'link to that creature copied' : 'could not reach the clipboard'),
    );
  });

  let flashTimer = 0;
  /**
   * Show a message in place of the hint.
   *
   * `holdMs` of 0 means leave it there until something else changes the hint.
   * A "copied" toast should get out of the way; a "that link was broken"
   * message should not vanish while the page is still loading, which is exactly
   * when a slow machine would otherwise never show it at all.
   */
  function flash(message: string, holdMs = 2800): void {
    hintEl.textContent = message;
    clearTimeout(flashTimer);
    if (holdMs > 0) flashTimer = window.setTimeout(updateHint, holdMs);
  }

  function updateHint(): void {
    const picked = selection.chosen.length;
    if (!race.finished) {
      hintEl.textContent =
        picked > 0 ? `${picked} of ${PARENTS_NEEDED} picked — the race is still running` : 'the race is running';
      return;
    }
    if (picked === 0) hintEl.textContent = 'pick the two you like best';
    else if (picked < PARENTS_NEEDED) hintEl.textContent = `pick one more (${picked} of ${PARENTS_NEEDED})`;
    else hintEl.textContent = 'two picked — breed them, or click another to swap';
  }

  function mutationRate(): number {
    return Number(rateInput.value) / 100;
  }

  rateInput.addEventListener('input', () => {
    rateLabel.textContent = describeRate(mutationRate());
  });
  rateLabel.textContent = describeRate(mutationRate());

  lineageToggle.addEventListener('click', () => {
    const showing = lineageBar.hasAttribute('hidden');
    lineageBar.toggleAttribute('hidden', !showing);
    lineageToggle.setAttribute('aria-expanded', String(showing));
  });

  function startRace(genomes: readonly Genome[], inherited: number[] = []): void {
    race.dispose();
    race = new Race(genomes);
    selection.clear();
    survivors = inherited;
    selection.setInherited(survivors);
    timerFill.style.opacity = '1';
    breedBtn.disabled = true;
    shareBtn.disabled = true;
    ranking.reset();
    updateHint();
  }

  replayBtn.addEventListener('click', () => {
    // Same creatures, same result: the point of a seeded, fixed-step simulation.
    startRace(
      race.lanes.map((lane) => lane.genome),
      survivors,
    );
  });

  shareBtn.addEventListener('click', () => {
    const lane = race.lanes[selection.chosen[0] ?? -1];
    if (!lane) return;
    void copyText(linkTo(lane.genome)).then((ok) =>
      flash(ok ? 'link copied — anyone who opens it gets that creature' : 'could not reach the clipboard'),
    );
  });

  breedBtn.addEventListener('click', () => {
    const [a, b] = selection.chosen;
    const parentA = a === undefined ? undefined : race.lanes[a]?.genome;
    const parentB = b === undefined ? undefined : race.lanes[b]?.genome;
    if (!parentA || !parentB) return;

    lineage.record(generation, parentA, parentB);

    generation += 1;
    generationEl.textContent = String(generation);
    seed = randomSeed();

    // breed() puts the two untouched parents first, so lanes 1 and 2 are the
    // survivors and get marked as such.
    startRace(breed(parentA, parentB, mutationRate(), seed), [0, 1]);
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyN' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      generation = 1;
      generationEl.textContent = '1';
      seed = randomSeed();
      lineage.reset();
      startRace(randomPopulation(seed, LANE_COUNT));
      flash('started over with eight new creatures');
    } else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey) {
      replayBtn.click();
    } else if (e.code === 'Enter' && !breedBtn.disabled) {
      breedBtn.click();
    }
  });

  let last = performance.now();
  let announced = false;

  function frame(now: number): void {
    requestAnimationFrame(frame);

    const elapsed = (now - last) / 1000;
    last = now;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      renderer.setSize(width, height, false);
    }

    race.advance(elapsed);
    race.present(elapsed);

    // CSS pixels, deliberately, NOT drawing-buffer pixels. three.js multiplies
    // viewport and scissor rectangles by the pixel ratio itself, so passing
    // device pixels here doubles them again on any retina display: the panels
    // are drawn at twice their size and six of the eight fall off the canvas.
    race.render(renderer, width, height);

    clockEl.textContent = `${race.seconds.toFixed(1)}s`;
    timerFill.style.width = `${race.progress * 100}%`;

    ranking.update(race.lanes.map((lane) => lane.distance));
    for (let i = 0; i < panels.length; i++) {
      const lane = race.lanes[i];
      const panel = panels[i]!;
      if (!lane) continue;
      panel.distance.textContent = `${lane.distance.toFixed(2)}m`;

      const place = ranking.placeOf(i);
      const label = placeLabel(place);
      if (panel.place.textContent !== label) {
        panel.place.textContent = label;
        panel.place.dataset.place = place ? String(place) : '';
      }
    }

    if (race.finished && !announced) {
      announced = true;
      timerFill.style.opacity = '0.35';
      updateHint();
    } else if (!race.finished && announced) {
      announced = false;
    }
  }

  requestAnimationFrame(frame);
  // The opening message stays put: it explains why the screen looks the way
  // it does, and is worth more than a two-second glimpse.
  if (openingMessage) flash(openingMessage, 0);
  else updateHint();

  // A handle on the running game, for the tools in tools/ and for poking at
  // things from the browser console.
  (window as unknown as Record<string, unknown>).derby = {
    get race(): Race {
      return race;
    },
    selection,
    lineage,
    startRace,
  };
  // Used by tools/ui-check.mjs to build a share link without duplicating the
  // codec in the test.
  (window as unknown as Record<string, unknown>).__encode = (g: Genome) => linkTo(g).split('#c=')[1];
}

main().catch((err: unknown) => {
  bootEl.classList.remove('gone');
  bootEl.textContent = `Creature Derby could not start: ${String(err)}`;
  console.error(err);
});
