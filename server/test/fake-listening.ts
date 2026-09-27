import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The one API key the fake Last.fm accepts. */
export const LASTFM_KEY = '0123456789abcdef0123456789abcdef';

export interface FakeListening {
  lastfmUrl: string;
  listenbrainzUrl: string;
  /** Last.fm users by lowercase name, with Last.fm's own spelling. */
  lastfmUsers: Map<string, { name: string; playcount: number }>;
  /** ListenBrainz users and their listen counts. */
  listenbrainzUsers: Map<string, number>;
  requests: string[];
  close: () => Promise<void>;
}

/** Stand-ins for Last.fm (one endpoint, errors as JSON) and ListenBrainz, answering like the real services. */
export async function startFakeListening(): Promise<FakeListening> {
  const lastfmUsers = new Map([['sam', { name: 'Sam', playcount: 1200 }]]);
  const listenbrainzUsers = new Map([['sam_lb', 5400]]);
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push(url.pathname + url.search);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/lastfm/') {
      if (url.searchParams.get('api_key') !== LASTFM_KEY) {
        return json(403, { message: 'Invalid API key - You must be granted a valid key by last.fm', error: 10 });
      }
      const method = url.searchParams.get('method');
      if (method === 'chart.gettopartists') return json(200, { artists: { artist: [] } });
      if (method === 'user.getinfo') {
        const user = lastfmUsers.get((url.searchParams.get('user') ?? '').toLowerCase());
        return user
          ? json(200, { user: { name: user.name, playcount: String(user.playcount) } })
          : json(404, { message: 'User not found', error: 6 });
      }
      return json(400, { message: 'Invalid Method', error: 3 });
    }

    const count = url.pathname.match(/^\/listenbrainz\/1\/user\/([^/]+)\/listen-count$/);
    if (count) {
      const name = decodeURIComponent(count[1]!);
      const listens = listenbrainzUsers.get(name);
      return listens === undefined
        ? json(404, { code: 404, error: `Cannot find user: ${name}` })
        : json(200, { payload: { count: listens } });
    }
    json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    lastfmUrl: `${base}/lastfm/`,
    listenbrainzUrl: `${base}/listenbrainz/1`,
    lastfmUsers,
    listenbrainzUsers,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
