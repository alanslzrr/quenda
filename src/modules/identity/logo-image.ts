import sharp from "sharp";
import { HttpError } from "../../http/errors.ts";
import { rasterFormat, withImageSlot } from "../../shared/raster.ts";

export const logoMaximumBytes = 2 * 1024 * 1024;
/** The longest side the server keeps: sharp on a high-density sidebar or header. */
export const logoSide = 512;
/** A logo narrower than this on its shortest side would be blurry even in the sidebar. */
const minimumSide = 32;
/** Wider or taller than 4:1 would not fit the square space a logo is shown in. */
const maximumRatio = 4;
const maximumPixels = 25_000_000;

export interface ProcessedLogo {
  width: number;
  height: number;
  image: Buffer;
}

/**
 * Re-encodes an uploaded logo as WebP, at most 512 px on its longest side, keeping its proportions and
 * transparency. Only JPEG, PNG and WebP are accepted, recognised by their signature; vector formats such as SVG,
 * which may carry scripts, never reach the decoder. Every metadatum is dropped and the upload itself is never stored.
 */
export async function processLogo(input: Buffer): Promise<ProcessedLogo> {
  if (input.length > logoMaximumBytes) throw new HttpError("PAYLOAD_TOO_LARGE");
  const detected = rasterFormat(input);
  if (!detected) throw new HttpError("LOGO_INVALID");
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
        throw new HttpError("LOGO_INVALID");
      ({ width, height } = metadata.autoOrient);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("LOGO_INVALID");
    }
    if (
      !width ||
      !height ||
      Math.min(width, height) < minimumSide ||
      Math.max(width, height) / Math.min(width, height) > maximumRatio
    )
      throw new HttpError("LOGO_INVALID");
    try {
      const { data, info } = await sharp(input, options)
        .autoOrient()
        .resize({
          width: logoSide,
          height: logoSide,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 90, alphaQuality: 100, effort: 5 })
        .toBuffer({ resolveWithObject: true });
      if (Math.min(info.width, info.height) < minimumSide)
        throw new HttpError("LOGO_INVALID");
      return { width: info.width, height: info.height, image: data };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("LOGO_INVALID");
    }
  });
}
