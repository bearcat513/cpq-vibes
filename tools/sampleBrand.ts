/**
 * Draws the sample templates' branding, and prints it as src/lib/sampleBrand.ts.
 *
 *     bun tools/sampleBrand.ts > src/lib/sampleBrand.ts
 *
 * The sample workspace is a worked example of every feature, and branding is
 * now one of them — which means the examples need a logo. Shipping one as a
 * binary asset would be a file the app has to find at runtime; shipping it as
 * base64 with no way to regenerate it would be a blob nobody can ever change.
 * So it is drawn here, by the arithmetic below, and baked into a module.
 *
 * Everything is painted into an RGB buffer and written with `encodePng` — the
 * same function the browser's image picker uses — so the sample logo is
 * produced by exactly the path a real one takes, and proves that path works.
 * Edges are supersampled 3×3, because a mark scaled down to 40 points on a
 * printed page shows every jagged step.
 */
import { encodePng, toDataUrl } from "../src/lib/image";

type Rgb = [number, number, number];
type Layer = { inside: (x: number, y: number) => boolean; color: Rgb };

/** Paints layers back to front over a background, 3×3 supersampled. */
async function draw(width: number, height: number, background: Rgb, layers: Layer[]): Promise<string> {
  const rgb = new Uint8Array(width * height * 3);
  const samples = 3;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          let color = background;
          for (const layer of layers) if (layer.inside(px, py)) color = layer.color;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }

      const at = (y * width + x) * 3;
      const total = samples * samples;
      rgb[at] = Math.round(r / total);
      rgb[at + 1] = Math.round(g / total);
      rgb[at + 2] = Math.round(b / total);
    }
  }

  return toDataUrl(await encodePng(rgb, width, height), "image/png");
}

/* --------------------------------- shapes -------------------------------- */

const circle = (cx: number, cy: number, radius: number) => (x: number, y: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;

const roundedRect =
  (left: number, top: number, right: number, bottom: number, radius: number) => (x: number, y: number) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const dx = Math.max(left + radius - x, x - (right - radius), 0);
    const dy = Math.max(top + radius - y, y - (bottom - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };

const any =
  (...shapes: ((x: number, y: number) => boolean)[]) =>
  (x: number, y: number) =>
    shapes.some(shape => shape(x, y));

/* --------------------------------- marks --------------------------------- */

const INK: Rgb = [29, 78, 216]; // #1d4ed8, the sample templates' accent
const NIGHT: Rgb = [15, 23, 42]; // #0f172a
const WHITE: Rgb = [255, 255, 255];

/** The mark: a cloud, knocked out of a rounded square. */
const logo = () =>
  draw(192, 192, WHITE, [
    { inside: roundedRect(4, 4, 188, 188, 44), color: INK },
    {
      inside: any(
        circle(76, 98, 28),
        circle(104, 82, 36),
        circle(134, 100, 26),
        roundedRect(58, 98, 142, 132, 17),
      ),
      color: WHITE,
    },
  ]);

/**
 * The cover banner: a gradient that varies along x only.
 *
 * Every scanline is therefore identical, which is why a 1600-pixel-wide
 * picture compresses to a couple of kilobytes.
 */
async function banner(): Promise<string> {
  const width = 1600;
  const height = 220;
  const rgb = new Uint8Array(width * height * 3);

  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    // Eased rather than linear: a straight ramp between two dark blues spends
    // most of its width looking like one colour.
    const ease = t * t * (3 - 2 * t);
    const color: Rgb = [
      Math.round(NIGHT[0] + (INK[0] - NIGHT[0]) * ease),
      Math.round(NIGHT[1] + (INK[1] - NIGHT[1]) * ease),
      Math.round(NIGHT[2] + (INK[2] - NIGHT[2]) * ease),
    ];
    for (let y = 0; y < height; y++) {
      const at = (y * width + x) * 3;
      rgb[at] = color[0];
      rgb[at + 1] = color[1];
      rgb[at + 2] = color[2];
    }
  }

  return toDataUrl(await encodePng(rgb, width, height), "image/png");
}

/* --------------------------------- output -------------------------------- */

const [mark, cover] = await Promise.all([logo(), banner()]);

const kb = (source: string) => Math.round((source.length * 3) / 4 / 1000);

process.stdout.write(`/**
 * The sample workspace's branding, drawn by tools/sampleBrand.ts.
 *
 * Generated, not hand-written: run \`bun tools/sampleBrand.ts > src/lib/sampleBrand.ts\`
 * to change either of them. They are here rather than in samples.ts because a
 * few thousand characters of base64 in the middle of the catalogue would bury
 * it — and because this is what a real logo looks like once the image picker
 * has prepared it: a flattened, non-interlaced PNG a PDF can carry as it is.
 */

/** A cloud mark on a rounded square, 192×192 — about ${kb(mark)} kB. */
export const SAMPLE_LOGO =
  "${mark}";

/** A wide gradient for a cover page, 1600×220 — about ${kb(cover)} kB. */
export const SAMPLE_COVER_BANNER =
  "${cover}";
`);
