/**
 * Renders several seeds side by side into one image, so a change to the genome
 * generator can be judged on a population rather than on one lucky creature.
 *
 * Usage: node tools/contact-sheet.mjs "1,2,3,4,5,6" out.png [settleMs]
 *
 * Development tool, not part of the shipped game.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const SEEDS = (process.argv[2] ?? '1,2,3,4,5,6,7,8').split(',');
const OUT = process.argv[3] ?? 'sheet.png';
const SETTLE = Number(process.argv[4] ?? 2500);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

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

const cells = [];
const errors = [];
for (const seed of SEEDS) {
  const page = await browser.newPage({ viewport: { width: 480, height: 380 } });
  page.on('pageerror', (e) => errors.push(`seed ${seed}: ${e.message}`));
  await page.goto(`http://localhost:${port}/?seed=${seed}`, { waitUntil: 'load' });
  await page.waitForTimeout(SETTLE);
  cells.push((await page.screenshot()).toString('base64'));
  await page.close();
}

// Stitch the cells into one grid using a throwaway page.
const page = await browser.newPage({ viewport: { width: 480 * 4, height: 380 * Math.ceil(cells.length / 4) } });
await page.setContent(
  `<body style="margin:0;display:grid;grid-template-columns:repeat(4,480px);background:#000">` +
    cells.map((c) => `<img src="data:image/png;base64,${c}" width="480" height="380">`).join('') +
    `</body>`,
);
await page.screenshot({ path: OUT });

if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
console.log(`wrote ${OUT} (${cells.length} creatures)`);

await browser.close();
server.close();
