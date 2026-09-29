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
  /** ListenBrainz user tokens, and whose they are. */
  listenbrainzTokens: Map<string, string>;
  /** Bodies of accepted submit-listens requests, with the token used. */
  submitted: { token: string; body: { listen_type: string; payload: { listened_at: number; track_metadata: Record<string, unknown> }[] } }[];
  /** What submit-listens answers (200 accepts). */
  submitStatus: { code: number };
  requests: string[];
  close: () => Promise<void>;
}

/** Stand-ins for Last.fm (one endpoint, errors as JSON) and ListenBrainz, answering like the real services. */
export async function startFakeListening(): Promise<FakeListening> {
  const lastfmUsers = new Map([['sam', { name: 'Sam', playcount: 1200 }]]);
  const listenbrainzUsers = new Map([['sam_lb', 5400]]);
  const listenbrainzTokens = new Map([['11111111-2222-4333-8444-555555555555', 'sam_lb']]);
  const submitted: FakeListening['submitted'] = [];
  const submitStatus = { code: 200 };
  const requests: string[] = [];

  const server: Server = createServer(async (req, res) => {
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

    const token = /^Token (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (url.pathname === '/listenbrainz/1/validate-token') {
      const user = listenbrainzTokens.get(token);
      return user
        ? json(200, { code: 200, message: 'Token valid.', valid: true, user_name: user })
        : json(401, { code: 401, message: 'Invalid token', valid: false });
    }
    if (url.pathname === '/listenbrainz/1/submit-listens' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (!listenbrainzTokens.has(token)) return json(401, { code: 401, error: 'Invalid authorization token.' });
      if (submitStatus.code !== 200) return json(submitStatus.code, { code: submitStatus.code, error: 'Service unavailable' });
      submitted.push({ token, body: JSON.parse(raw) });
      return json(200, { status: 'ok' });
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
    listenbrainzTokens,
    submitted,
    submitStatus,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
