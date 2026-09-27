/**
 * Starts the fake Lidarr for manual testing without touching a real library:
 *   npx tsx server/test/run-fake-lidarr.ts --artists 2500 --port 8699
 * Prints the URL and API key to enter in onboarding.
 */
import { parseArgs } from 'node:util';
import { startFakeLidarr } from './fake-lidarr.js';

const { values } = parseArgs({
  options: {
    artists: { type: 'string', default: '500' },
    port: { type: 'string', default: '8699' },
    'url-base': { type: 'string', default: '' },
    'api-key': { type: 'string' },
  },
});

const fake = await startFakeLidarr({
  artists: Number(values.artists),
  port: Number(values.port),
  urlBase: values['url-base'],
  apiKey: values['api-key'],
});
console.log(`Fake Lidarr with ${values.artists} artists at ${fake.url}`);
console.log(`API key: ${fake.apiKey}`);

setInterval(() => {
  if (fake.unauthenticated.length) {
    console.log(`Requests without the API key: ${fake.unauthenticated.splice(0).join(', ')}`);
  }
}, 2000);
