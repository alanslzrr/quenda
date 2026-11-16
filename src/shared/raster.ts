/** Shared guards for the images the server re-encodes: catalog photos and municipal logos. */

// Formats are recognised by their signature before any decoder runs, so a file
// named .jpg that is SVG, HEIC, TIFF or anything else never reaches libvips.
export function rasterFormat(input: Buffer): "jpeg" | "png" | "webp" | null {
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
export async function withImageSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}
