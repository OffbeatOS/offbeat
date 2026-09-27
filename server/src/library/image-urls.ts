import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAllowedImageUrl } from './remote-image.js';

/**
 * Proxy URLs for public artwork. Only URLs Offbeat itself chose are signed,
 * so the endpoint cannot be pointed at other files, even on allowlisted hosts.
 */
export class ImageUrls {
  constructor(private readonly key: Buffer) {}

  /** A browser-safe proxy URL, or null when the source host is not allowlisted. */
  remote(url: string | null | undefined): string | null {
    if (!url || !isAllowedImageUrl(url)) return null;
    const encoded = Buffer.from(url, 'utf8').toString('base64url');
    return `api/v1/images/remote?u=${encoded}&s=${this.sign(url)}`;
  }

  /** Cover Art Archive front cover for a release group, at 250px. */
  releaseGroupCover(releaseGroupMbid: string): string | null {
    return this.remote(`https://coverartarchive.org/release-group/${releaseGroupMbid}/front-250`);
  }

  /** The original URL when the signature matches and the host is allowlisted, else null. */
  verify(encoded: string, signature: string): string | null {
    let url: string;
    try {
      url = Buffer.from(encoded, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expected = Buffer.from(this.sign(url));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return isAllowedImageUrl(url) ? url : null;
  }

  private sign(url: string): string {
    return createHmac('sha256', this.key).update(`image-url:${url}`).digest('base64url').slice(0, 22);
  }
}
