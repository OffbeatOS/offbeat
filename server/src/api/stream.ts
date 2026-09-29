import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LidarrError } from '../integrations/lidarr/client.js';
import { type LocalTrackFile, MusicFileError, mimeTypeFor } from '../library/music-files.js';
import { TRANSCODE_TYPE, TranscoderUnavailable } from '../streaming/transcoder.js';
import { HttpError, parse } from './errors.js';

const params = z.object({ trackFileId: z.coerce.number().int().positive().max(2 ** 31) });
const query = z.object({
  /** Ask for MP3 from ffmpeg, for a file the browser cannot play. */
  transcode: z.enum(['mp3']).optional(),
  /** Where a transcoded stream starts, in seconds (a direct stream seeks with Range instead). */
  t: z.coerce.number().min(0).max(24 * 60 * 60).default(0),
});

/**
 * `GET /stream/:trackFileId`: a Lidarr track file's audio, for users with
 * the Stream permission. Directly, with HTTP ranges so the browser can seek;
 * or transcoded to MP3 by ffmpeg, starting at `t` seconds. Files are only
 * ever chosen by track file id (see MusicFiles.file).
 */
export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/stream/:trackFileId', { config: { permission: 'stream' } }, async (request, reply) => {
    const { trackFileId } = parse(params, request.params);
    const { transcode, t } = parse(query, request.query);
    const file = await localFile(trackFileId);

    if (transcode) {
      let child;
      try {
        child = await app.transcoder.start(file.path, t);
      } catch (error) {
        if (error instanceof TranscoderUnavailable) {
          throw new HttpError(503, 'This track needs ffmpeg to play in the browser, and Offbeat cannot find it. See the README.');
        }
        throw error;
      }
      // The listener went away (skipped, seeked, closed the tab): stop ffmpeg.
      reply.raw.once('close', () => child.kill('SIGKILL'));
      return reply.header('Content-Type', TRANSCODE_TYPE).header('Cache-Control', 'no-store').send(child.stdout);
    }

    return sendFile(file, request.headers.range, reply);
  });

  async function localFile(trackFileId: number): Promise<LocalTrackFile> {
    try {
      return await app.musicFiles.file(trackFileId);
    } catch (error) {
      if (error instanceof MusicFileError) throw new HttpError(error.status === 409 ? 409 : 404, error.message);
      if (error instanceof LidarrError) throw new HttpError(502, error.message);
      throw error;
    }
  }
};

async function sendFile(file: LocalTrackFile, rangeHeader: string | undefined, reply: FastifyReply) {
  let size: number;
  let modified: Date;
  try {
    const info = await stat(file.path);
    size = info.size;
    modified = info.mtime;
  } catch {
    throw new HttpError(404, 'That file is no longer where Lidarr says it is');
  }
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', mimeTypeFor(file.file).split(';')[0]!)
    .header('Last-Modified', modified.toUTCString())
    // A track file id always means the same file: an upgrade gets a new id.
    .header('Cache-Control', 'private, max-age=86400');

  const range = parseRange(rangeHeader, size);
  if (range === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  if (!range) {
    return reply.header('Content-Length', size).send(createReadStream(file.path));
  }
  return reply
    .code(206)
    .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
    .header('Content-Length', range.end - range.start + 1)
    .send(createReadStream(file.path, { start: range.start, end: range.end }));
}

/**
 * One byte range from a Range header (browsers ask for one at a time). Null
 * when there is none, or it is not one we understand (the whole file is sent,
 * as HTTP allows); 'unsatisfiable' when it starts past the end.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // "bytes=-500": the last 500 bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
