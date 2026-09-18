/**
 * Images, for a PDF writer that has no image library behind it.
 *
 * Branding a proposal means a logo on it, and a logo is the one thing the
 * document format could not carry. This file is what makes it possible
 * without taking on a decoder: it does not *render* an image, it works out
 * whether the bytes can be handed to a PDF reader as they are.
 *
 * That turns out to be true far more often than it sounds, because PDF's two
 * relevant stream filters are formats we already have:
 *
 * - **JPEG** is `DCTDecode`. The file's own entropy-coded data *is* the
 *   stream; all that is needed is the width, height and component count out
 *   of the frame header.
 * - **PNG** is `FlateDecode` with a predictor. A PNG's `IDAT` is zlib over
 *   exactly the per-scanline filtering PDF calls predictor 15, so the chunks
 *   concatenated *are* the stream, and the palette, if any, becomes an
 *   `/Indexed` colour space.
 *
 * So a logo goes into the file byte for byte: no decoding, no re-encoding, no
 * quality lost, and the whole of this file is header parsing.
 *
 * ## What is refused, and why that is safe
 *
 * PDF has no notion of an alpha channel inside an image stream — transparency
 * is a second, separate greyscale stream — so an RGBA PNG cannot be passed
 * through, and splitting it would mean owning an inflate implementation. It
 * is refused here and *flattened by the uploader instead*: see
 * `src/lib/imageFile.ts`, which composites onto a background in the browser
 * and re-encodes losslessly. Same for interlaced PNGs, CMYK JPEGs and
 * progressive JPEGs. Everything a person can pick in the UI therefore works;
 * a caller hand-writing a template body against the API gets a sentence
 * saying which of these it hit.
 */

/* --------------------------------- limits -------------------------------- */

/** The encoded image, as stored. Big enough for a letterhead, not a photo set. */
export const MAX_IMAGE_BYTES = 750_000;

/** Pixels on the longest side. Past this an image is a scan, not branding. */
export const MAX_IMAGE_PIXELS = 6_000;

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/* ------------------------------- data URLs -------------------------------- */

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is;

export type DataUrlParts = { mediaType: string; bytes: Uint8Array };

/**
 * Bytes out of a `data:` URL.
 *
 * Only base64 is accepted: an image is binary, and percent-encoded binary in
 * a JSON document is a way of storing the same picture twice as large.
 */
export function parseDataUrl(value: string): DataUrlParts | null {
  const match = DATA_URL.exec(value.trim());
  if (!match) return null;

  const mediaType = match[1]!.toLowerCase();
  if (!/;\s*base64/i.test(match[2] ?? "")) return null;

  try {
    const binary = atob(match[3]!.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mediaType, bytes };
  } catch {
    return null;
  }
}

/** Bytes in, `data:` URL out — the form a template stores. */
export function toDataUrl(bytes: Uint8Array, mediaType: ImageMediaType): string {
  let binary = "";
  // In chunks: `String.fromCharCode(...bytes)` on a megabyte overflows the
  // argument list on every engine that matters.
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/* ------------------------------ the decoded ------------------------------- */

/** An `/Indexed` colour space: the palette goes into the PDF beside the image. */
export type IndexedColorSpace = { kind: "indexed"; hival: number; palette: Uint8Array };

export type ImageColorSpace = { kind: "gray" } | { kind: "rgb" } | IndexedColorSpace;

/** PNG pass-through needs the reader to undo the per-scanline filtering. */
export type ImagePredictor = { predictor: 15; colors: number; bitsPerComponent: number; columns: number };

/**
 * An image ready to be written into a PDF as an XObject.
 *
 * `data` is the stream exactly as it will appear in the file — the JPEG's own
 * bytes, or the PNG's concatenated `IDAT` — which is why nothing here has to
 * decode a pixel.
 */
export type EmbeddableImage = {
  mediaType: ImageMediaType;
  filter: "DCTDecode" | "FlateDecode";
  data: Uint8Array;
  width: number;
  height: number;
  bitsPerComponent: number;
  colorSpace: ImageColorSpace;
  predictor?: ImagePredictor;
  /** What the data URL weighs, for the editor's size readout. */
  byteLength: number;
};

export type ImageResult = { ok: true; image: EmbeddableImage } | { ok: false; error: string };

const fail = (error: string): ImageResult => ({ ok: false, error });

/* --------------------------------- PNG ------------------------------------ */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readUint32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const chunkName = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

function decodePng(bytes: Uint8Array): ImageResult {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return fail("That file is named as a PNG but does not start like one.");
  }

  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  let palette: Uint8Array | null = null;
  let transparency = false;
  const data: Uint8Array[] = [];

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = readUint32(bytes, at);
    const name = chunkName(bytes, at + 4);
    const start = at + 8;
    if (start + length > bytes.length) return fail("This PNG is truncated.");

    if (name === "IHDR") {
      header = {
        width: readUint32(bytes, start),
        height: readUint32(bytes, start + 4),
        bitDepth: bytes[start + 8]!,
        colorType: bytes[start + 9]!,
        interlace: bytes[start + 12]!,
      };
      // Compression and filter method are single-valued in the format; a file
      // claiming otherwise is not a PNG this can reason about.
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0) return fail("This PNG uses a compression this app cannot read.");
    } else if (name === "PLTE") {
      palette = bytes.subarray(start, start + length);
    } else if (name === "tRNS") {
      transparency = true;
    } else if (name === "IDAT") {
      data.push(bytes.subarray(start, start + length));
    } else if (name === "IEND") {
      break;
    }

    at = start + length + 4; // + CRC
  }

  if (!header) return fail("This PNG has no header chunk.");
  if (!data.length) return fail("This PNG has no image data.");
  if (header.interlace !== 0) return fail("Interlaced PNGs cannot be embedded — save it without interlacing.");

  const { width, height, bitDepth, colorType } = header;
  if (!width || !height) return fail("This image has no size.");

  // The alpha cases. Deliberately a message about what to do, because the
  // uploader does exactly this for anything picked in the UI.
  if (colorType === 4 || colorType === 6 || transparency) {
    return fail("A PDF cannot carry transparency in an image — flatten it onto a background colour first.");
  }
  if (colorType !== 0 && colorType !== 2 && colorType !== 3) return fail("This PNG has an unsupported colour type.");

  const colors = colorType === 2 ? 3 : 1;

  if (colorType === 3) {
    if (!palette) return fail("This PNG says it is paletted but carries no palette.");
    if (![1, 2, 4, 8].includes(bitDepth)) return fail("This PNG's colour depth cannot be embedded.");
  } else if (bitDepth !== 8 && bitDepth !== 16) {
    return fail("Only 8- and 16-bit PNGs can be embedded.");
  }

  // One buffer: the stream is a single zlib document split across chunks, so
  // it has to be handed over whole.
  const total = data.reduce((sum, chunk) => sum + chunk.length, 0);
  const stream = new Uint8Array(total);
  let offset = 0;
  for (const chunk of data) {
    stream.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    ok: true,
    image: {
      mediaType: "image/png",
      filter: "FlateDecode",
      data: stream,
      width,
      height,
      bitsPerComponent: bitDepth,
      colorSpace:
        colorType === 3
          ? { kind: "indexed", hival: Math.max(0, Math.floor(palette!.length / 3) - 1), palette: palette! }
          : colorType === 2
            ? { kind: "rgb" }
            : { kind: "gray" },
      predictor: { predictor: 15, colors, bitsPerComponent: bitDepth, columns: width },
      byteLength: bytes.length,
    },
  };
}

/* --------------------------------- JPEG ----------------------------------- */

/** Frame markers. The ones absent here are arithmetic-coded or hierarchical. */
const BASELINE = new Set([0xc0, 0xc1]);
const PROGRESSIVE = new Set([0xc2, 0xc6, 0xca, 0xce]);
const LOSSLESS = new Set([0xc3, 0xc5, 0xc7, 0xc9, 0xcb, 0xcd, 0xcf]);

function decodeJpeg(bytes: Uint8Array): ImageResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return fail("That file is named as a JPEG but does not start like one.");
  }

  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at++; // Fill byte or padding between segments.
      continue;
    }

    const marker = bytes[at + 1]!;
    // Standalone markers carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    // Start of scan: the frame header is behind us or not present at all.
    if (marker === 0xda) break;

    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;

    if (BASELINE.has(marker) || PROGRESSIVE.has(marker) || LOSSLESS.has(marker)) {
      if (PROGRESSIVE.has(marker)) {
        return fail("Progressive JPEGs cannot be embedded — save it as a baseline JPEG.");
      }
      if (LOSSLESS.has(marker)) return fail("This JPEG uses a coding a PDF reader will not accept.");

      const precision = bytes[at + 4]!;
      const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
      const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
      const components = bytes[at + 9]!;

      if (precision !== 8) return fail("Only 8-bit JPEGs can be embedded.");
      if (!width || !height) return fail("This image has no size.");
      if (components !== 1 && components !== 3) {
        return fail("This JPEG is not greyscale or RGB — save it as an RGB JPEG.");
      }

      return {
        ok: true,
        image: {
          mediaType: "image/jpeg",
          filter: "DCTDecode",
          data: bytes,
          width,
          height,
          bitsPerComponent: 8,
          colorSpace: components === 3 ? { kind: "rgb" } : { kind: "gray" },
          byteLength: bytes.length,
        },
      };
    }

    at += 2 + length;
  }

  return fail("This JPEG has no frame header.");
}

/* -------------------------------- the door -------------------------------- */

/**
 * Reads a `data:` URL into something the PDF writer can embed.
 *
 * Every error is a sentence about this image rather than a code, because the
 * only people who see one are looking at a file they just chose.
 */
export function decodeImage(source: string): ImageResult {
  const parts = parseDataUrl(source);
  if (!parts) return fail("An image must be a base64 `data:` URL.");

  if (parts.bytes.length > MAX_IMAGE_BYTES) {
    return fail(`An image must be ${Math.round(MAX_IMAGE_BYTES / 1000).toLocaleString()} kB or smaller.`);
  }

  const result =
    parts.mediaType === "image/png"
      ? decodePng(parts.bytes)
      : parts.mediaType === "image/jpeg" || parts.mediaType === "image/jpg"
        ? decodeJpeg(parts.bytes)
        : fail("An image must be a PNG or a JPEG.");

  if (!result.ok) return result;

  if (result.image.width > MAX_IMAGE_PIXELS || result.image.height > MAX_IMAGE_PIXELS) {
    return fail(`An image must be ${MAX_IMAGE_PIXELS.toLocaleString()} pixels or fewer on each side.`);
  }

  return result;
}

/** Is this something `decodeImage` will take? Used where only yes/no matters. */
export const isEmbeddableImage = (source: string): boolean => decodeImage(source).ok;

/**
 * The size an image is drawn at, in points, given a width to fit it to.
 *
 * Aspect ratio is never a template's to choose: a logo squashed to fit a box
 * is worse than one that ends up shorter than expected, so height always
 * follows from width.
 */
export function imageBox(image: { width: number; height: number }, width: number): { width: number; height: number } {
  const ratio = image.height / image.width;
  return { width, height: Math.max(1, width * ratio) };
}

/* -------------------------------- encoding -------------------------------- */

/*
 * Writing a PNG, which is the other half of making a logo embeddable.
 *
 * Anything with transparency has to be flattened before it can go into a PDF,
 * and flattening means re-encoding. Re-encoding as JPEG would put ringing
 * around the edges of exactly the things logos are made of — type, hairlines,
 * flat fields of one colour — so the picture is written back out as a PNG
 * instead, losslessly, and the only compressor involved is the platform's own
 * `CompressionStream`. It emits a zlib stream, which is precisely what a PNG's
 * `IDAT` is.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(body.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Writes 8-bit RGB pixels as a PNG this app can turn around and embed.
 *
 * Every scanline uses filter 0. The adaptive filters earn their keep on
 * photographs; on a logo the runs are already long enough for deflate, and a
 * filter this file would also have to be able to reason about is a cost with
 * no matching benefit.
 */
export async function encodePng(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour, no alpha
  // Compression, filter and interlace methods: the format has exactly one of
  // each, and a PDF can only take the non-interlaced one.
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const chunks = [
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("IDAT", await deflate(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const file = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }
  return file;
}
