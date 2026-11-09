import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration } from "../src/features/catalog/dates.ts";

test("only positive whole minutes are accepted from the URL", () => {
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("1"), 1);
  for (const value of [
    "0",
    "-5",
    "0.5",
    "1e3",
    "Infinity",
    "NaN",
    "",
    " 60",
    "60 ",
    "12345678901",
    null,
  ])
    assert.equal(parseDuration(value), undefined, String(value));
});
