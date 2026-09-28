/** What Offbeat can tell other apps about. */
export type NotificationEvent = 'album-imported' | 'download-failed' | 'import-blocked' | 'new-release';

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = ['album-imported', 'download-failed', 'import-blocked', 'new-release'];

/** The channels Offbeat can send to. */
export type ChannelKind = 'discord' | 'webhook';

export interface DiscordChannel {
  enabled: boolean;
  /** https://discord.com/api/webhooks/... */
  url: string;
  events: NotificationEvent[];
}

export interface WebhookChannel {
  enabled: boolean;
  url: string;
  /** When set, each request carries X-Offbeat-Signature: sha256=<HMAC of the body>. */
  secret: string | null;
  events: NotificationEvent[];
}

/** `GET /settings/notifications` (admins only). Secrets are never sent back; the Discord URL is masked. */
export interface NotificationSettingsView {
  /** Where messages link back to, like https://offbeat.example.com. Without it, messages have no links. */
  publicUrl: string | null;
  discord: (Omit<DiscordChannel, 'url'> & { urlHint: string; lastTest: DeliveryResult | null }) | null;
  webhook: (Omit<WebhookChannel, 'secret'> & { secretSet: boolean; lastTest: DeliveryResult | null }) | null;
  deliveries: Delivery[];
}

/** `PUT /settings/notifications/discord`. Omit `url` (or send null) to keep the saved one. */
export interface SaveDiscordRequest {
  enabled: boolean;
  url: string | null;
  events: NotificationEvent[];
}

/** `PUT /settings/notifications/webhook`. `secret`: a string sets it, "" clears it, null keeps it. */
export interface SaveWebhookRequest {
  enabled: boolean;
  url: string;
  secret: string | null;
  events: NotificationEvent[];
}

export interface DeliveryResult {
  ok: boolean;
  at: string;
  error: string | null;
}

export type DeliveryStatus = 'delivered' | 'retrying' | 'failed';

/** One message to one channel, for the Recent deliveries log. */
export interface Delivery {
  id: number;
  channel: ChannelKind;
  event: NotificationEvent | 'test';
  title: string;
  message: string;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The generic webhook's JSON body. `version` changes only when a field is
 * removed or changes meaning; new fields can appear without it.
 */
export interface WebhookPayload {
  version: 1;
  event: NotificationEvent | 'test';
  title: string;
  message: string;
  /** A link back to Offbeat, when Settings, Notifications has its address. */
  url: string | null;
  artist: { mbid: string | null; name: string } | null;
  album: { mbid: string | null; title: string } | null;
  /** Why, for failures and blocked imports. */
  reason: string | null;
  occurredAt: string;
}
