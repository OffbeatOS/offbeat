import type { LibraryResponse } from '@offbeat/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LidarrError } from '../integrations/lidarr/client.js';
import { clientFor, loadLidarr } from '../integrations/lidarr/settings.js';
import { MBID } from '../catalog/releases.js';
import { imageVersion } from '../library/library.js';
import { parse } from './errors.js';

// Strict: digits only, so "1e3", "0x10", or "1.0" never reach a lookup.
const imageParams = z.object({ id: z.string().regex(/^[1-9]\d{0,9}$/).transform(Number) });
const imageQuery = z.object({ v: z.string().max(64).optional() });
const albumImageParams = z.object({ mbid: z.string().regex(MBID).transform((m) => m.toLowerCase()) });
const remoteQuery = z.object({
  u: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/),
  s: z.string().length(22).regex(/^[A-Za-z0-9_-]+$/),
});

const IMMUTABLE = 'private, max-age=31536000, immutable';

function sendImage(reply: FastifyReply, artwork: { body: Buffer; contentType: string }, cacheControl: string) {
  return reply
    .type(artwork.contentType)
    .header('Cache-Control', cacheControl)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .send(artwork.body);
}

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
    return sendImage(reply, artwork, current ? IMMUTABLE : 'private, no-cache');
  });

  /** Album covers, from Cover Art Archive or else Lidarr. A 404 means use the placeholder. */
  app.get('/images/album/:mbid', async (request, reply) => {
    const { mbid } = parse(albumImageParams, request.params);
    const artwork = await app.artwork.album(mbid, () => {
      const settings = loadLidarr(app.settings);
      return settings ? clientFor(settings) : null;
    });
    if (!artwork) return reply.code(404).header('Cache-Control', 'private, max-age=300').send();
    // A cover can appear later (for example once Lidarr has it), so cache for a day, not forever.
    return sendImage(reply, artwork, 'private, max-age=86400');
  });

  /**
   * Public artwork (search results, non-library artists, album covers). Only
   * URLs Offbeat signed, on allowlisted hosts, are fetched.
   */
  app.get('/images/remote', async (request, reply) => {
    const { u, s } = parse(remoteQuery, request.query);
    const url = app.imageUrls.verify(u, s);
    if (!url) return reply.code(404).send();
    const artwork = await app.artwork.remote(url);
    if (!artwork) return reply.code(404).send();
    // The URL is part of the signed request, so a given proxy URL never changes content.
    return sendImage(reply, artwork, IMMUTABLE);
  });
};
