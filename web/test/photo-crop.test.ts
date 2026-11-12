import assert from "node:assert/strict";
import test from "node:test";
import {
  centred,
  clampCrop,
  cropRect,
  framePlacement,
  fullFrame,
  largeEnough,
  maximumZoom,
  outputSize,
  pan,
} from "../src/features/municipal/photo-crop.ts";

test("the full frame is the largest 3:2 rectangle of any image", () => {
  assert.deepEqual(fullFrame(4000, 3000), { width: 4000, height: 4000 / 1.5 });
  assert.deepEqual(fullFrame(6000, 2000), { width: 3000, height: 2000 });
  // A portrait photo keeps its full width and loses height.
  assert.deepEqual(fullFrame(3000, 4000), { width: 3000, height: 2000 });
});

test("small images are refused and zoom stops at the minimum crop width", () => {
  assert.equal(largeEnough(899, 600), false);
  assert.equal(largeEnough(1200, 500), false);
  assert.equal(largeEnough(900, 600), true);
  assert.equal(maximumZoom(900, 600), 1);
  assert.equal(maximumZoom(1800, 1200), 2);
  assert.equal(maximumZoom(12000, 8000), 4);
  const rect = cropRect(1800, 1200, { x: 900, y: 600, zoom: 10 });
  assert.equal(rect.width, 900);
  assert.equal(rect.height, 600);
});

test("the frame never leaves the image", () => {
  const crop = clampCrop(3000, 4000, { x: -500, y: 99999, zoom: 1 });
  const rect = cropRect(3000, 4000, crop);
  assert.deepEqual(rect, { x: 0, y: 2000, width: 3000, height: 2000 });
  // Dragging the photo right shows more of its left side, never beyond the edge.
  const moved = pan(
    3000,
    2000,
    { ...centred(3000, 2000), zoom: 2 },
    400,
    0,
    300,
  );
  assert.equal(cropRect(3000, 2000, moved).x, 0);
});

test("the upload keeps the frame's resolution up to 2400 pixels", () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 1000, height: 666.6 }), {
    width: 1000,
    height: 667,
  });
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 4000, height: 2666 }), {
    width: 2400,
    height: 1600,
  });
});

test("the placement draws the crop exactly over the frame", () => {
  const placement = framePlacement(4000, 3000, { x: 1000, y: 1000, zoom: 2 });
  // The frame is 2000 × 1333.3 at zoom 2, so the image is twice as wide as the frame.
  assert.equal(placement.width, "200%");
  assert.equal(placement.left, "0%");
  assert.match(placement.top, /^-\d/);
});
