/**
 * Preparing a chosen file.
 *
 * Most of this module is a canvas, which only a browser has — but its first
 * decision is not, and it is the one worth pinning down: an image that a PDF
 * would already accept is kept **byte for byte**. Re-encoding a logo that was
 * fine is a way of making it slightly worse for no reason, and it is the kind
 * of thing a later refactor quietly turns on.
 */
import { describe, expect, test } from "bun:test";
import { decodeImage, encodePng, parseDataUrl, toDataUrl } from "./image";
import { describeSize, prepareImageFile } from "./imageFile";

const pngBytes = async (width = 6, height = 4): Promise<Uint8Array> =>
  encodePng(new Uint8Array(width * height * 3).fill(40), width, height);

describe("preparing an image", () => {
  test("a PNG a PDF can already carry is kept exactly as it is", async () => {
    const bytes = await pngBytes();
    const file = new Blob([bytes as unknown as BlobPart], { type: "image/png" });

    const result = await prepareImageFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.width).toBe(6);
    expect(result.image.height).toBe(4);
    // The same bytes, not a canvas's idea of them.
    expect([...(parseDataUrl(result.image.source)?.bytes ?? [])]).toEqual([...bytes]);
    // Nothing was done to it, so there is nothing to tell the person about.
    expect(result.image.note).toBeUndefined();
  });

  test("what it returns is always something the renderer accepts", async () => {
    const file = new Blob([(await pngBytes(11, 7)) as unknown as BlobPart], { type: "image/png" });
    const result = await prepareImageFile(file);
    expect(result.ok && decodeImage(result.image.source).ok).toBe(true);
  });

  test("a file that is not an image at all fails as a sentence", async () => {
    // No canvas here, so this is the browser-free half of the fallback: a blob
    // that is not an image cannot be decoded and must not throw.
    const file = new Blob(["not an image"], { type: "text/plain" });
    const result = await prepareImageFile(file);
    expect(result.ok).toBe(false);
  });
});

describe("describing a size", () => {
  test("reads the way a person writes one", () => {
    expect(describeSize(900)).toBe("1 kB");
    expect(describeSize(42_000)).toBe("42 kB");
    expect(describeSize(1_400_000)).toBe("1.4 MB");
  });
});

describe("round trip", () => {
  test("the encoder's output is a data URL the decoder reads back", async () => {
    const source = toDataUrl(await pngBytes(3, 3), "image/png");
    const decoded = decodeImage(source);
    expect(decoded.ok).toBe(true);
  });
});
