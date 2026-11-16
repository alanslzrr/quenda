import sharp from "sharp";
import { HttpError } from "../../http/errors.ts";
import { rasterFormat, withImageSlot } from "../../shared/raster.ts";

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
  const detected = rasterFormat(input);
  if (!detected) throw new HttpError("PHOTO_INVALID");
  return withImageSlot(async () => {
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
