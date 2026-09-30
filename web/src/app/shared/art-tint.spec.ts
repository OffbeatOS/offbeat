import { tintFromPixels } from './art-tint';

/** Pixels of one color, RGBA. */
const solid = (r: number, g: number, b: number, count = 16) =>
  new Uint8ClampedArray(Array.from({ length: count }, () => [r, g, b, 255]).flat());

describe('tintFromPixels', () => {
  it('turns dark green art into a dark green background and a muted light text color', () => {
    // The Now Playing mockup: art #2F3A33 gives about #141816 and #A9B1AC.
    const tint = tintFromPixels(solid(0x2f, 0x3a, 0x33));
    expect(tint.background).toMatch(/^hsl\(14\d (9|1\d)% 8%\)$/);
    expect(tint.text).toMatch(/^hsl\(14\d \d+% 68%\)$/);
  });

  it('lets colorful pixels decide, not a black border or a white title', () => {
    const pixels = new Uint8ClampedArray([...solid(0, 0, 0, 40), ...solid(255, 255, 255, 20), ...solid(200, 40, 40, 8)]);
    expect(tintFromPixels(pixels).background).toMatch(/^hsl\(0 3\d% 8%\)$/);
  });

  it('stays neutral for grey art, and keeps the background dark whatever the art', () => {
    expect(tintFromPixels(solid(128, 128, 128)).background).toBe('hsl(0 0% 8%)');
    expect(tintFromPixels(solid(255, 230, 0)).background).toMatch(/ 8%\)$/);
  });
});
