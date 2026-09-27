import { randomBytes } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLidarr {
  url: string;
  apiKey: string;
  /** Every request path the fake received, for asserting what was called. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * A minimal stand-in for Lidarr's API on a random local port. `urlBase`
 * mimics Lidarr's URL Base setting; `mode` simulates misbehaving servers.
 */
export async function startFakeLidarr(
  options: { urlBase?: string; mode?: 'ok' | 'hang' | 'html' | 'sonarr' } = {},
): Promise<FakeLidarr> {
  const { urlBase = '', mode = 'ok' } = options;
  const apiKey = randomBytes(16).toString('hex');
  const requests: string[] = [];

  const routes: Record<string, unknown> = {
    'system/status': { appName: mode === 'sonarr' ? 'Sonarr' : 'Lidarr', version: '3.1.0.4875' },
    qualityprofile: [
      { id: 2, name: 'Lossless' },
      { id: 1, name: 'Any' },
    ],
    metadataprofile: [{ id: 1, name: 'Standard' }],
    rootfolder: [
      { id: 1, path: '/music', freeSpace: 1_000_000, defaultQualityProfileId: 2, defaultMetadataProfileId: 1 },
    ],
  };

  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (mode === 'hang') return; // never answer
    if (mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Some app</title>');
      return;
    }
    const prefix = `${urlBase}/api/v1/`;
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-api-key'] !== apiKey) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
      return;
    }
    const body = routes[path.slice(prefix.length)];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${urlBase}`,
    apiKey,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
