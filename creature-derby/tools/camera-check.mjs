/**
 * Checks that the broadcast camera actually keeps creatures in frame.
 *
 * A screenshot proves the shot was fine at one instant. The camera's whole job
 * is holding a subject that lurches and tumbles for fifteen seconds, so this
 * samples a full race and reports how often the creature — its whole extent,
 * not just its centre — was inside the frame, and how far outside it got at
 * worst.
 *
 * Usage: node tools/camera-check.mjs [runs] [raceSeconds]
 */
import { launchBrowser } from './browser.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const RUNS = Number(process.argv[2] ?? 3);
const SECONDS = Number(process.argv[3] ?? 15);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, rel === '/' ? 'index.html' : rel);
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await launchBrowser();

console.log(' run | creatures | in frame | worst overshoot | min height | notes');

let worstOverall = 0;
let totalIn = 0;
let totalSamples = 0;

for (let run = 1; run <= RUNS; run++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.derby && window.derby.race && window.derby.race.lanes.length === 8');

  const samples = [];
  const deadline = Date.now() + SECONDS * 1000;
  while (Date.now() < deadline) {
    const batch = await page.evaluate(() => {
      const race = window.derby.race;
      // Project the extremes of each creature's bounding sphere, not just its
      // centre: a creature can be centred and still have limbs off-screen.
      return race.lanes.map((lane) => {
        const subject = lane.focus;
        let worst = 0;
        for (const [dx, dy, dz] of [
          [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        ]) {
          const p = subject.centre.clone();
          p.x += dx * subject.radius;
          p.y += dy * subject.radius;
          p.z += dz * subject.radius;
          p.project(lane.camera);
          worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
        }
        return { worst, cameraY: lane.camera.position.y, t: race.seconds };
      });
    });
    samples.push(...batch);
    await page.waitForTimeout(70);
  }

  // Ignore the first moments: the camera is allowed to be settling on a cut.
  const settled = samples.filter((s) => s.t > 0.6);
  const inFrame = settled.filter((s) => s.worst <= 1).length;
  const worst = Math.max(...settled.map((s) => s.worst));
  const minHeight = Math.min(...settled.map((s) => s.cameraY));

  totalIn += inFrame;
  totalSamples += settled.length;
  worstOverall = Math.max(worstOverall, worst);

  console.log(
    String(run).padStart(4),
    '|',
    String(8).padStart(9),
    '|',
    `${((inFrame / settled.length) * 100).toFixed(0)}%`.padStart(8),
    '|',
    worst.toFixed(2).padStart(15),
    '|',
    minHeight.toFixed(2).padStart(10),
    '|',
    errors.length ? `ERRORS: ${errors[0]}` : '',
  );
  await page.close();
}

console.log(
  `\n${totalSamples} samples across ${RUNS * 8} creatures — in frame: ${((totalIn / totalSamples) * 100).toFixed(1)}%   worst overshoot: ${worstOverall.toFixed(2)}`,
);
console.log('(overshoot 1.00 = exactly at the edge of frame; under 1.00 is inside)');

await browser.close();
server.close();
