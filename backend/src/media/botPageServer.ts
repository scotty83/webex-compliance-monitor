import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface BotPageServer { baseUrl: string; close(): Promise<void>; }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Loopback-only static server for the bot page assets. Bound to 127.0.0.1 so
 *  the page (and vendored SDK) are never reachable from the public origin. */
export function startBotPageServer(deps: { assetDir: string; host?: string }): Promise<BotPageServer> {
  const host = deps.host ?? '127.0.0.1';
  const server: Server = createServer((req, res) => {
    // basename() collapses any ../ traversal to a bare filename in assetDir.
    const name = basename(new URL(req.url ?? '/', 'http://x').pathname);
    if (!name || !(Object.keys(TYPES).some((ext) => name.endsWith(ext)))) {
      res.writeHead(404).end();
      return;
    }
    readFile(join(deps.assetDir, name))
      .then((buf) => {
        const ext = name.slice(name.lastIndexOf('.'));
        res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(buf);
      })
      .catch(() => res.writeHead(404).end());
  });

  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://${host}:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
