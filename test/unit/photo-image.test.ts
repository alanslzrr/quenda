import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { processPhoto } from "../../src/modules/catalog/photo-image.ts";

const picture = (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" = "jpeg",
) =>
  sharp({
    create: { width, height, channels: 3, background: "#3a7d44" },
  })
    [format]()
    .toBuffer();

test("a landscape photo becomes two 3:2 WebP sizes", async () => {
  const photo = await processPhoto(await picture(4000, 3000));
  assert.deepEqual([photo.width, photo.height], [1500, 1000]);
  const large = await sharp(photo.large).metadata();
  const small = await sharp(photo.small).metadata();
  assert.equal(large.format, "webp");
  assert.deepEqual([large.width, large.height], [1500, 1000]);
  assert.deepEqual([small.width, small.height], [600, 400]);
});

test("a photo that is only slightly larger than the minimum is not enlarged", async () => {
  const photo = await processPhoto(await picture(1200, 800, "png"));
  assert.deepEqual([photo.width, photo.height], [1200, 800]);
  const large = await sharp(photo.large).metadata();
  assert.deepEqual([large.width, large.height], [1200, 800]);
});

test("camera metadata and location are removed and orientation is applied", async () => {
  // Stored 3000 × 4500 with orientation 6: the camera was turned, the scene is landscape.
  const turned = await sharp({
    create: { width: 3000, height: 4500, channels: 3, background: "#204060" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Synthetic", Model: "Test camera" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "43/1 22/1 0/1" },
    })
    .toBuffer();
  const original = await sharp(turned).metadata();
  assert.ok(original.exif);
  assert.equal(original.orientation, 6);
  const photo = await processPhoto(turned);
  assert.deepEqual([photo.width, photo.height], [1500, 1000]);
  for (const output of [photo.large, photo.small]) {
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.orientation, undefined);
  }
});

test("portrait, square, small and non-image uploads are refused", async () => {
  for (const input of [
    await picture(800, 1200),
    await picture(1600, 1600),
    await picture(1100, 1000),
    await picture(800, 533),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"/>',
    ),
    Buffer.from("GIF89a"),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]),
  ])
    await assert.rejects(processPhoto(input), { code: "PHOTO_INVALID" });
  // A PNG that declares an enormous canvas is refused before it is decoded.
  const bomb = await sharp({
    create: { width: 10000, height: 6000, channels: 3, background: "#000" },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await assert.rejects(processPhoto(bomb), { code: "PHOTO_INVALID" });
  await assert.rejects(processPhoto(Buffer.alloc(6 * 1024 * 1024 + 1)), {
    code: "PAYLOAD_TOO_LARGE",
  });
});
