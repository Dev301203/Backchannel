/**
 * Backchannel extension bundler.
 *
 * The MV3 sources use ES module imports (content.js -> normalize.js -> tldts,
 * background.js -> auth.js). Content scripts run as classic scripts, so we
 * bundle each entry into a single self-contained file in dist/:
 *
 *   background.js  -> dist/background.js   (esm; MV3 module service worker)
 *   content.js     -> dist/content.js      (iife; classic content script)
 *
 * We also copy the manifest + static assets and rasterize the icon into the
 * three sizes the manifest declares.
 *
 * Usage:  npm run build   |   npm run watch
 */
import { context, build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const OUT = 'dist';

// Default to the local dev server so plain `npm run build` produces a bundle
// that talks to docker-compose / `npm run dev` out of the box. For a hosted
// build, override with e.g. `BC_API_URL=https://api.backchannel.app npm run build`.
const API_URL = process.env.BC_API_URL ?? 'http://localhost:8080';

const common = {
  bundle: true,
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  // Injected into config.js at build time. Override with BC_API_URL=... npm run build
  define: { BC_API_URL: JSON.stringify(API_URL) },
};

async function rasterizeIcons() {
  await mkdir(`${OUT}/icons`, { recursive: true });
  const src = 'icons/source.png';
  if (!existsSync(src)) {
    console.warn('icons/source.png missing; skipping icon rasterization');
    return;
  }
  // sharp is optional — if it fails to load, fall back to copying the source
  // into each slot (Chrome will scale it).
  try {
    const sharp = (await import('sharp')).default;
    for (const size of [16, 48, 128]) {
      await sharp(src).resize(size, size, { fit: 'cover' }).png().toFile(`${OUT}/icons/${size}.png`);
    }
  } catch (err) {
    console.warn('sharp unavailable, copying source icon as-is:', err?.message ?? err);
    for (const size of [16, 48, 128]) await cp(src, `${OUT}/icons/${size}.png`);
  }
}

async function copyStatic() {
  await cp('manifest.json', `${OUT}/manifest.json`);
  await cp('popup.html', `${OUT}/popup.html`);
  if (existsSync('sidebar.css')) await cp('sidebar.css', `${OUT}/sidebar.css`);
  if (existsSync('LICENSE')) await cp('LICENSE', `${OUT}/LICENSE`);
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const configs = [
    { ...common, entryPoints: ['background.js'], outfile: `${OUT}/background.js`, format: 'esm' },
    { ...common, entryPoints: ['content.js'], outfile: `${OUT}/content.js`, format: 'iife' },
    // Pop-out window entry — same UI as the docked sidebar, loaded from
    // popup.html via chrome.windows.create in the service worker.
    { ...common, entryPoints: ['popup.js'], outfile: `${OUT}/popup.js`, format: 'iife' },
  ];

  await copyStatic();
  await rasterizeIcons();

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('watching for changes… (copy manifest/icons is one-shot; rerun for asset changes)');
  } else {
    await Promise.all(configs.map((c) => build(c)));
    console.log(`built extension into ./${OUT}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
