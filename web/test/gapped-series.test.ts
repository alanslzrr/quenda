import assert from "node:assert/strict";
import test from "node:test";
import {
  continuousRuns,
  gappedArea,
  gappedCurve,
  gappedPath,
  lastValueIndex,
  mixGapped,
  sampleAt,
} from "../src/ui/lib/gapped-series.ts";

test("a series splits into continuous runs around missing values", () => {
  assert.deepEqual(continuousRuns([1, 2, null, 4, undefined, Number.NaN, 7]), [
    { start: 0, end: 1 },
    { start: 3, end: 3 },
    { start: 6, end: 6 },
  ]);
  assert.deepEqual(continuousRuns([null, null]), []);
  assert.deepEqual(continuousRuns([0, 0]), [{ start: 0, end: 1 }]);
});

test("a missing value leaves a gap in the curve, never a zero", () => {
  for (const smooth of [true, false]) {
    const curve = gappedCurve([10, 20, null, 40, 50], smooth);
    const gap = curve.filter(([, value]) => Number.isNaN(value));
    assert.deepEqual(
      gap.map(([x]) => x),
      [0.5],
    );
    assert.ok(curve.every(([, value]) => Number.isNaN(value) || value >= 10));
    assert.ok(
      curve.every(
        ([x], index) => index === 0 || x > (curve[index - 1]?.[0] ?? -1),
      ),
      "x keeps increasing",
    );
  }
});

test("smoothing stays within the data and never bridges a gap", () => {
  const curve = gappedCurve([5, 50, 5, null, 5, 50], true);
  for (const [x, value] of curve)
    if (Number.isFinite(value))
      assert.ok(value >= 5 && value <= 50, `${x}: ${value}`);
  assert.ok(Number.isNaN(sampleAt(curve, 0.5)));
  assert.ok(Number.isNaN(sampleAt(curve, 0.7)));
  assert.equal(sampleAt(curve, 0), 5);
  assert.equal(sampleAt(curve, 1), 50);
});

test("a lone series value spans the width and a lone missing value draws nothing", () => {
  assert.deepEqual(gappedCurve([7], true), [
    [0, 7],
    [1, 7],
  ]);
  assert.deepEqual(gappedCurve([null], true), []);
  assert.deepEqual(gappedCurve([], false), []);
  assert.ok(Number.isNaN(sampleAt([], 0.5)));
});

test("paths start a new subpath after each gap and draw an isolated value as a dot", () => {
  const path = gappedPath([
    [0, 10],
    [10, 20],
    [20, Number.NaN],
    [30, 5],
    [40, Number.NaN],
  ]);
  assert.equal(path, "M0.0,10.0L10.0,20.0M30.0,5.0L30.0,5.0");
  assert.equal(gappedPath([[0, Number.NaN]]), "");
});

test("areas close each stretch to the baseline and skip isolated values", () => {
  const area = gappedArea(
    [
      [0, 10],
      [10, 20],
      [20, Number.NaN],
      [30, 5],
    ],
    100,
  );
  assert.equal(area, "M0.0,10.0L10.0,20.0L10.0,100.0L0.0,100.0Z");
});

test("a morph opens target gaps at once and lets values arrive in place", () => {
  assert.ok(Number.isNaN(mixGapped(3, Number.NaN, 0.2)));
  assert.equal(mixGapped(Number.NaN, 8, 0.2), 8);
  assert.equal(mixGapped(0, 10, 0.5), 5);
});

test("the latest present value is found behind trailing gaps", () => {
  assert.equal(lastValueIndex([1, 2, null, null]), 1);
  assert.equal(lastValueIndex([null, null]), -1);
  assert.equal(lastValueIndex([1, null, 3], 1), 0);
});
