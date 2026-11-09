import assert from "node:assert/strict";
import test from "node:test";
import {
  clockOffset,
  recordServerDate,
  serverNow,
} from "../src/app/server-clock.ts";

test("the offset corrects a browser clock that runs behind or ahead", () => {
  const local = Date.parse("2026-11-06T10:00:00.000Z");
  assert.equal(clockOffset("2026-11-06T10:05:00.000Z", local), 300_000);
  assert.equal(clockOffset("2026-11-06T09:55:00.000Z", local), -300_000);
});

test("an unusable server time leaves the browser clock untouched", () => {
  assert.equal(clockOffset("not a date", 1), 0);
  assert.equal(clockOffset("", 1), 0);
  assert.equal(clockOffset(null, 1), 0);
});

test("the Date header of any response teaches the clock, and absurd values are ignored", () => {
  const local = Date.now();
  recordServerDate(new Date(local + 120_000).toUTCString(), local);
  assert.ok(Math.abs(serverNow() - (Date.now() + 120_000)) < 1500);
  recordServerDate(null, local);
  recordServerDate(
    new Date(local + 10 * 24 * 60 * 60 * 1000).toUTCString(),
    local,
  );
  assert.ok(Math.abs(serverNow() - (Date.now() + 120_000)) < 1500);
  recordServerDate(new Date(local).toUTCString(), local);
});
