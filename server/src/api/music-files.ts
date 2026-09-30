import type { MusicFilesCheck, MusicFilesView } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { LidarrError } from '../integrations/lidarr/client.js';
import { MusicFileError } from '../library/music-files.js';
import { HttpError, parse } from './errors.js';

const saveBody = z.object({
  folders: z
    .array(z.object({ lidarrPath: z.string().min(1), offbeatPath: z.string().max(1024) }))
    .max(50),
});

/** Settings, Lidarr, Music files (admins only): where Offbeat reads Lidarr's root folders, and a check that it can. */
export const musicFilesRoutes: FastifyPluginAsync = async (app) => {
  const admin = { config: { role: 'admin' as const } };

  const withFfmpeg = async (view: Omit<MusicFilesView, 'ffmpeg'>): Promise<MusicFilesView> => ({ ...view, ffmpeg: await app.transcoder.version() });

  app.get('/settings/music-files', admin, async (): Promise<MusicFilesView> => withFfmpeg(await guarded(() => app.musicFiles.view())));

  app.put('/settings/music-files', admin, async (request): Promise<MusicFilesView> => {
    const body = parse(saveBody, request.body);
    return withFfmpeg(await guarded(() => app.musicFiles.save(body)));
  });

  app.post('/settings/music-files/check', admin, async (): Promise<MusicFilesCheck> => guarded(() => app.musicFiles.check()));
};

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MusicFileError) throw new HttpError(error.status === 409 ? 400 : error.status, error.message);
    if (error instanceof LidarrError) throw new HttpError(502, error.message);
    throw error;
  }
}
