/**
 * What may be put on a document, and what may not.
 *
 * This file's whole job is to be strict in the right places: a PDF reader
 * handed an image stream it cannot interpret shows a broken page or nothing at
 * all, and the failure happens on a customer's screen rather than ours. So the
 * tests are mostly about refusals — and about the refusals carrying a sentence
 * that says what to do, because the uploader does exactly that thing.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_IMAGE_BYTES,
  decodeImage,
  encodePng,
  imageBox,
  parseDataUrl,
  toDataUrl,
} from "./image";

/* ------------------------------- fixtures -------------------------------- */

/** A real PNG, written by the encoder the image picker uses. */
async function png(width = 4, height = 3): Promise<string> {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = 200;
    rgb[i + 1] = 30;
    rgb[i + 2] = 60;
  }
  return toDataUrl(await encodePng(rgb, width, height), "image/png");
}

/**
 * A PNG assembled chunk by chunk, for the shapes the encoder cannot produce.
 *
 * CRCs are left at zero: nothing in the decoder checks them, because a
 * corrupted image is the file's problem and a PDF reader will say so more
 * clearly than we can.
 */
function craftedPng(
  header: Partial<{ colorType: number; bitDepth: number; interlace: number }>,
  extra: { type: string; body: number[] }[] = [],
): string {
  const chunk = (type: string, body: number[]): number[] => [
    (body.length >> 24) & 0xff,
    (body.length >> 16) & 0xff,
    (body.length >> 8) & 0xff,
    body.length & 0xff,
    ...[...type].map(character => character.charCodeAt(0)),
    ...body,
    0,
    0,
    0,
    0,
  ];

  const ihdr = [
    0, 0, 0, 8, // width
    0, 0, 0, 8, // height
    header.bitDepth ?? 8,
    header.colorType ?? 6,
    0,
    0,
    header.interlace ?? 0,
  ];

  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...extra.flatMap(entry => chunk(entry.type, entry.body)),
    ...chunk("IDAT", [0x78, 0x9c, 0x01]),
    ...chunk("IEND", []),
  ]);

  return toDataUrl(bytes, "image/png");
}

/** A JPEG's frame header, which is all this app reads of one. */
function craftedJpeg(marker: number, components = 3, precision = 8): string {
  const bytes = Uint8Array.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // a short APP0, to be skipped
    0xff, marker, 0x00, 0x11,
    precision,
    0x00, 0x40, // height 64
    0x00, 0x80, // width 128
    components,
    ...Array<number>(components * 3).fill(1),
    0xff, 0xda, // SOS
  ]);
  return toDataUrl(bytes, "image/jpeg");
}

/* ------------------------------- data URLs -------------------------------- */

describe("data URLs", () => {
  test("round trip through base64", () => {
    const bytes = Uint8Array.from([1, 2, 3, 250, 251, 252]);
    const parsed = parseDataUrl(toDataUrl(bytes, "image/png"));
    expect(parsed?.mediaType).toBe("image/png");
    expect([...(parsed?.bytes ?? [])]).toEqual([...bytes]);
  });

  test("a URL that is not base64 is refused rather than guessed at", () => {
    // Percent-encoded binary is a way of storing the same picture twice as
    // large, and every producer we care about emits base64.
    expect(parseDataUrl("data:image/png,%89PNG")).toBeNull();
    expect(parseDataUrl("https://example.com/logo.png")).toBeNull();
  });
});

/* --------------------------------- PNG ------------------------------------ */

describe("PNG", () => {
  test("a truecolour PNG is embedded as its own bytes", async () => {
    const result = decodeImage(await png(4, 3));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.width).toBe(4);
    expect(result.image.height).toBe(3);
    // Nothing is decoded or re-encoded: the stream is the file's IDAT, and the
    // predictor is what tells a reader to undo the PNG's own filtering.
    expect(result.image.filter).toBe("FlateDecode");
    expect(result.image.colorSpace.kind).toBe("rgb");
    expect(result.image.predictor).toEqual({ predictor: 15, colors: 3, bitsPerComponent: 8, columns: 4 });
  });

  test("transparency is refused, with the fix in the message", () => {
    for (const colorType of [4, 6]) {
      const result = decodeImage(craftedPng({ colorType }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("flatten");
    }
  });

  test("an interlaced PNG is refused", () => {
    const result = decodeImage(craftedPng({ colorType: 2, interlace: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Interlaced");
  });

  test("a paletted PNG carries its palette into an indexed colour space", () => {
    // Built by hand because the encoder only writes truecolour. Three entries,
    // so the highest index a reader may see is 2.
    const result = decodeImage(
      craftedPng({ colorType: 3, bitDepth: 8 }, [{ type: "PLTE", body: [255, 0, 0, 0, 255, 0, 0, 0, 255] }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.colorSpace).toEqual({
      kind: "indexed",
      hival: 2,
      palette: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
    });
    // One component per pixel, whatever the palette holds.
    expect(result.image.predictor?.colors).toBe(1);
  });

  test("a PNG that claims a palette without carrying one is refused", () => {
    const result = decodeImage(craftedPng({ colorType: 3, bitDepth: 8 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("palette");
  });

  test("transparency in a palette is refused too, not silently printed black", () => {
    const result = decodeImage(
      craftedPng({ colorType: 3, bitDepth: 8 }, [
        { type: "PLTE", body: [255, 0, 0] },
        { type: "tRNS", body: [0] },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("flatten");
  });
});

/* --------------------------------- JPEG ----------------------------------- */

describe("JPEG", () => {
  test("a baseline JPEG is embedded as DCTDecode, at the size in its frame header", () => {
    const result = decodeImage(craftedJpeg(0xc0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.filter).toBe("DCTDecode");
    expect(result.image.width).toBe(128);
    expect(result.image.height).toBe(64);
    expect(result.image.colorSpace.kind).toBe("rgb");
    // A JPEG needs no predictor: the filter is the format.
    expect(result.image.predictor).toBeUndefined();
  });

  test("a greyscale JPEG is DeviceGray rather than assumed to be colour", () => {
    const result = decodeImage(craftedJpeg(0xc0, 1));
    expect(result.ok && result.image.colorSpace.kind).toBe("gray");
  });

  test("a progressive JPEG is refused, because readers will not draw it", () => {
    const result = decodeImage(craftedJpeg(0xc2));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("baseline");
  });

  test("a CMYK JPEG is refused rather than printed with its colours inverted", () => {
    const result = decodeImage(craftedJpeg(0xc0, 4));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("RGB");
  });
});

/* -------------------------------- limits ---------------------------------- */

describe("limits", () => {
  test("anything that is not a PNG or a JPEG is refused by name", () => {
    const result = decodeImage(toDataUrl(Uint8Array.from([0, 1, 2]), "image/gif" as never));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("PNG or a JPEG");
  });

  test("an oversized image is refused before it is parsed", () => {
    const huge = `data:image/png;base64,${"A".repeat(Math.ceil((MAX_IMAGE_BYTES + 1000) / 3) * 4)}`;
    const result = decodeImage(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("kB or smaller");
  });

  test("a file that lies about what it is fails as a sentence, not a throw", () => {
    const result = decodeImage(toDataUrl(Uint8Array.from([1, 2, 3, 4]), "image/png"));
    expect(result.ok).toBe(false);
  });
});

/* ------------------------------- geometry --------------------------------- */

describe("sizing", () => {
  test("height follows width, so nothing is ever stretched", () => {
    expect(imageBox({ width: 200, height: 50 }, 120)).toEqual({ width: 120, height: 30 });
    expect(imageBox({ width: 50, height: 200 }, 25)).toEqual({ width: 25, height: 100 });
  });
});

/* ------------------------------- encoding --------------------------------- */

describe("the encoder", () => {
  test("what it writes is what the decoder takes", async () => {
    // The two halves of the feature: the browser flattens an image with this,
    // and the PDF writer embeds the result. A disagreement between them would
    // mean a logo that uploads and then cannot be drawn.
    const result = decodeImage(await png(17, 5));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(17);
    expect(result.image.height).toBe(5);
    expect(result.image.bitsPerComponent).toBe(8);
  });

  test("a flat picture compresses to far less than its pixels", async () => {
    // Not a compression benchmark: it is the check that the deflate stream is
    // real rather than a stored copy of the raw scanlines.
    const source = await png(400, 400);
    const result = decodeImage(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.byteLength).toBeLessThan((400 * 400 * 3) / 10);
  });
});
