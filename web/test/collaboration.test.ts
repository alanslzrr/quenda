import assert from "node:assert/strict";
import test from "node:test";
import {
  civilOptions,
  civilValue,
  validParticipants,
  validZone,
} from "../src/features/collaboration/model.ts";

const own = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002",
  unit = "00000000-0000-4000-8000-000000000003";
test("agreement cloning preserves seconds, milliseconds and the selected occurrence of a repeated hour", () => {
  for (const instant of [
    "2026-10-25T00:30:21.123Z",
    "2026-10-25T01:30:21.123Z",
  ]) {
    const value = civilValue(instant, "Europe/Madrid");
    assert.equal(value, "2026-10-25T02:30:21.123");
    assert.ok(
      civilOptions(value, "Europe/Madrid").some((o) => o.utc === instant),
    );
    assert.equal(civilOptions(value, "Europe/Madrid").length, 2);
  }
  assert.equal(
    civilValue("2026-11-16T23:00:00.000Z", "Europe/Madrid"),
    "2026-11-17T00:00",
  );
  assert.deepEqual(civilOptions("2026-03-29T02:30", "Europe/Madrid"), []);
  assert.deepEqual(civilOptions("2026-02-30T10:00", "Europe/Madrid"), []);
  assert.deepEqual(civilOptions("2026-10-23T10:00", "Invalid/Zone"), []);
  assert.equal(validZone("Invalid/Zone"), false);
  assert.equal(validZone("+01:00"), false);
  assert.equal(validZone("Europe/Madrid"), true);
});
test("participants include the acting municipality without duplicate tenants or units", () => {
  const a = { tenantId: own, accreditationIssuer: true, unitIds: [unit] };
  const b = { tenantId: other, accreditationIssuer: false, unitIds: [] };
  assert.equal(validParticipants([a, b], own), true);
  assert.equal(validParticipants([b], own), false);
  assert.equal(validParticipants([a, a], own), false);
  assert.equal(validParticipants([a, { ...b, unitIds: [unit] }], own), false);
  assert.equal(validParticipants([{ ...a, unitIds: ["invalid"] }], own), false);
});
