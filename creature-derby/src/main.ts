/**
 * Checkpoint 7: pick the two creatures you like.
 *
 * The player is the fitness function. Nothing in this project scores a
 * creature; the two that get picked are the two that breed, and that is the
 * only selection pressure there is.
 *
 * Breeding itself lands in the next checkpoint — for now the button starts a
 * fresh unrelated generation, so the selection flow can be exercised end to
 * end.
 */

import { Vector2 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { randomPopulation } from './genome/random.ts';
import { randomSeed } from './rng.ts';
import { createRenderer } from './render/scene.ts';
import { LANE_COUNT, Race } from './race/race.ts';
import { PARENTS_NEEDED, Selection, type PanelRefs } from './ui/selection.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const gridEl = document.querySelector<HTMLDivElement>('#grid')!;
const bootEl = document.querySelector<HTMLDivElement>('#boot')!;
const clockEl = document.querySelector<HTMLElement>('#clock b')!;
const generationEl = document.querySelector<HTMLElement>('#generation b')!;
const timerFill = document.querySelector<HTMLDivElement>('#timerfill')!;
const hintEl = document.querySelector<HTMLDivElement>('#hint')!;
const replayBtn = document.querySelector<HTMLButtonElement>('#replay')!;
const breedBtn = document.querySelector<HTMLButtonElement>('#breed')!;

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
    root.innerHTML =
      `<span class="panel-label"><span class="panel-num">${i + 1}</span>` +
      `<span class="panel-dist">0.00m</span></span>` +
      `<span class="panel-tag"></span>`;
    gridEl.appendChild(root);
    panels.push({
      root,
      distance: root.querySelector('.panel-dist')!,
      tag: root.querySelector('.panel-tag')!,
    });
  }
  return panels;
}

async function main(): Promise<void> {
  await RAPIER.init();
  bootEl.classList.add('gone');

  const { renderer } = createRenderer(canvas);
  const panels = buildPanels();

  let seed = randomSeed();
  let generation = 1;
  let race = new Race(randomPopulation(seed, LANE_COUNT));

  const selection = new Selection(panels, (picked) => {
    breedBtn.disabled = picked.length !== PARENTS_NEEDED;
    updateHint();
  });

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

  function startRace(genomes = randomPopulation(seed, LANE_COUNT)): void {
    race.dispose();
    race = new Race(genomes);
    selection.clear();
    timerFill.style.opacity = '1';
    breedBtn.disabled = true;
    updateHint();
  }

  replayBtn.addEventListener('click', () => {
    // Same creatures, same result: the point of a seeded, fixed-step simulation.
    startRace(race.lanes.map((lane) => lane.genome));
  });

  breedBtn.addEventListener('click', () => {
    if (!selection.complete) return;
    // Placeholder until the next checkpoint: a fresh unrelated generation.
    // Crossover and mutation replace this.
    generation += 1;
    generationEl.textContent = String(generation);
    seed = randomSeed();
    startRace();
  });

  const bufferSize = new Vector2();
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

    // Panels are laid out in drawing-buffer pixels, which on a retina display
    // are not the same as CSS pixels.
    renderer.getDrawingBufferSize(bufferSize);
    race.render(renderer, bufferSize.x, bufferSize.y);

    clockEl.textContent = `${race.seconds.toFixed(1)}s`;
    timerFill.style.width = `${race.progress * 100}%`;

    for (let i = 0; i < panels.length; i++) {
      const lane = race.lanes[i];
      if (lane) panels[i]!.distance.textContent = `${lane.distance.toFixed(2)}m`;
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
  updateHint();

  (window as unknown as Record<string, unknown>).derby = {
    get race(): Race {
      return race;
    },
    selection,
    startRace,
  };
}

main().catch((err: unknown) => {
  bootEl.classList.remove('gone');
  bootEl.textContent = `failed: ${String(err)}`;
  console.error(err);
});
