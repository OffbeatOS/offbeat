import type { LibraryResponse } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LidarrError } from '../integrations/lidarr/client.js';
import { clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import { imageVersion } from '../library/library.js';
import { parse } from './errors.js';

const imageParams = z.object({ id: z.coerce.number().int().positive() });
const imageQuery = z.object({ v: z.string().optional() });

/** Any signed-in user can browse the library. */
export const libraryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/library', async (): Promise<LibraryResponse> => app.library.read());

  app.post('/library/refresh', async (): Promise<LibraryResponse> => app.library.refresh());

  /**
   * Artist artwork through Offbeat, so the browser never sees a Lidarr URL or
   * key. The `v` query changes with the artwork, so matching URLs are immutable.
   */
  app.get('/images/artist/:id', async (request, reply) => {
    const { id } = parse(imageParams, request.params);
    const { v } = parse(imageQuery, request.query);
    const artist = app.library.artist(id);
    if (!artist) return reply.code(404).send();

    let artwork;
    try {
      artwork = await app.artwork.artist(artist, () => {
        const settings = loadLidarr(app.settings);
        return settings ? clientFor(settings) : null;
      });
    } catch (error) {
      // Lidarr down or refusing: the UI falls back to a placeholder, quietly.
      request.log.debug({ err: error }, 'Artwork unavailable');
      return reply.code(error instanceof LidarrError ? 502 : 500).send();
    }
    if (!artwork) return reply.code(404).send();

    const current = v !== undefined && v === imageVersion(artist);
    return reply
      .type(artwork.contentType)
      .header('Cache-Control', current ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(artwork.body);
  });
};
