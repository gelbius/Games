/**
 * Checkpoint 6: eight creatures race for fifteen seconds.
 *
 * Eight independent worlds drawn into one canvas, with a clickable overlay
 * sitting exactly on top of the rendered panels.
 */

import { Vector2 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

import { randomPopulation } from './genome/random.ts';
import { randomSeed } from './rng.ts';
import { createRenderer } from './render/scene.ts';
import { LANE_COUNT, Race } from './race/race.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const gridEl = document.querySelector<HTMLDivElement>('#grid')!;
const bootEl = document.querySelector<HTMLDivElement>('#boot')!;
const clockEl = document.querySelector<HTMLElement>('#clock b')!;
const generationEl = document.querySelector<HTMLElement>('#generation b')!;
const timerFill = document.querySelector<HTMLDivElement>('#timerfill')!;
const hintEl = document.querySelector<HTMLDivElement>('#hint')!;
const replayBtn = document.querySelector<HTMLButtonElement>('#replay')!;

interface PanelRefs {
  root: HTMLButtonElement;
  distance: HTMLElement;
}

/** Build the eight overlay panels once; only their text changes afterwards. */
function buildPanels(): PanelRefs[] {
  const panels: PanelRefs[] = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    const root = document.createElement('button');
    root.className = 'panel';
    root.dataset.lane = String(i);
    root.innerHTML =
      `<span class="panel-label"><span class="panel-num">${i + 1}</span>` +
      `<span class="panel-dist">0.00m</span></span>` +
      `<span class="panel-tag">parent</span>`;
    gridEl.appendChild(root);
    panels.push({ root, distance: root.querySelector('.panel-dist')! });
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

  function startRace(genomes = randomPopulation(seed, LANE_COUNT)): void {
    race.dispose();
    race = new Race(genomes);
    hintEl.textContent = 'the race is running';
    timerFill.style.opacity = '1';
  }

  replayBtn.addEventListener('click', () => {
    // Same creatures, same result: the point of a seeded, fixed-step simulation.
    startRace(randomPopulation(seed, LANE_COUNT));
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyN') {
      seed = randomSeed();
      generation = 1;
      generationEl.textContent = String(generation);
      startRace();
    }
  });

  const bufferSize = new Vector2();
  let last = performance.now();
  let announced = false;

  function frame(now: number): void {
    requestAnimationFrame(frame);

    const elapsed = (now - last) / 1000;
    last = now;

    // Match the drawing buffer to the element, in device pixels.
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
      const [winner] = race.standings();
      hintEl.textContent = winner
        ? `finished — furthest was #${winner.lane + 1} at ${winner.distance.toFixed(2)}m`
        : 'finished';
      timerFill.style.opacity = '0.35';
    } else if (!race.finished) {
      announced = false;
    }
  }

  requestAnimationFrame(frame);

  (window as unknown as Record<string, unknown>).derby = {
    get race(): Race {
      return race;
    },
    startRace,
  };
}

main().catch((err: unknown) => {
  bootEl.classList.remove('gone');
  bootEl.textContent = `failed: ${String(err)}`;
  console.error(err);
});
