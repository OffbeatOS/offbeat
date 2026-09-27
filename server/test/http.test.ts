import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ResponseTooLarge, fetchBuffered } from '../src/integrations/http.js';
import { LidarrClient, LidarrError } from '../src/integrations/lidarr/client.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A server whose handler decides what to send, and when to stop. */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends headers and half a JSON body, then goes quiet. */
const stallsMidBody: Parameters<typeof createServer>[1] = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{"records": [');
};

describe('fetchBuffered', () => {
  it('returns the whole body, buffered', async () => {
    const url = await serve((_req, res) => res.end('{"ok":true}'));
    const response = await fetchBuffered(url, { timeoutMs: 1000 });
    expect(await response.json()).toEqual({ ok: true });
  });

  it('times out when the body stalls after the headers', async () => {
    const url = await serve(stallsMidBody);
    const started = Date.now();
    await expect(fetchBuffered(url, { timeoutMs: 300 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses bodies over the limit, declared or not', async () => {
    const declared = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Length': '100' });
      res.end('x'.repeat(100));
    });
    await expect(fetchBuffered(declared, { timeoutMs: 1000, maxBytes: 10 })).rejects.toBeInstanceOf(ResponseTooLarge);

    const chunked = await serve((_req, res) => {
      res.write('x'.repeat(50));
      res.end('x'.repeat(50));
    });
    await expect(fetchBuffered(chunked, { timeoutMs: 1000, maxBytes: 10 })).rejects.toBeInstanceOf(ResponseTooLarge);
  });
});

describe('Lidarr client', () => {
  it('gives up on a response that stalls mid-body, with a readable error', async () => {
    const url = await serve(stallsMidBody);
    const client = new LidarrClient({ url, apiKey: 'k', timeoutMs: 300 });
    const error = await client.queue().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LidarrError);
    expect((error as Error).message).toMatch(/did not respond/);
  });
});
