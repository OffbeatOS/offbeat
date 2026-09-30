/**
 * A flat tint taken from artwork, for backgrounds that echo it (Now Playing,
 * and later the artist header): a dark background in the art's main hue, and
 * a light, muted text color in the same hue for secondary text. Artwork comes
 * through Offbeat's image proxy, so it is same-origin and a canvas can read it.
 */
export interface ArtTint {
  background: string;
  text: string;
}

const cache = new Map<string, Promise<ArtTint | null>>();
/** Enough pixels to find the main color, few enough to be instant. */
const SAMPLE = 24;

/** The tint for an image URL, or null when it cannot be read. Cached per URL. */
export function artTint(url: string | null): Promise<ArtTint | null> {
  if (!url) return Promise.resolve(null);
  let pending = cache.get(url);
  if (!pending) {
    pending = load(url).then(tintFromPixels).catch(() => null);
    cache.set(url, pending);
  }
  return pending;
}

function load(url: string): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return reject(new Error('no canvas'));
      context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
      resolve(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
    };
    image.onerror = () => reject(new Error('image failed'));
    image.src = url;
  });
}

/**
 * The main color of RGBA pixels, weighted toward colorful, mid-bright ones
 * (a black border or a white title should not decide the tint), made into
 * a dark background and a light text color. Exported for tests.
 */
export function tintFromPixels(pixels: Uint8ClampedArray): ArtTint {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3]! / 255;
    if (alpha < 0.5) continue;
    const [, s, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    const weight = alpha * (0.15 + s) * (1 - Math.abs(l - 0.5) * 1.6);
    if (weight <= 0) continue;
    r += pixels[i]! * weight;
    g += pixels[i + 1]! * weight;
    b += pixels[i + 2]! * weight;
    total += weight;
  }
  const [h, s] = total > 0 ? rgbToHsl(r / total, g / total, b / total) : [0, 0, 0];
  return {
    background: hsl(h, Math.min(s * 0.9, 0.35), 0.08),
    text: hsl(h, Math.min(s * 0.5, 0.2), 0.68),
  };
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
