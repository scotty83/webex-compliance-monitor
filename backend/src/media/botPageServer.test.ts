import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startBotPageServer, type BotPageServer } from './botPageServer.js';

let server: BotPageServer | undefined;
let dir: string | undefined;
afterEach(async () => { await server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function fixtureDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'wcms-botpage-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>');
  writeFileSync(join(dir, 'bot.js'), 'export const x = 1;');
  return dir;
}

/** Builds a parent temp dir containing the served `assets/` subdir plus, one level
 *  ABOVE assetDir, a planted `outside.js` carrying a unique sentinel. Used to prove
 *  a raw (client-unnormalized) `..` request can never read that file's contents. */
function fixtureDirWithOutsideFile(): { assetDir: string } {
  const parentDir = mkdtempSync(join(tmpdir(), 'wcms-botpage-parent-'));
  dir = parentDir; // afterEach removes parentDir recursively (covers assetDir + outside.js)
  const assetDir = join(parentDir, 'assets');
  mkdirSync(assetDir);
  writeFileSync(join(assetDir, 'index.html'), '<!doctype html><html></html>');
  writeFileSync(join(assetDir, 'bot.js'), 'export const x = 1;');
  writeFileSync(join(parentDir, 'outside.js'), '// TRAVERSAL-LEAK-SENTINEL');
  return { assetDir };
}

/** Sends a raw request path with NO client-side URL normalization — unlike fetch(),
 *  whose WHATWG URL parser collapses `..` segments before the request is even sent,
 *  node:http's `path` option is written to the wire verbatim. This is what actually
 *  exercises the server's own `basename()` traversal defense. */
function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: hostname, port: Number(port), path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startBotPageServer', () => {
  it('binds loopback and serves index.html', async () => {
    server = await startBotPageServer({ assetDir: fixtureDir() });
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${server.baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('serves bot.js with a JS content type', async () => {
    server = await startBotPageServer({ assetDir: fixtureDir() });
    const res = await fetch(`${server.baseUrl}/bot.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it('404s unknown files', async () => {
    server = await startBotPageServer({ assetDir: fixtureDir() });
    expect((await fetch(`${server.baseUrl}/nope.js`)).status).toBe(404);
  });

  it('rejects a raw, un-normalized-by-client path-traversal request and never leaks the outside file', async () => {
    const { assetDir } = fixtureDirWithOutsideFile();
    server = await startBotPageServer({ assetDir });
    // Ends in a served extension (.js) so it clears the extension gate — this isolates
    // the traversal defense itself, rather than the unknown-extension 404 above.
    const res = await rawGet(server.baseUrl, '/../outside.js');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('TRAVERSAL-LEAK-SENTINEL');
  });
});
