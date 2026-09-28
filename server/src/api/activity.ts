import type { ActivitySnapshot } from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { NotFound } from '../activity/activity.js';
import { LidarrError } from '../integrations/lidarr/client.js';
import { HttpError, parse } from './errors.js';

const itemParams = z.object({ id: z.string().regex(/^(queue|add|search):[A-Za-z0-9-]{1,64}$/, 'not an activity id') });
const HEARTBEAT_MS = 25_000;

/**
 * Activity for every signed-in user. Browsers keep one Server-Sent Events
 * stream open instead of polling; the server polls Lidarr once for everyone.
 */
export const activityRoutes: FastifyPluginAsync = async (app) => {
  const streams = new Set<ServerResponse>();

  // Hijacked responses are outside Fastify's control; end them on shutdown.
  app.addHook('onClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });

  app.get('/activity', async (): Promise<ActivitySnapshot> => {
    if (!app.activity.current().updatedAt) await app.activity.refresh();
    return app.activity.current();
  });

  app.get('/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stop nginx and similar proxies from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    streams.add(res);

    const unsubscribe = app.activity.subscribe((event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
    });
  });

  // Retry blocklists the release and searches again: asking for the album anew.
  app.post('/activity/:id/retry', { config: { permission: 'add-albums' } }, async (request, reply) => {
    const { id } = parse(itemParams, request.params);
    await guard(() => app.activity.retry(id));
    return reply.code(202).send({ queued: true });
  });

  app.delete('/activity/:id', { config: { permission: 'delete' } }, async (request, reply) => {
    const { id } = parse(itemParams, request.params);
    await guard(() => app.activity.cancel(id));
    return reply.code(202).send({ removed: true });
  });
};

async function guard(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof NotFound) throw new HttpError(404, 'That item is no longer in the queue');
    if (error instanceof LidarrError) throw new HttpError(422, error.message);
    throw error;
  }
}
