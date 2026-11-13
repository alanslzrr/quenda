import assert from "node:assert/strict";
import test from "node:test";
import { barStats } from "../src/ui/bar-chart/stats.ts";

test("bar statistics skip missing values instead of counting zeros", () => {
  assert.deepEqual(barStats([10, null, 30, undefined]), {
    average: 20,
    peak: 30,
    highest: 2,
    lowest: 0,
    count: 2,
  });
  assert.deepEqual(barStats([null, null]), {
    average: null,
    peak: 0,
    highest: -1,
    lowest: -1,
    count: 0,
  });
  assert.equal(barStats([0, 0]).average, 0);
  assert.equal(
    barStats([Number.MAX_VALUE, Number.MAX_VALUE]).average,
    Number.MAX_VALUE,
  );
});
