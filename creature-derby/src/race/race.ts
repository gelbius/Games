/**
 * Eight creatures, fifteen seconds, one canvas.
 *
 * All eight are drawn into a single WebGL canvas using the scissor test — one
 * renderer, eight viewports — rather than eight separate canvases. Eight
 * WebGL contexts would be slower, and browsers cap how many a page may have.
 */

import type * as THREE from 'three';
import { Lane } from './lane.ts';
import type { Genome } from '../genome/types.ts';
import { FIXED_DT, RACE_STEPS } from '../sim/constants.ts';

export const LANE_COUNT = 8;
export const GRID_COLUMNS = 4;
export const GRID_ROWS = 2;

export class Race {
  readonly lanes: Lane[];

  /** Physics steps taken so far. The race is over at RACE_STEPS. */
  private steps = 0;
  private accumulator = 0;

  /**
   * The rectangles the last render used, in the units render() was given.
   *
   * Kept because the panel layout is worth being able to inspect: getting these
   * wrong puts most of the grid off the canvas while every other part of the
   * app carries on working perfectly, so it is not a failure that announces
   * itself. tools/ui-check.mjs asserts these tile the canvas.
   */
  readonly viewports: { x: number; y: number; width: number; height: number }[] = [];

  constructor(genomes: readonly Genome[]) {
    this.lanes = genomes.slice(0, LANE_COUNT).map((g) => new Lane(g));
  }

  get finished(): boolean {
    return this.steps >= RACE_STEPS;
  }

  get seconds(): number {
    return this.steps * FIXED_DT;
  }

  get progress(): number {
    return Math.min(1, this.steps / RACE_STEPS);
  }

  /**
   * Advance by real elapsed time, spent in whole fixed steps.
   *
   * The accumulator is what keeps the simulation identical on every machine:
   * frames arrive irregularly, physics steps never do.
   */
  advance(elapsedSeconds: number): void {
    if (this.finished) return;

    // A long frame — a tab left in the background, a slow first load — must not
    // be repaid all at once, or the race lurches forward in a single jump.
    this.accumulator += Math.min(elapsedSeconds, 0.25);

    while (this.accumulator >= FIXED_DT && this.steps < RACE_STEPS) {
      const t = this.steps * FIXED_DT;
      for (const lane of this.lanes) lane.step(t);
      this.steps++;
      this.accumulator -= FIXED_DT;
    }

    if (this.finished) this.accumulator = 0;
  }

  /** Update meshes and cameras. Runs even after the race ends, so shots settle. */
  present(frameSeconds: number): void {
    for (const lane of this.lanes) lane.present(frameSeconds);
  }

  /**
   * Draw all eight panels into one canvas.
   *
   * `width` and `height` are CSS pixels, not drawing-buffer pixels. three.js
   * scales viewport and scissor rectangles by the renderer's pixel ratio
   * internally, so passing device pixels here would double them a second time
   * and throw most of the grid off the canvas on any retina display.
   */
  render(renderer: THREE.WebGLRenderer, width: number, height: number): void {
    const panelWidth = Math.floor(width / GRID_COLUMNS);
    const panelHeight = Math.floor(height / GRID_ROWS);

    renderer.setScissorTest(true);
    this.viewports.length = 0;

    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i]!;
      const column = i % GRID_COLUMNS;
      const row = Math.floor(i / GRID_COLUMNS);

      // WebGL's origin is bottom-left, the grid reads top-left, hence the flip.
      const x = column * panelWidth;
      const y = height - (row + 1) * panelHeight;

      renderer.setViewport(x, y, panelWidth, panelHeight);
      renderer.setScissor(x, y, panelWidth, panelHeight);
      this.viewports.push({ x, y, width: panelWidth, height: panelHeight });

      if (lane.camera.aspect !== panelWidth / panelHeight) {
        lane.camera.aspect = panelWidth / panelHeight;
        lane.camera.updateProjectionMatrix();
      }

      renderer.render(lane.scene, lane.camera);
    }

    renderer.setScissorTest(false);
  }

  /** Finishing order, furthest first. */
  standings(): { lane: number; distance: number; forward: number }[] {
    return this.lanes
      .map((lane, index) => ({ lane: index, distance: lane.distance, forward: lane.forward }))
      .sort((a, b) => b.distance - a.distance);
  }

  dispose(): void {
    for (const lane of this.lanes) lane.dispose();
    this.lanes.length = 0;
  }
}
