import assert from "node:assert/strict";
import test from "node:test";
import { completeAcceptanceEvidence } from "../../src/modules/reservations/acceptance.ts";

test("cached genuine acceptance keeps its original unit without consulting current state", () => {
  const cached = {
    unitId: "original-unit",
    usageRulesVersion: 4,
    rulesAcceptedAt: "2026-10-20T10:00:00.000Z",
    bookingPolicyVersion: 2,
    conditionsAcceptedAt: "2026-10-20T10:00:00.000Z",
    nonCancellableAccepted: false,
  };
  const before = structuredClone(cached);
  const result = completeAcceptanceEvidence(cached);
  assert.equal(result.usageRulesUnitId, "original-unit");
  assert.equal(result.pendingUsageRulesVersion, null);
  assert.equal(result.rulesAcceptedAt, cached.rulesAcceptedAt);
  assert.equal(result.bookingPolicyVersion, 2);
  assert.deepEqual(cached, before);
});

test("pre-acceptance cached results remain without evidence", () => {
  assert.deepEqual(completeAcceptanceEvidence({ unitId: "legacy-unit" }), {
    unitId: "legacy-unit",
    usageRulesUnitId: null,
    usageRulesVersion: null,
    rulesAcceptedAt: null,
    pendingUsageRulesVersion: null,
    bookingPolicyVersion: null,
    conditionsAcceptedAt: null,
    nonCancellableAccepted: null,
  });
});

test("relocated cached results preserve a distinct accepted unit and pending version", () => {
  const cached = {
    unitId: "destination-unit",
    usageRulesUnitId: "original-unit",
    usageRulesVersion: 4,
    rulesAcceptedAt: "2026-10-20T10:00:00.000Z",
    pendingUsageRulesVersion: 7,
    bookingPolicyVersion: null,
    conditionsAcceptedAt: null,
    nonCancellableAccepted: null,
  };
  assert.deepEqual(completeAcceptanceEvidence(cached), cached);
});
