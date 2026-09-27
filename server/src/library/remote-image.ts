import { ResponseTooLarge, fetchBuffered } from '../integrations/http.js';

/**
 * Public artwork hosts Offbeat may fetch from on the browser's behalf. Anything
 * else is refused, so the image proxy cannot be used to reach arbitrary URLs.
 */
const ALLOWED_HOSTS = ['images.lidarr.audio', 'assets.fanart.tv', 'coverartarchive.org', 'archive.org'];

export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}

const MAX_REDIRECTS = 3;

/**
 * Fetches an allowlisted image, following redirects only while every hop stays
 * on the allowlist (Cover Art Archive redirects to archive.org mirrors).
 * Returns null for anything missing, oversized, or not an image.
 */
export async function fetchAllowedImage(
  url: string,
  { timeoutMs = 8000, maxBytes = 10 * 1024 * 1024 } = {},
): Promise<FetchedImage | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedImageUrl(current)) return null;
    let response: Response;
    try {
      response = await fetchBuffered(current, { redirect: 'manual', timeoutMs, maxBytes, headers: { Accept: 'image/*' } });
    } catch (error) {
      if (error instanceof ResponseTooLarge) return null;
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) return null;
    return { body, contentType: response.headers.get('content-type') ?? '' };
  }
  return null;
}
