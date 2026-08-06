/**
 * Offline light-probe bake.
 *
 * Spins up the Vite dev server, drives the /bake.html page in real *system* Chrome
 * (Spark renders Gaussian splats through WebGL2 — headless Chromium / SwiftShader
 * render them faithlessly, so we must use a real GPU, headed, exactly like
 * lively-crossing's screenshot script), captures the SH probe grid the page bakes,
 * and writes it to public/light-probes.json.
 *
 * One-time: run it, commit the JSON, the app loads it at runtime. Re-run whenever
 * the ship splat or the PROBE_* grid config (src/scene.ts) changes.
 *
 * Requires Google Chrome installed (playwright-core channel 'chrome').
 *
 * Usage: pnpm bake:probes
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const OUT = 'public/light-probes.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ server: { host: '127.0.0.1' } });
await server.listen();
const localBase = server.resolvedUrls?.local?.[0];
if (!localBase) {
    console.error('vite: could not resolve a local server URL');
    await server.close();
    process.exit(1);
}
const bakeUrl = new URL('bake.html', localBase).href;
console.log(`vite serving ${localBase}\ndriving ${bakeUrl} in system Chrome…`);

const browser = await chromium.launch({
    channel: 'chrome', // real Google Chrome, not bundled Chromium
    headless: false, // real GPU/WebGL2 for Spark
    args: [
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--force-gpu-mem-available-mb=8192',
        '--disable-gpu-process-crash-limit',
    ],
});

let done = false;
let error = null;

try {
    const page = await browser.newPage({ viewport: { width: 720, height: 720 } });
    page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()));
    page.on('pageerror', (e) => console.log('[page:error]', e.message));
    page.on('crash', () => {
        error = 'render process crashed';
        done = true;
    });

    // The bake page calls these when it's finished / failed.
    await page.exposeFunction('__saveProbes', async (json) => {
        await writeFile(OUT, json);
        console.log(`wrote ${OUT} (${json.length.toLocaleString()} bytes)`);
        done = true;
    });
    // Diagnostic: the raw six-face env capture strip, so we can eyeball what Spark
    // actually captured (vs what the SH/helpers show).
    await page.exposeFunction('__saveDebugPng', async (dataUrl) => {
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        await writeFile('env-capture.png', Buffer.from(b64, 'base64'));
        console.log('wrote env-capture.png (raw six-face env capture)');
    });
    await page.exposeFunction('__bakeError', (msg) => {
        error = msg;
        done = true;
    });

    await page.goto(bakeUrl, { waitUntil: 'load' });

    // No timeout: a dense volume grid is thousands of captures and can run for a long
    // time. Just wait for the page to signal done (or error). Ctrl-C to abort.
    while (!done) await sleep(500);
} finally {
    await browser.close();
    await server.close();
}

if (error) {
    console.error('bake failed:', error);
    process.exit(1);
}
console.log('bake complete ✓');
