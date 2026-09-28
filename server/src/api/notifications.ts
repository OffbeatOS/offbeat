import {
  type ChannelKind,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationSettingsView,
} from '@offbeat/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isDiscordWebhook, maskDiscordUrl, unsafeUrl } from '../notifications/channels.js';
import type { NotificationSettings } from '../notifications/notifier.js';
import { HttpError, parse } from './errors.js';

const events = z.array(z.enum(NOTIFICATION_EVENTS as [NotificationEvent, ...NotificationEvent[]])).max(NOTIFICATION_EVENTS.length);
const publicBody = z.object({
  publicUrl: z
    .string()
    .trim()
    .url('use a full address, like https://offbeat.example.com')
    .refine((u) => /^https?:\/\//i.test(u), 'use an http or https address')
    .nullable(),
});
const discordBody = z.object({ enabled: z.boolean(), url: z.string().trim().nullable(), events });
const webhookBody = z.object({
  enabled: z.boolean(),
  url: z.string().trim().min(1, 'enter the address to send to'),
  secret: z
    .string()
    .trim()
    .refine((s) => s === '' || s.length >= 16, 'use at least 16 characters, or leave it empty')
    .max(256)
    .nullable(),
  events,
});
const channelParams = z.object({ channel: z.enum(['discord', 'webhook']) });

/** Settings, Notifications (admins only): where messages go, and what was sent. */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  const admin = { config: { role: 'admin' as const } };
  const view = (): NotificationSettingsView => toView(app.notifier.load(), app.notifier.recent());

  app.get('/settings/notifications', admin, async () => view());

  app.put('/settings/notifications', admin, async (request) => {
    const { publicUrl } = parse(publicBody, request.body);
    app.notifier.save({ ...app.notifier.load(), publicUrl: publicUrl?.replace(/\/+$/, '') ?? null });
    return view();
  });

  app.put('/settings/notifications/discord', admin, async (request) => {
    const body = parse(discordBody, request.body);
    const current = app.notifier.load();
    const url = body.url || current.discord?.url;
    if (!url) throw new HttpError(400, 'Paste the Discord webhook URL');
    if (body.url) {
      if (!isDiscordWebhook(body.url)) {
        throw new HttpError(400, 'That is not a Discord webhook URL. In Discord, open the channel settings, Integrations, Webhooks, and copy the URL.');
      }
      const why = await unsafeUrl(body.url);
      if (why) throw new HttpError(400, why);
    }
    app.notifier.save({ ...current, discord: { enabled: body.enabled, url, events: body.events, lastTest: current.discord?.lastTest ?? null } });
    return view();
  });

  app.put('/settings/notifications/webhook', admin, async (request) => {
    const body = parse(webhookBody, request.body);
    const why = await unsafeUrl(body.url);
    if (why) throw new HttpError(400, why);
    const current = app.notifier.load();
    const secret = body.secret === null ? (current.webhook?.secret ?? null) : body.secret || null;
    app.notifier.save({
      ...current,
      webhook: { enabled: body.enabled, url: body.url, secret, events: body.events, lastTest: current.webhook?.lastTest ?? null },
    });
    return view();
  });

  app.delete('/settings/notifications/:channel', admin, async (request) => {
    const { channel } = parse(channelParams, request.params);
    app.notifier.save({ ...app.notifier.load(), [channel]: null });
    return view();
  });

  /** Send Test: one message now, answered with how it went. */
  app.post('/settings/notifications/:channel/test', admin, async (request) => {
    const { channel } = parse(channelParams, request.params);
    if (!app.notifier.load()[channel as ChannelKind]) throw new HttpError(409, 'Save the channel first');
    await app.notifier.sendTest(channel as ChannelKind);
    return view();
  });
};

/** Never the Discord token or the webhook secret. */
function toView(settings: NotificationSettings, deliveries: NotificationSettingsView['deliveries']): NotificationSettingsView {
  const { discord, webhook } = settings;
  return {
    publicUrl: settings.publicUrl,
    discord: discord ? { enabled: discord.enabled, events: discord.events, urlHint: maskDiscordUrl(discord.url), lastTest: discord.lastTest } : null,
    webhook: webhook
      ? { enabled: webhook.enabled, url: webhook.url, events: webhook.events, secretSet: !!webhook.secret, lastTest: webhook.lastTest }
      : null,
    deliveries,
  };
}
