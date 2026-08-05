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
check('the two survivors are marked', (await page.locator('.panel[data-parent="1"]').count()) === 2);

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

// A mangled link must not stop the game loading.
const page3 = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors3 = [];
page3.on('pageerror', (e) => errors3.push(e.message));
await page3.goto(`${link.split('#')[0]}#c=thisIsNotAGenome`, { waitUntil: 'load' });
await page3.waitForFunction('window.derby && window.derby.race.lanes.length === 8');
check('a broken link still starts the game', (await page3.locator('.panel').count()) === 8);
check('a broken link says so', ((await page3.locator('#hint').textContent()) ?? '').includes('readable'));
check('broken link page has no errors', errors3.length === 0, errors3[0] ?? '');

// An empty lineage should explain itself rather than be a blank strip.
const page4 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page4.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page4.waitForSelector('.panel');
await page4.locator('#lineagetoggle').click();
const emptyText = (await page4.locator('.lineage-empty').textContent()) ?? '';
check('an empty lineage explains itself', emptyText.includes('Pick two'), `got "${emptyText.slice(0, 40)}"`);
check('the empty message is actually visible', await page4.locator('.lineage-empty').isVisible());

check('no page errors', errors.length === 0, errors[0] ?? '');

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);

await page.screenshot({ path: process.argv[2] ?? '/tmp/ui-check.png' });
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
