/**
 * Drives the selection UI in a real browser and checks it behaves.
 *
 * Clicking things is the part most easily broken by a stray CSS change — an
 * overlay that stops receiving pointer events looks perfectly fine in a
 * screenshot.
 *
 * Usage: node tools/ui-check.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForSelector('.panel');

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

const selectedCount = () => page.locator('.panel[data-selected="1"]').count();
const breedDisabled = () => page.locator('#breed').isDisabled();

check('eight panels exist', (await page.locator('.panel').count()) === 8);
check('breed starts disabled', await breedDisabled());

await page.locator('.panel').nth(2).click();
check('clicking a panel selects it', (await selectedCount()) === 1);
check('breed still disabled with one pick', await breedDisabled());

await page.locator('.panel').nth(5).click();
check('second pick selects', (await selectedCount()) === 2);
check('breed enabled at exactly two', !(await breedDisabled()));

await page.screenshot({ path: process.argv[3] ?? '/tmp/ui-selected.png' });

check(
  'the two picks are labelled A and B',
  (await page.locator('.panel[data-selected="1"] .panel-tag').allTextContents()).join('|') === 'parent A|parent B',
);

// A third click should swap out the oldest pick, not be ignored and not make three.
await page.locator('.panel').nth(7).click();
check('a third pick still leaves exactly two', (await selectedCount()) === 2);
// Picks were lanes 2 then 5; picking lane 7 should drop lane 2 and keep 5 and 7.
const afterThird = await page
  .locator('.panel[data-selected="1"]')
  .evaluateAll((els) => els.map((e) => e.dataset.lane).join(','));
check('the third pick replaced the oldest', afterThird === '5,7', `got ${afterThird}`);

// Clicking a selected panel again deselects it.
await page.locator('.panel').nth(5).click();
check('clicking a pick again deselects', (await selectedCount()) === 1);
check('breed disabled again', await breedDisabled());

// Keyboard selection.
await page.keyboard.press('1');
check('number keys select', (await selectedCount()) === 2);

// The mutation slider speaks plain words rather than numbers.
check('mutation slider starts at a readable label', (await page.locator('#ratelabel').textContent()) === 'tame');
await page.locator('#rate').fill('95');
check('mutation slider label follows the slider', (await page.locator('#ratelabel').textContent()) === 'feral');
await page.locator('#rate').fill('35');

// Genomes before breeding, so we can prove the next generation descends from
// the two that were picked.
const before = await page.evaluate(() => window.derby.race.lanes.map((l) => JSON.stringify(l.genome)));
// Read the order the picks were actually made in. DOM order is not pick order:
// swapping out an earlier pick leaves parent A further down the grid than
// parent B, and breed() carries them through in pick order.
const pickedLanes = await page.evaluate(() => [...window.derby.selection.chosen]);

// Breeding resets the picks and bumps the generation.
await page.locator('#breed').click();
await page.waitForTimeout(400);
check('breeding clears the picks', (await selectedCount()) === 0);
check('generation advanced', (await page.locator('#generation b').textContent()) === '2');

const after = await page.evaluate(() => window.derby.race.lanes.map((l) => JSON.stringify(l.genome)));
check('the new generation is eight creatures', after.length === 8);
check(
  'both chosen parents carried through untouched',
  after[0] === before[pickedLanes[0]] && after[1] === before[pickedLanes[1]],
  `parents were lanes ${pickedLanes.join(' and ')}`,
);
check('the six offspring are not just copies of the parents', new Set(after).size >= 6, `${new Set(after).size} distinct`);
check('the two carried-over parents are marked', (await page.locator('.panel[data-parent="1"]').count()) === 2);
check(
  'the carried-over badge does not claim anything about speed',
  (await page.locator('.panel[data-parent="1"] .panel-tag').first().textContent()) === 'your pick',
);

// Live placings: exactly one 1st and one 2nd, once the race is under way.
await page.waitForFunction('window.derby.race.lanes.some((l) => l.distance > 0.1)', null, { timeout: 20000 });
const places = await page
  .locator('.panel-place')
  .evaluateAll((els) => els.map((e) => e.textContent).filter(Boolean));
check('exactly one leader and one runner-up', places.filter((p) => p === '1st').length === 1 &&
  places.filter((p) => p === '2nd').length === 1, `got ${JSON.stringify(places)}`);
check(
  'the leader really is the furthest',
  await page.evaluate(() => {
    const panels = [...document.querySelectorAll('.panel')];
    const leader = panels.findIndex((p) => p.querySelector('.panel-place')?.textContent === '1st');
    const distances = window.derby.race.lanes.map((l) => l.distance);
    const furthest = distances.indexOf(Math.max(...distances));
    // Hysteresis allows the badge to lag a close pass, but not by much.
    return Math.abs(distances[leader] - distances[furthest]) < 0.05;
  }),
);

// A second generation, to prove the loop actually loops.
await page.locator('.panel').nth(0).click();
await page.locator('.panel').nth(3).click();
await page.locator('#breed').click();
await page.waitForTimeout(400);
check('a third generation breeds too', (await page.locator('#generation b').textContent()) === '3');

// The lineage strip should now hold both breedings.
await page.locator('#lineagetoggle').click();
await page.waitForTimeout(250);
check('lineage panel opens', !(await page.locator('#lineagebar').getAttribute('hidden').then((v) => v !== null)));
check('lineage records both generations', (await page.locator('.lineage-step').count()) === 2);
check('each generation shows two parents', (await page.locator('.lineage-thumb').count()) === 4);

const thumbSrc = await page.locator('.lineage-thumb img').first().getAttribute('src');
check('thumbnails actually rendered', (thumbSrc ?? '').startsWith('data:image/png;base64,') && thumbSrc.length > 500,
  `${(thumbSrc ?? '').length} chars`);

await page.screenshot({ path: process.argv[4] ?? '/tmp/ui-lineage.png' });

// ---------------------------------------------------------------- sharing
// The whole point of the URL codec: a creature survives a trip through a link.
await page.locator('.panel').nth(4).click();
const link = await page.evaluate(() => {
  const g = window.derby.race.lanes[window.derby.selection.chosen[0]].genome;
  return `${location.origin}${location.pathname}#c=${window.__encode(g)}`;
});
const sharedGenome = await page.evaluate(() =>
  JSON.stringify(window.derby.race.lanes[window.derby.selection.chosen[0]].genome),
);

const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(e.message));
await page2.goto(link, { waitUntil: 'load' });
await page2.waitForFunction('window.derby && window.derby.race.lanes.length === 8');
const arrived = await page2.evaluate(() => JSON.stringify(window.derby.race.lanes[0].genome));
check('a shared link reproduces the exact creature', arrived === sharedGenome);
check('a shared link opens a full generation', (await page2.locator('.panel').count()) === 8);
check(
  'the address bar is cleaned up after loading',
  await page2.evaluate(() => location.hash === ''),
);
check('shared link page has no errors', errors2.length === 0, errors2[0] ?? '');
// Close it: every open page keeps eight WebGL scenes rendering, and leaving
// them running starves whatever runs next of frames.
await page2.close();

// A mangled link must not stop the game loading.
const page3 = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors3 = [];
page3.on('pageerror', (e) => errors3.push(e.message));
await page3.goto(`${link.split('#')[0]}#c=thisIsNotAGenome`, { waitUntil: 'load' });
await page3.waitForFunction('window.derby && window.derby.race.lanes.length === 8');
check('a broken link still starts the game', (await page3.locator('.panel').count()) === 8);
check('a broken link says so', ((await page3.locator('#hint').textContent()) ?? '').includes('readable'));
check('broken link page has no errors', errors3.length === 0, errors3[0] ?? '');
await page3.close();

// An empty lineage should explain itself rather than be a blank strip.
const page4 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page4.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page4.waitForSelector('.panel');
await page4.locator('#lineagetoggle').click();
const emptyText = (await page4.locator('.lineage-empty').textContent()) ?? '';
check('an empty lineage explains itself', emptyText.includes('Pick two'), `got "${emptyText.slice(0, 40)}"`);
check('the empty message is actually visible', await page4.locator('.lineage-empty').isVisible());
await page4.close();

// ------------------------------------------------- retina / pixel ratio
// This exists because a real bug shipped past every other check in this file.
// three.js scales viewport and scissor rectangles by the renderer's pixel ratio
// itself, so handing it device pixels doubles them a second time: the panels
// are drawn at twice their size and six of the eight fall off the canvas. At
// deviceScaleFactor 1 the two units are identical and the bug is invisible,
// which is exactly why it survived. The layout is now asserted at 2x and 3x
// too.
for (const scale of [1, 2, 3]) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: scale });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await p.waitForFunction('window.derby && window.derby.race.viewports.length === 8');

  const { rects, cssWidth, cssHeight } = await p.evaluate(() => {
    const canvas = document.querySelector('#stage');
    return {
      rects: window.derby.race.viewports.map((v) => ({ ...v })),
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
    };
  });

  check(`eight panel rectangles at ${scale}x`, rects.length === 8, `got ${rects.length}`);

  // Every rectangle must fit inside the canvas. Under the bug they run to twice
  // the canvas width and height.
  const escaped = rects.filter(
    (r) => r.x < 0 || r.y < 0 || r.x + r.width > cssWidth + 1 || r.y + r.height > cssHeight + 1,
  );
  check(
    `no panel falls off the canvas at ${scale}x`,
    escaped.length === 0,
    escaped.length ? `${escaped.length} of 8 outside ${cssWidth}x${cssHeight}` : '',
  );

  // And together they must cover it: eight panels each a quarter wide and half
  // high tile the canvas exactly.
  const covered = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  const ratio = covered / (cssWidth * cssHeight);
  check(`the panels tile the canvas at ${scale}x`, ratio > 0.98 && ratio < 1.02, `covered ${(ratio * 100).toFixed(1)}%`);

  // No two panels may sit on top of each other.
  const corners = new Set(rects.map((r) => `${r.x},${r.y}`));
  check(`the eight panels are in eight places at ${scale}x`, corners.size === 8, `${corners.size} distinct origins`);

  check(`no errors at ${scale}x`, errs.length === 0, errs[0] ?? '');
  if (scale === 2) await p.screenshot({ path: process.argv[5] ?? '/tmp/ui-retina.png' });
  await p.close();
}

// --------------------------------------------------------- phone layout
// The badges used to sit in opposite top corners. That is fine on a desktop
// panel and collides on a phone, where a panel is barely a finger wide — which
// is exactly how it was reported. Overlap is now asserted at phone sizes, with
// every badge on screen at once.
check('no page errors', errors.length === 0, errors[0] ?? '');
await page.screenshot({ path: process.argv[2] ?? '/tmp/ui-check.png' });
await page.close();

for (const [w, h, name] of [[390, 844, 'iPhone'], [360, 800, 'Android'], [1280, 800, 'desktop']]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  await p.waitForFunction('window.derby && window.derby.race.lanes.length === 8');

  // Force every badge visible at once: breed so two are marked "your pick",
  // then wait for the placings to appear.
  await p.evaluate(() => window.derby.selection.setInherited([0, 1]));
  await p.waitForFunction('window.derby.race.lanes.some((l) => l.distance > 0.1)', null, { timeout: 25000 });
  await p.waitForTimeout(500);

  const overlaps = await p.evaluate(() => {
    const hit = (a, b) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const problems = [];
    for (const panel of document.querySelectorAll('.panel')) {
      const parts = ['.panel-label', '.panel-tag', '.panel-place']
        .map((sel) => ({ sel, el: panel.querySelector(sel) }))
        .filter((x) => x.el && x.el.offsetParent !== null)
        .map((x) => ({ sel: x.sel, box: x.el.getBoundingClientRect() }));

      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          if (hit(parts[i].box, parts[j].box)) problems.push(`${parts[i].sel} over ${parts[j].sel}`);
        }
      }
      // Nothing may spill outside its own panel either.
      const bounds = panel.getBoundingClientRect();
      for (const part of parts) {
        if (part.box.left < bounds.left - 0.5 || part.box.right > bounds.right + 0.5) {
          problems.push(`${part.sel} wider than its panel`);
        }
      }
    }
    return problems;
  });

  check(`badges do not overlap at ${name} (${w}x${h})`, overlaps.length === 0, overlaps[0] ?? '');
  check(`no errors at ${name}`, errs.length === 0, errs[0] ?? '');
  if (name === 'iPhone') await p.screenshot({ path: process.argv[6] ?? '/tmp/ui-phone.png' });
  await p.close();
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
