/**
 * Turning a file somebody picked into a picture a PDF can carry.
 *
 * `src/lib/image.ts` is strict about what may be embedded: a PNG without an
 * alpha channel, or a baseline JPEG. Almost no logo arrives in that state —
 * it is an RGBA PNG, or a 4000-pixel export, or a WebP someone saved from a
 * brand site. This is the conversion that makes the strictness invisible: the
 * browser already has a decoder for every format it can display, and a canvas
 * is enough to flatten, scale and re-encode with.
 *
 * Three rules, in order:
 *
 * 1. **Keep the original bytes when they already work.** Re-encoding a PNG
 *    that was fine is a way of making it slightly worse for no reason.
 * 2. **Flatten losslessly.** Transparency composites onto a background colour
 *    — white, because that is what paper is — and the result is written back
 *    as a PNG. A logo is type and flat colour; JPEG is the wrong codec for it.
 * 3. **Fall back to JPEG only when PNG is too heavy.** A photograph on a cover
 *    page is a real use, and lossless is the wrong trade there.
 *
 * This is the one module in `src/lib` that needs a browser. It is the picking
 * of a file, which only ever happens in one.
 */
import { MAX_IMAGE_BYTES, decodeImage, encodePng, toDataUrl, type ImageMediaType } from "./image";

/** Longest side, in pixels. 1600 is past what any letterhead prints at. */
export const MAX_PREPARED_PIXELS = 1600;

export type PreparedImage = {
  /** The `data:` URL to store on the template. */
  source: string;
  width: number;
  height: number;
  byteLength: number;
  mediaType: ImageMediaType;
  /** What had to be done to it, if anything, for the editor to mention. */
  note?: string;
};

export type PrepareResult = { ok: true; image: PreparedImage } | { ok: false; error: string };

/* ------------------------------- decoding -------------------------------- */

/**
 * Anything the browser can display, as pixels.
 *
 * `createImageBitmap` is the direct route; the `<img>` fallback is there for
 * the formats and browsers where it is not offered, and costs one object URL.
 */
async function toBitmap(file: Blob): Promise<{ draw: CanvasImageSource; width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { draw: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall through: an unsupported format here is not a failure yet.
    }
  }

  // Outside a browser there is nothing to decode with, and that is a "no"
  // rather than a crash: this module is only ever *used* in one, but it is
  // imported wherever the editor is, tests included.
  if (typeof Image !== "function" || typeof URL.createObjectURL !== "function") return null;

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement | null>(resolve => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
    if (!image || !image.naturalWidth) return null;
    return { draw: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const readBytes = async (file: Blob): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());

/* ------------------------------ preparation ------------------------------- */

export async function prepareImageFile(
  file: Blob,
  options: { background?: string; maxPixels?: number } = {},
): Promise<PrepareResult> {
  const maxPixels = options.maxPixels ?? MAX_PREPARED_PIXELS;

  /* 1 — the bytes as they are, if a PDF would take them. */

  // Why the original could not be used, when it could not. It is the sentence
  // `decodeImage` produced, and it is what the editor is told afterwards —
  // "transparency flattened onto white" is worth knowing, and guessing at it
  // later would mean scanning the pixels a second time to find out.
  let why = "";

  if (file.size <= MAX_IMAGE_BYTES) {
    const bytes = await readBytes(file);
    const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (type === "image/png" || type === "image/jpeg") {
      const source = toDataUrl(bytes, type as ImageMediaType);
      const decoded = decodeImage(source);
      if (!decoded.ok) why = decoded.error;
      if (decoded.ok && decoded.image.width <= maxPixels && decoded.image.height <= maxPixels) {
        return {
          ok: true,
          image: {
            source,
            width: decoded.image.width,
            height: decoded.image.height,
            byteLength: bytes.length,
            mediaType: decoded.image.mediaType,
          },
        };
      }
    }
  }

  /* 2 — otherwise, through a canvas. */

  const bitmap = await toBitmap(file);
  if (!bitmap) return { ok: false, error: "That file is not an image this browser can read." };

  const scale = Math.min(1, maxPixels / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return { ok: false, error: "This browser would not give us a canvas to convert the image on." };

  // The fill is the flattening: whatever was transparent becomes the paper.
  context.fillStyle = options.background ?? "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap.draw, 0, 0, width, height);

  const notes: string[] = [];
  if (/transparency/i.test(why)) notes.push("transparency flattened onto the background colour");
  else if (why) notes.push("re-encoded into something a PDF can carry");
  if (scale < 1) notes.push(`scaled to ${width}×${height}`);

  /* 3 — PNG first, JPEG if it is too heavy. */

  const { data } = context.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0, at = 0; pixel < data.length; pixel += 4, at += 3) {
    rgb[at] = data[pixel]!;
    rgb[at + 1] = data[pixel + 1]!;
    rgb[at + 2] = data[pixel + 2]!;
  }

  let bytes = await encodePng(rgb, width, height);
  let mediaType: ImageMediaType = "image/png";

  if (bytes.length > MAX_IMAGE_BYTES) {
    const jpeg = await toJpeg(canvas);
    if (!jpeg) return { ok: false, error: "That image is too large, and this browser could not compress it." };
    bytes = jpeg;
    mediaType = "image/jpeg";
    notes.push("saved as a JPEG to fit");
  }

  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `That image is ${Math.round(bytes.length / 1000).toLocaleString()} kB even after compressing — crop it, or use a smaller one.`,
    };
  }

  const source = toDataUrl(bytes, mediaType);
  const decoded = decodeImage(source);
  // Belt and braces: the file that gets stored is one this app has just proved
  // it can embed, whatever the browser's encoder actually produced.
  if (!decoded.ok) return { ok: false, error: decoded.error };

  if (file.type && file.type !== mediaType) notes.push(`converted from ${file.type.replace("image/", "")}`);

  return {
    ok: true,
    image: {
      source,
      width,
      height,
      byteLength: bytes.length,
      mediaType,
      ...(notes.length ? { note: notes.join(", ") } : {}),
    },
  };
}

/** The canvas's own JPEG encoder, which is always baseline. */
async function toJpeg(canvas: HTMLCanvasElement, quality = 0.9): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  return blob ? readBytes(blob) : null;
}

/** Kilobytes, the way a person reads a file size. */
export const describeSize = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
