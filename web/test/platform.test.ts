import assert from "node:assert/strict";
import test from "node:test";
import {
  continuityBody,
  invitationDates,
  municipalityBody,
  platformInvitationBody,
  suspendsOwnAccount,
  suspensionRequest,
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
test("operator and global privacy invitations are addressed to a trimmed email", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const data = new FormData();
  data.set("email", "  Operadora@Example.test ");
  data.set("expiresAt", future);
  data.set("reason", " Delegación aprobada ");
  data.set("accountId", "ignored-account");
  assert.deepEqual(platformInvitationBody(data, "es", false), {
    email: "Operadora@Example.test",
    expiresAt: future,
  });
  assert.deepEqual(platformInvitationBody(data, "gl", true, ["PRIVACY_READ"]), {
    email: "Operadora@Example.test",
    expiresAt: future,
    roleExpiresAt: null,
    permissions: ["PRIVACY_READ"],
    reason: "Delegación aprobada",
  });
  data.delete("expiresAt");
  assert.throws(() => platformInvitationBody(data, "es", false));
});
test("a suspension names the account by exact email or by identifier", () => {
  assert.deepEqual(
    suspensionRequest("email", "  Comprometida@Example.test ", " Robo "),
    {
      path: "/api/platform/account-suspensions",
      body: { email: "Comprometida@Example.test", reason: "Robo" },
    },
  );
  assert.deepEqual(suspensionRequest("account", " id/with space ", "Robo"), {
    path: "/api/platform/accounts/id%2Fwith%20space/suspend",
    body: { reason: "Robo" },
  });
  const own = { accountId: "self", email: "Self@Example.test" };
  assert.equal(suspendsOwnAccount("email", " self@example.TEST ", own), true);
  assert.equal(suspendsOwnAccount("email", "self", own), false);
  assert.equal(suspendsOwnAccount("account", " self ", own), true);
  assert.equal(suspendsOwnAccount("account", "Self@Example.test", own), false);
  assert.equal(suspendsOwnAccount("email", "x@example.test", null), false);
});
