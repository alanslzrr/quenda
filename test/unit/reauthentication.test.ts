import assert from "node:assert/strict";
import test from "node:test";
import { requireRecentMfa } from "../../src/modules/identity/index.ts";

const now = new Date("2026-10-19T12:00:00Z");
const clock = { now: () => now };
const account = {
  accountId: "account",
  email: "account@example.test",
  sessionId: "session",
  mfaVerifiedAt: now,
};
test("sensitive operations require a finite, recent and non-future session MFA proof", () => {
  requireRecentMfa(account, clock);
  requireRecentMfa(
    { ...account, mfaVerifiedAt: new Date(now.getTime() - 299999) },
    clock,
  );
  for (const time of [
    new Date(now.getTime() - 300000),
    new Date(now.getTime() + 1),
    new Date(Number.NaN),
  ]) {
    assert.throws(
      () => requireRecentMfa({ ...account, mfaVerifiedAt: time }, clock),
      { code: "REAUTHENTICATION_REQUIRED" },
    );
  }
  assert.throws(
    () => requireRecentMfa({ ...account, mfaVerifiedAt: null }, clock),
    { code: "FORBIDDEN" },
  );
});
