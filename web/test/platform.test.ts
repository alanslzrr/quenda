import assert from "node:assert/strict";
import test from "node:test";
import {
  continuityBody,
  invitationDates,
  municipalityBody,
} from "../src/features/platform/model.ts";

test("platform invitations require a future exact instant and omit operator role expiry", () => {
  const data = new FormData();
  assert.throws(() => invitationDates(data, "es"));
  data.set("expiresAt", "invalid");
  assert.throws(() => invitationDates(data, "es"));
  data.set("expiresAt", "2000-01-01T00:00:00Z");
  assert.throws(() => invitationDates(data, "es"));
  const future = new Date(Date.now() + 86400000).toISOString();
  data.set("expiresAt", future);
  assert.deepEqual(invitationDates(data, "es"), { expiresAt: future });
  assert.deepEqual(invitationDates(data, "es", true), {
    expiresAt: future,
    roleExpiresAt: null,
  });
  data.set("roleExpiresAtEntered", "2099-10-25T02:30");
  assert.throws(() => invitationDates(data, "gl", true));
  data.set("roleExpiresAt", future);
  assert.deepEqual(invitationDates(data, "es", true), {
    expiresAt: future,
    roleExpiresAt: future,
  });
  assert.deepEqual(invitationDates(data, "es"), { expiresAt: future });
});
test("municipality onboarding and continuity invitations are addressed to a trimmed email", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const data = new FormData();
  data.set("name", " Concello ");
  data.set("email", "  Primera@Example.test ");
  data.set("expiresAt", future);
  data.set("reason", " Relevo ");
  data.set("verificationReference", " Expediente 7 ");
  assert.deepEqual(municipalityBody(data, "Europe/Madrid", "es"), {
    name: "Concello",
    timezone: "Europe/Madrid",
    administratorEmail: "Primera@Example.test",
    invitationExpiresAt: future,
  });
  assert.deepEqual(continuityBody(data, "es", false), {
    email: "Primera@Example.test",
    expiresAt: future,
    reason: "Relevo",
  });
  assert.deepEqual(continuityBody(data, "gl", true), {
    email: "Primera@Example.test",
    expiresAt: future,
    reason: "Relevo",
    verificationReference: "Expediente 7",
  });
  data.delete("expiresAt");
  assert.throws(() => municipalityBody(data, "Europe/Madrid", "es"));
});
