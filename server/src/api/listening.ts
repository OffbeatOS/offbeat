import type { AccountView, LastfmSettingsView } from '@offbeat/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { LastfmClient, LastfmError } from '../integrations/lastfm/client.js';
import { clearLastfm, loadLastfm, saveLastfm, toLastfmView } from '../integrations/lastfm/settings.js';
import { ListenBrainzError } from '../integrations/listenbrainz/client.js';
import { HttpError, parse } from './errors.js';

export interface ListeningRoutesOptions {
  /** Last.fm API base, overridden in tests. */
  lastfmUrl?: string;
  timeoutMs?: number;
}

const keyBody = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/i, 'a Last.fm API key is 32 letters and numbers'),
});

// Usernames go into URL paths, encoded; they only need to be plausible, and each service has the final say.
const username = z
  .string()
  .trim()
  .max(64, 'that username is too long')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'that username has characters no service allows')
  .nullish();
const listeningBody = z.object({ lastfmUsername: username, listenbrainzUsername: username });
// ListenBrainz user tokens are UUIDs; anything else is a paste mistake.
const tokenBody = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'a ListenBrainz token looks like 8-4-4-4-12 letters and numbers'),
});

/**
 * Last.fm connection (admins) and each user's listening accounts. Upstream
 * failures are 422 with a readable message, never 401, so a rejected key
 * never looks like an expired session.
 */
export const listeningRoutes: FastifyPluginAsync<ListeningRoutesOptions> = async (app, { lastfmUrl, timeoutMs }) => {
  const admin = { config: { role: 'admin' as const } };

  app.get('/settings/lastfm', admin, async (): Promise<LastfmSettingsView> => toLastfmView(loadLastfm(app.settings)));

  app.put('/settings/lastfm', admin, async (request): Promise<LastfmSettingsView> => {
    const { apiKey } = parse(keyBody, request.body);
    await upstream(() => new LastfmClient({ apiKey, url: lastfmUrl, timeoutMs }).validateKey());
    saveLastfm(app.settings, { apiKey });
    request.log.info('Last.fm connected');
    return toLastfmView({ apiKey });
  });

  app.delete('/settings/lastfm', admin, async (request): Promise<LastfmSettingsView> => {
    clearLastfm(app.settings);
    request.log.info('Last.fm disconnected');
    return toLastfmView(null);
  });

  app.get('/account', async (request): Promise<AccountView> => account(request));

  app.put('/account/listening', async (request): Promise<AccountView> => {
    const body = parse(listeningBody, request.body);
    const changes: Partial<typeof users.$inferInsert> = {};

    // Check every name before saving any, so a half-valid form changes nothing.
    if (body.lastfmUsername !== undefined) {
      const name = body.lastfmUsername?.trim() || null;
      if (name) {
        const lastfm = app.sources.lastfm();
        if (!lastfm) throw new HttpError(422, 'Last.fm is not connected yet. An admin can connect it in Settings, Integrations.');
        const user = await upstream(() => lastfm.user(name));
        if (!user) throw new HttpError(422, `Last.fm has no user called ${name}`);
        changes.lastfmUsername = user.name; // Last.fm's own spelling
      } else {
        changes.lastfmUsername = null;
      }
    }
    if (body.listenbrainzUsername !== undefined) {
      const name = body.listenbrainzUsername?.trim() || null;
      if (name) {
        const count = await upstream(() => app.sources.listenbrainz.listenCount(name));
        if (count === null) throw new HttpError(422, `ListenBrainz has no user called ${name}`);
        changes.listenbrainzUsername = name;
      } else {
        changes.listenbrainzUsername = null;
      }
    }

    if (Object.keys(changes).length) {
      app.db.update(users).set(changes).where(eq(users.id, request.user!.id)).run();
    }
    return account(request);
  });

  /**
   * Submit plays to ListenBrainz: the token (from ListenBrainz's settings
   * page) is checked with ListenBrainz, stored encrypted, and never sent back.
   * Plays from now on are submitted; earlier ones are not.
   */
  app.put('/account/listenbrainz-token', async (request): Promise<AccountView> => {
    const { token } = parse(tokenBody, request.body);
    await upstream(() => app.plays.connect(request.user!.id, token));
    return account(request);
  });

  app.delete('/account/listenbrainz-token', async (request): Promise<AccountView> => {
    app.plays.disconnect(request.user!.id);
    return account(request);
  });

  function account(request: FastifyRequest): AccountView {
    const row = app.db.select().from(users).where(eq(users.id, request.user!.id)).get();
    if (!row) throw new HttpError(401, 'Sign in to continue');
    return {
      username: row.username,
      role: row.role,
      lastfmUsername: row.lastfmUsername,
      listenbrainzUsername: row.listenbrainzUsername,
      lastfmAvailable: !!loadLastfm(app.settings),
      listenbrainzSubmit: app.plays.submitView(row.id),
    };
  }
};

async function upstream<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LastfmError || error instanceof ListenBrainzError) throw new HttpError(422, error.message);
    throw error;
  }
}
