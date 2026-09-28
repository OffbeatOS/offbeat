import type { SignInSettings, SignInSettingsView } from '@offbeat/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { blockListOf, contains, parseRange } from '../auth/network.js';
import { addressOf, dockerStandInAddresses, loadSignIn, saveSignIn, signInSchema } from '../auth/sign-in.js';
import { users } from '../db/schema.js';
import { HttpError, parse } from './errors.js';

/** Settings, Users, Sign-in: reverse proxy header auth and local network auto-login (admins only). */
export const signInSettingsRoutes: FastifyPluginAsync = async (app) => {
  const admin = { config: { role: 'admin' as const } };

  app.get('/settings/sign-in', admin, async (request): Promise<SignInSettingsView> => ({
    ...loadSignIn(app.settings),
    yourAddress: addressOf(app.settings, request.socket.remoteAddress, request.headers).client,
    dockerAddresses: dockerStandInAddresses(),
  }));

  app.put('/settings/sign-in', admin, async (request): Promise<SignInSettingsView> => {
    const settings: SignInSettings = parse(signInSchema, request.body);
    check(settings);
    saveSignIn(app.settings, settings);
    return {
      ...settings,
      yourAddress: addressOf(app.settings, request.socket.remoteAddress, request.headers).client,
      dockerAddresses: dockerStandInAddresses(),
    };
  });

  function check(settings: SignInSettings) {
    const { proxy, autoLogin } = settings;
    if (proxy.enabled && proxy.trustedProxies.length === 0) {
      throw new HttpError(400, 'Add the address of your reverse proxy. Without one, the header is always ignored.');
    }
    if (!autoLogin.enabled) return;
    if (!autoLogin.userId) throw new HttpError(400, 'Choose who auto-login signs in as');
    const user = app.db.select().from(users).where(eq(users.id, autoLogin.userId)).get();
    if (!user) throw new HttpError(400, 'That user does not exist');
    if (user.role === 'admin') throw new HttpError(400, 'Auto-login can never sign in as an admin. Choose a Member.');
    if (autoLogin.networks.length === 0) throw new HttpError(400, 'Add the addresses of your local network');
    for (const text of autoLogin.networks) {
      if (parseRange(text)!.prefix === 0) {
        throw new HttpError(400, `${text} is every address on the internet, not a local network`);
      }
    }
    const networks = blockListOf(autoLogin.networks);
    const standIn = dockerStandInAddresses().find((address) => contains(networks, address));
    if (standIn) {
      throw new HttpError(
        400,
        `These networks include ${standIn}. Offbeat runs in Docker, where connections through a published port can come from that address whoever makes them, so it would sign in anyone who reaches the port. List your devices' own addresses instead, or run Offbeat with host networking.`,
      );
    }
  }
};
