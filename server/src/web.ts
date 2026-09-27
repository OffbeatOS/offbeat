import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Angular emits content-hashed names: main-JEFRF2SC.js, chunk-BtWPvyb-.js,
// media/instrument-sans-latin-400-normal-GSIYICKK.woff2.
const HASHED_ASSET = /-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?)$/;

/**
 * Serves the compiled Angular app under BASE_URL with SPA fallback. The
 * `<base href>` in index.html is rewritten at startup so one build works
 * behind any subpath.
 */
export async function registerWeb(app: FastifyInstance, webRoot: string, baseUrl: string) {
  const indexFile = path.join(webRoot, 'index.html');
  if (!existsSync(indexFile)) {
    app.log.warn(`No web build at ${webRoot}; only the API is served. Run "npm run build -w web".`);
    return;
  }

  const indexHtml = readFileSync(indexFile, 'utf8').replace(
    /<base href="[^"]*"\s*\/?>/,
    `<base href="${baseUrl}/">`,
  );
  const apiPrefix = `${baseUrl}/api/`;

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: `${baseUrl}/`,
    index: false,
    setHeaders(reply, filePath) {
      if (HASHED_ASSET.test(filePath)) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  const sendIndex = (reply: FastifyReply) =>
    reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);

  // The static plugin answers directory URLs with 403 when `index` is off.
  app.get(`${baseUrl}/`, (_request, reply) => sendIndex(reply));
  if (baseUrl) {
    app.get(baseUrl, (_request, reply) => reply.redirect(`${baseUrl}/`, 301));
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    const wantsPage =
      (request.method === 'GET' || request.method === 'HEAD') &&
      pathname.startsWith(`${baseUrl}/`) &&
      !pathname.startsWith(apiPrefix) &&
      (request.headers.accept ?? '').includes('text/html');

    if (!wantsPage) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return sendIndex(reply);
  });
}
