import assert from "node:assert/strict";
import test from "node:test";
import { gappedCurve } from "../src/ui/lib/gapped-series.ts";
import { sparkGeometry, unitValues } from "../src/ui/sparkline/geometry.ts";

test("sparkline values scale between their own extremes and keep gaps", () => {
  assert.deepEqual(unitValues([10, null, 30, 20]), [0, null, 1, 0.5]);
  assert.deepEqual(unitValues([4, 4]), [0.5, 0.5]);
  assert.deepEqual(unitValues([null]), [null]);
});

test("the sparkline end dot disappears while the cursor sits in a gap", () => {
  const shape = gappedCurve([0, 1, null], true, 128);
  assert.equal(sparkGeometry(shape, 100, 20, 1).dot, "");
  assert.notEqual(sparkGeometry(shape, 100, 20, 0.5).dot, "");
  assert.match(sparkGeometry(shape, 100, 20, 0).line, /^M/);
});
