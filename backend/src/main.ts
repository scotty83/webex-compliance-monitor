/**
 * Process entrypoint — thin wrapper around the composition root.
 * Starts the loopback bot-page server and hands the composition a browser
 * runtime (Puppeteer). This is the ONLY file that imports puppeteer.
 */
import { buildApp } from './composition.js';
import { startBotPageServer } from './media/botPageServer.js';
import { loadConfig } from './config.js';
import puppeteer from 'puppeteer';

const cfg = loadConfig();

async function boot(): Promise<void> {
  // Loopback-only static server for the bot page assets (bound to 127.0.0.1).
  const pageServer = await startBotPageServer({ assetDir: cfg.botPage.assetDir });
  const app = buildApp({
    botRuntime: {
      botPageBaseUrl: pageServer.baseUrl,
      // The cast bridges Puppeteer's Browser to the structural BrowserLike the
      // webexBotProcess consumes (it only uses newPage/close/on).
      launchBrowser: () =>
        puppeteer.launch({
          headless: true,
          ...(cfg.botPage.chromiumPath ? { executablePath: cfg.botPage.chromiumPath } : {}),
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
        }) as unknown as ReturnType<
          NonNullable<Parameters<typeof buildApp>[0]['botRuntime']>['launchBrowser']
        >,
    },
  });
  await app.start(cfg.port);
  console.log(`compliance-monitor backend on :${cfg.port}`);

  // I2: one stop() regardless of how many signals arrive; the page server is
  // torn down alongside the app, and exit always fires via .finally().
  let stopping: Promise<void> | undefined;
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      stopping ??= (async () => {
        await app.stop();
        await pageServer.close();
      })();
      stopping.finally(() => process.exit(0));
    });
}

boot().catch((err) => {
  console.error('[main] boot failed', err);
  process.exit(1);
});
