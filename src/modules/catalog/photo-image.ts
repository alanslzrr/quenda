import sharp from "sharp";
import { HttpError } from "../../http/errors.ts";

/** Every catalog photo is shown at 3:2, the usual proportion of a landscape photograph. */
export const photoRatio = 3 / 2;
export const photoLarge = { width: 1500, height: 1000 } as const;
export const photoSmall = { width: 600, height: 400 } as const;
/** Smallest 3:2 crop that still looks sharp in the gallery. */
export const photoMinimum = { width: 900, height: 600 } as const;
/** A square or portrait image would lose too much when framed at 3:2. */
const minimumRatio = 1.3;
/** About 36 megapixels: any phone photograph, never a decompression bomb. */
const maximumPixels = 36_000_000;
export const photoMaximumBytes = 6 * 1024 * 1024;

// Formats are recognised by their signature before any decoder runs, so a file
// named .jpg that is SVG, HEIC, TIFF or anything else never reaches libvips.
function format(input: Buffer): "jpeg" | "png" | "webp" | null {
  if (
    input.length >= 3 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff
  )
    return "jpeg";
  if (
    input.length >= 8 &&
    input
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  if (
    input.length >= 12 &&
    input.toString("latin1", 0, 4) === "RIFF" &&
    input.toString("latin1", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}

// libvips may use a thread per core for each image; two at a time keeps an
// upload burst from starving the requests that serve bookings.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export interface ProcessedPhoto {
  width: number;
  height: number;
  large: Buffer;
  small: Buffer;
}

/**
 * Re-encodes an uploaded photograph as WebP in two sizes, centred at 3:2.
 * Orientation is applied and every metadatum (location, camera, profile) is
 * dropped. The upload itself is never stored.
 */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (input.length > photoMaximumBytes)
    throw new HttpError("PAYLOAD_TOO_LARGE");
  const detected = format(input);
  if (!detected) throw new HttpError("PHOTO_INVALID");
  return slot(async () => {
    const options = {
      limitInputPixels: maximumPixels,
      failOn: "error",
      animated: false,
    } as const;
    let width: number;
    let height: number;
    try {
      const metadata = await sharp(input, options).metadata();
      if (metadata.format !== detected || (metadata.pages ?? 1) > 1)
        throw new HttpError("PHOTO_INVALID");
      ({ width, height } = metadata.autoOrient);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("PHOTO_INVALID");
    }
    if (!width || !height || width / height < minimumRatio)
      throw new HttpError("PHOTO_INVALID");
    const crop =
      width / height >= photoRatio
        ? { width: Math.floor(height * photoRatio), height }
        : { width, height: Math.floor(width / photoRatio) };
    if (crop.width < photoMinimum.width || crop.height < photoMinimum.height)
      throw new HttpError("PHOTO_INVALID");
    const largeWidth = Math.min(photoLarge.width, crop.width);
    const large = {
      width: largeWidth,
      height: Math.round(largeWidth / photoRatio),
    };
    const encode = (size: { width: number; height: number }, quality: number) =>
      sharp(input, options)
        .autoOrient()
        .resize({ ...size, fit: "cover", position: "centre" })
        .webp({ quality, effort: 4 })
        .toBuffer();
    try {
      return {
        ...large,
        large: await encode(large, 80),
        small: await encode(photoSmall, 76),
      };
    } catch {
      throw new HttpError("PHOTO_INVALID");
    }
  });
}
