import type { ArtistPreview } from '@offbeat/shared';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DeezerError } from '../integrations/deezer/client.js';
import { MusicBrainzError } from '../integrations/musicbrainz/client.js';
import { USER_AGENT } from '../version.js';
import { HttpError, parse } from './errors.js';
import { mbidParams } from './catalog.js';

const previewQuery = z.object({ name: z.string().trim().min(1).max(200) });
const audioParams = z.object({ deezerTrackId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const AUDIO_TIMEOUT_MS = 15_000;
/** A 30-second MP3 is about half a megabyte; anything far bigger is not a preview. */
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/**
 * Previews for artists not in the library (Stream permission): the artist's
 * top tracks on Deezer, and each track's audio passed through Offbeat from
 * Deezer's preview servers only. Audio is streamed, never stored.
 */
export const previewRoutes: FastifyPluginAsync = async (app) => {
  const stream = { config: { permission: 'stream' as const } };

  app.get('/artists/:mbid/preview', stream, async (request): Promise<ArtistPreview> => {
    const { mbid } = parse(mbidParams, request.params);
    const { name } = parse(previewQuery, request.query);
    let preview: ArtistPreview | null;
    try {
      preview = await app.previews.forArtist(mbid.toLowerCase(), name);
    } catch (error) {
      if (error instanceof DeezerError || error instanceof MusicBrainzError) throw new HttpError(502, error.message);
      throw error;
    }
    if (!preview) throw new HttpError(404, 'No preview for this artist');
    return preview;
  });

  app.get('/previews/:deezerTrackId/audio', stream, async (request, reply) => {
    const { deezerTrackId } = parse(audioParams, request.params);
    let url: string;
    try {
      url = await app.previews.audioUrl(deezerTrackId);
    } catch (error) {
      if (error instanceof DeezerError) throw new HttpError(404, error.message);
      throw error;
    }
    // Stop fetching when the listener goes away (skipped, or the preview ended).
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());
    const timeout = setTimeout(() => abort.abort(), AUDIO_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...(request.headers.range ? { Range: request.headers.range } : {}) },
        redirect: 'error',
        signal: abort.signal,
      });
    } catch {
      throw new HttpError(502, 'Deezer did not send the preview');
    } finally {
      clearTimeout(timeout);
    }
    const length = Number(upstream.headers.get('content-length') ?? 0);
    if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.startsWith('audio/') || length > MAX_AUDIO_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new HttpError(502, 'Deezer did not send the preview');
    }
    reply.code(upstream.status).header('Content-Type', 'audio/mpeg').header('Cache-Control', 'no-store');
    for (const name of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) reply.header(name, value);
    }
    return reply.send(Readable.fromWeb(upstream.body as unknown as WebReadableStream));
  });
};
