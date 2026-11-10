import assert from "node:assert/strict";
import test from "node:test";
import jsQR from "jsqr";
import {
  accessCodeModules,
  accessCodeTarget,
} from "../src/features/reservations/access-code-model.ts";

// Rasterises the matrix the component draws and reads it back with an
// independent decoder, as a phone camera would.
test("the access code decodes to the staff page of the reservation", () => {
  const url = accessCodeTarget(
    "https://reservas.example.org",
    "00000000-0000-4000-8000-000000000101",
    "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  );
  assert.equal(
    url,
    "https://reservas.example.org/administracion/00000000-0000-4000-8000-000000000101/reservas/7c9e6679-7425-40de-944b-e07fc1f90ae7",
  );
  const { data, size } = accessCodeModules(url);
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const dark = data[Math.floor(y / scale)]?.[Math.floor(x / scale)];
      const offset = (y * width + x) * 4;
      pixels.fill(dark ? 0 : 255, offset, offset + 3);
      pixels[offset + 3] = 255;
    }
  assert.equal(jsQR(pixels, width, width)?.data, url);
});
