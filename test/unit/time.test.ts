import assert from "node:assert/strict";
import test from "node:test";
import {
  describeInstant,
  possibleLocalInstants,
  withinAdvanceWindow,
} from "../../src/modules/catalog/time.ts";

test("Madrid DST gaps disappear and repeated hours retain both exact instants and offsets", () => {
  assert.deepEqual(
    possibleLocalInstants("2026-03-29", 150, "Europe/Madrid"),
    [],
  );
  const repeated = possibleLocalInstants("2026-10-25", 150, "Europe/Madrid");
  assert.deepEqual(
    repeated.map((row) => [row.utc, row.offset]),
    [
      ["2026-10-25T00:30:00.000Z", "+02:00"],
      ["2026-10-25T01:30:00.000Z", "+01:00"],
    ],
  );
  assert.ok(repeated.every((row) => row.local === "2026-10-25T02:30"));
  for (const value of repeated)
    assert.deepEqual(describeInstant(value.utc, "Europe/Madrid"), value);
  assert.equal(
    possibleLocalInstants("2026-10-26", 150, "Europe/Madrid").length,
    1,
  );
});

test("non-hour transitions and whole skipped civil dates are not approximated", () => {
  const repeated = possibleLocalInstants(
    "2026-04-05",
    105,
    "Australia/Lord_Howe",
  );
  assert.deepEqual(
    repeated.map((row) => row.offset),
    ["+11:00", "+10:30"],
  );
  assert.deepEqual(
    possibleLocalInstants("2026-10-04", 135, "Australia/Lord_Howe"),
    [],
  );
  assert.deepEqual(
    possibleLocalInstants("2011-12-30", 720, "Pacific/Apia"),
    [],
  );
});

test("minute 1440 denotes next civil midnight, independent of process timezone", () => {
  assert.equal(
    possibleLocalInstants("2026-03-29", 1440, "Europe/Madrid")[0]?.utc,
    "2026-03-29T22:00:00.000Z",
  );
  assert.equal(
    possibleLocalInstants("2026-10-25", 1440, "Europe/Madrid")[0]?.utc,
    "2026-10-25T23:00:00.000Z",
  );
});

test("advance limits use local calendar dates, not multiples of 24 elapsed hours", () => {
  const now = "2026-03-28T11:00:00Z";
  assert.equal(
    withinAdvanceWindow("2026-03-29T21:59:00Z", now, "Europe/Madrid", 1, null),
    true,
  );
  assert.equal(
    withinAdvanceWindow("2026-03-29T22:00:00Z", now, "Europe/Madrid", 1, null),
    false,
  );
  assert.equal(
    withinAdvanceWindow("2026-04-27T21:59:00Z", now, "Europe/Madrid", 30, null),
    true,
  );
  assert.equal(
    withinAdvanceWindow("2026-04-27T22:00:00Z", now, "Europe/Madrid", 30, null),
    false,
  );
  assert.equal(
    withinAdvanceWindow("2026-03-29T10:00:00Z", now, "Europe/Madrid", 30, 0),
    false,
  );
  assert.equal(
    withinAdvanceWindow("2026-03-28T12:00:00Z", now, "Europe/Madrid", 0, null),
    true,
  );
  assert.equal(withinAdvanceWindow(now, now, "Europe/Madrid", 30, null), false);
  assert.equal(
    withinAdvanceWindow("2026-03-28T10:59:59Z", now, "Europe/Madrid", 30, null),
    false,
  );
  assert.equal(
    withinAdvanceWindow(
      "2026-01-01T10:30:00Z",
      "2026-01-01T10:00:00Z",
      "Pacific/Kiritimati",
      0,
      null,
    ),
    true,
  );
  assert.equal(
    withinAdvanceWindow(
      "2026-10-25T22:59:00Z",
      "2026-10-24T10:00:00Z",
      "Europe/Madrid",
      1,
      null,
    ),
    true,
  );
});

test("invalid dates, zones, offset-only zones and invalid advance overrides fail closed", () => {
  for (const zone of ["No/SuchZone", "+02:00", ""])
    assert.throws(() => possibleLocalInstants("2026-10-19", 600, zone), {
      code: "INVALID_INPUT",
    });
  assert.throws(
    () => possibleLocalInstants("2026-02-29", 600, "Europe/Madrid"),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () => possibleLocalInstants("2026-10-19", 1441, "Europe/Madrid"),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      withinAdvanceWindow(
        "2026-10-20T10:00:00Z",
        "2026-10-19T10:00:00Z",
        "Europe/Madrid",
        30,
        31,
      ),
    { code: "INVALID_INPUT" },
  );
  assert.throws(() => describeInstant("2026-10-19T10:00:00", "Europe/Madrid"), {
    code: "INVALID_INPUT",
  });
});
