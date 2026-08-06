/**
 * Launching Chromium for the check tools.
 *
 * The development container ships a browser at a fixed path and blocks
 * downloading another; GitHub Actions installs one wherever Playwright likes.
 * Hard-coding either breaks the other, so this prefers an explicit override,
 * falls back to the container's pinned build if it is actually there, and
 * otherwise lets Playwright find its own.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return existsSync(PINNED) ? PINNED : undefined;
}

/** A Chromium with software rendering, since none of these machines has a GPU. */
export function launchBrowser() {
  const executablePath = chromiumPath();
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
}
