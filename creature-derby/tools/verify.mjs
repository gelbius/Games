/**
 * Headless smoke test. Serves the production build, loads it in Chromium,
 * waits, screenshots, and reports anything the page logged to the console.
 *
 * Usage: node tools/verify.mjs [waitMs] [outfile]
 *
 * This exists so changes can be checked without a human watching a browser.
 * It is a development tool, not part of the shipped game.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const WAIT = Number(process.argv[2] ?? 4000);
const OUT = process.argv[3] ?? '/tmp/claude-0/-home-user-Games/3c657fef-58b7-5fb7-94bc-690d96a1afeb/scratchpad/shot.png';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(ROOT, rel === '/' ? 'index.html' : rel);
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// Use the browser preinstalled in this environment rather than downloading one.
// Software GL (swiftshader) because there is no GPU here.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(WAIT);

const hud = await page.textContent('#hud-status').catch(() => '(no hud)');
await page.screenshot({ path: OUT });

console.log('HUD:', hud);
if (logs.length) console.log('CONSOLE:\n' + logs.join('\n'));
else console.log('CONSOLE: (silent)');

await browser.close();
server.close();
