// Framing of a photo at 3:2 before it is uploaded. Coordinates are in pixels of
// the original image, so the result does not depend on the size of the screen.

export const photoRatio = 3 / 2;
/** The server refuses a crop narrower than this. */
export const minimumCropWidth = 900;
/** What the editor recommends, and the size of the large image the public sees. */
export const recommendedWidth = 1500;
/** Uploads are resized to at most this width before they leave the browser. */
export const uploadWidth = 2400;

export interface Crop {
  /** Centre of the frame, in pixels of the original image. */
  x: number;
  y: number;
  /** 1 shows the largest 3:2 frame that fits; more is closer. */
  zoom: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The largest 3:2 frame that fits in the image. */
export function fullFrame(width: number, height: number) {
  return width / height >= photoRatio
    ? { width: height * photoRatio, height }
    : { width, height: width / photoRatio };
}

/** Whether the image leaves enough pixels for an acceptable 3:2 photo. */
export const largeEnough = (width: number, height: number) =>
  fullFrame(width, height).width >= minimumCropWidth;

/** Closer than this, the frame would fall below the minimum width. */
export function maximumZoom(width: number, height: number) {
  return Math.max(
    1,
    Math.min(4, fullFrame(width, height).width / minimumCropWidth),
  );
}

export const centred = (width: number, height: number): Crop => ({
  x: width / 2,
  y: height / 2,
  zoom: 1,
});

/** Keeps the zoom within its limits and the frame inside the image. */
export function clampCrop(width: number, height: number, crop: Crop): Crop {
  const zoom = Math.min(maximumZoom(width, height), Math.max(1, crop.zoom));
  const frame = fullFrame(width, height);
  const halfWidth = frame.width / zoom / 2;
  const halfHeight = frame.height / zoom / 2;
  return {
    zoom,
    x: Math.min(width - halfWidth, Math.max(halfWidth, crop.x)),
    y: Math.min(height - halfHeight, Math.max(halfHeight, crop.y)),
  };
}

export function cropRect(width: number, height: number, crop: Crop): Rect {
  const { x, y, zoom } = clampCrop(width, height, crop);
  const frame = fullFrame(width, height);
  const w = frame.width / zoom;
  const h = frame.height / zoom;
  return { x: x - w / 2, y: y - h / 2, width: w, height: h };
}

/** The uploaded image: the frame at its own resolution, never wider than uploadWidth. */
export function outputSize(rect: Rect) {
  const width = Math.min(uploadWidth, Math.floor(rect.width));
  return { width, height: Math.round(width / photoRatio) };
}

/**
 * Where to draw the whole image inside a 3:2 frame so that the crop fills it,
 * as percentages of the frame: the same style works for any frame size.
 */
export function framePlacement(width: number, height: number, crop: Crop) {
  const rect = cropRect(width, height, crop);
  return {
    width: `${(width / rect.width) * 100}%`,
    height: `${(height / rect.height) * 100}%`,
    left: `${(-rect.x / rect.width) * 100}%`,
    top: `${(-rect.y / rect.height) * 100}%`,
  };
}

/** Moves the frame by a distance measured on screen, in a frame shown `frameWidth` pixels wide. */
export function pan(
  width: number,
  height: number,
  crop: Crop,
  dx: number,
  dy: number,
  frameWidth: number,
): Crop {
  const rect = cropRect(width, height, crop);
  const scale = rect.width / frameWidth;
  return clampCrop(width, height, {
    ...crop,
    x: crop.x - dx * scale,
    y: crop.y - dy * scale,
  });
}
