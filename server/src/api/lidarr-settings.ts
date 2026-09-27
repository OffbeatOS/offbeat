import type { LidarrOptions, LidarrSettingsView } from '@offbeat/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LidarrClient, LidarrError, normalizeLidarrUrl } from '../integrations/lidarr/client.js';
import { loadLidarr, saveLidarr, toView } from '../integrations/lidarr/settings.js';
import { HttpError, parse } from './errors.js';

const testBody = z.object({
  url: z.string().trim().min(1, 'enter the Lidarr address').max(2048),
  apiKey: z.string().trim().max(256).optional(),
});

const saveBody = testBody.extend({
  qualityProfileId: z.number().int(),
  metadataProfileId: z.number().int(),
  rootFolderPath: z.string().min(1),
});

export interface LidarrRoutesOptions {
  /** Shorter in tests so unreachable hosts fail fast. */
  timeoutMs?: number;
}

/**
 * Admin-only. Upstream failures are 422 with a readable message, never 401:
 * Lidarr rejecting its key must not look like the user's session expiring.
 */
export const lidarrSettingsRoutes: FastifyPluginAsync<LidarrRoutesOptions> = async (app, { timeoutMs }) => {
  const admin = { config: { role: 'admin' as const } };

  /** Builds a client from the form, falling back to the saved key only for the same address. */
  function connect(request: FastifyRequest, body: z.infer<typeof testBody>) {
    try {
      const url = normalizeLidarrUrl(body.url);
      const saved = loadLidarr(app.settings);
      const apiKey = body.apiKey || (saved && saved.url === url ? saved.apiKey : '');
      if (!apiKey) throw new HttpError(400, 'Enter the API key');
      return { url, apiKey, client: new LidarrClient({ url, apiKey, timeoutMs }) };
    } catch (error) {
      throw asHttpError(error, request);
    }
  }

  async function loadOptions(request: FastifyRequest, client: LidarrClient) {
    try {
      return await client.loadOptions();
    } catch (error) {
      throw asHttpError(error, request);
    }
  }

  app.post('/setup/lidarr/test', admin, async (request): Promise<LidarrOptions> => {
    const { client } = connect(request, parse(testBody, request.body));
    return loadOptions(request, client);
  });

  const save = async (request: FastifyRequest): Promise<LidarrSettingsView> => {
    const body = parse(saveBody, request.body);
    const { url, apiKey, client } = connect(request, body);
    // Re-test on save so a stale form cannot store a broken connection.
    const options = await loadOptions(request, client);
    if (!options.qualityProfiles.some((p) => p.id === body.qualityProfileId)) {
      throw new HttpError(400, 'That quality profile no longer exists in Lidarr');
    }
    if (!options.metadataProfiles.some((p) => p.id === body.metadataProfileId)) {
      throw new HttpError(400, 'That metadata profile no longer exists in Lidarr');
    }
    if (!options.rootFolders.some((f) => f.path === body.rootFolderPath)) {
      throw new HttpError(400, 'That root folder no longer exists in Lidarr');
    }
    const stored = {
      url,
      apiKey,
      qualityProfileId: body.qualityProfileId,
      metadataProfileId: body.metadataProfileId,
      rootFolderPath: body.rootFolderPath,
    };
    saveLidarr(app.settings, stored);
    request.log.info({ url }, 'Lidarr settings saved');
    app.library.sync().catch(() => undefined); // refresh the cache for the new connection
    return toView(stored);
  };

  app.post('/setup/lidarr', admin, save);
  app.put('/settings/lidarr', admin, save);

  app.get('/settings/lidarr', admin, async (): Promise<{ settings: LidarrSettingsView | null }> => {
    const saved = loadLidarr(app.settings);
    return { settings: saved ? toView(saved) : null };
  });
};

function asHttpError(error: unknown, request: FastifyRequest): unknown {
  if (error instanceof LidarrError) {
    request.log.warn({ reason: error.message }, 'Lidarr connection failed');
    return new HttpError(422, error.message);
  }
  return error;
}
