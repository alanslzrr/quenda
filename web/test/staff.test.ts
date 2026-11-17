import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReplace,
  invitationEvent,
  invitationRecipient,
  municipalOnly,
  type StaffInvitation,
  securityCandidates,
  securityWithdrawalRequest,
  staffInvitationBody,
  validPermissions,
} from "../src/features/municipal/staff-model.ts";

const now = Date.parse("2026-10-23T10:00:00Z");
const invitation: StaffInvitation = {
  invitationId: "invitation",
  accountId: "account",
  invitedBy: "admin",
  expiresAt: "2026-10-24T10:00:00Z",
  roleExpiresAt: null,
  acceptedAt: null,
  revokedAt: null,
};
test("permission editor preserves independent operations and rejects duplicate or invalid scopes", () => {
  assert.equal(validPermissions([]), false);
  assert.equal(
    validPermissions([{ operation: "PRIVACY_READ", unitId: "unit" }]),
    false,
  );
  assert.equal(municipalOnly("CATALOG_CREATE"), true);
  assert.equal(municipalOnly("PRIVACY_EXECUTE"), true);
  assert.equal(
    validPermissions([{ operation: "RESERVATION_READ", unitId: "unit" }]),
    true,
  );
  assert.equal(
    validPermissions([{ operation: "PRIVACY_EXECUTE", unitId: null }]),
    true,
  );
  assert.equal(
    validPermissions([
      { operation: "UNIT_BLOCK", unitId: "a" },
      { operation: "UNIT_BLOCK", unitId: "b" },
    ]),
    true,
  );
  assert.equal(
    validPermissions([
      { operation: "UNIT_BLOCK", unitId: "a" },
      { operation: "UNIT_BLOCK", unitId: "a" },
    ]),
    false,
  );
  assert.equal(
    validPermissions(
      Array.from({ length: 51 }, (_, i) => ({
        operation: "RESERVATION_READ",
        unitId: `${i}`,
      })),
    ),
    false,
  );
});
test("invitation history reports evidence rather than inferring current authority", () => {
  assert.equal(invitationEvent(invitation, now), "PENDING");
  assert.equal(
    invitationEvent(
      { ...invitation, expiresAt: new Date(now).toISOString() },
      now,
    ),
    "EXPIRED",
  );
  assert.equal(
    invitationEvent(
      { ...invitation, roleExpiresAt: new Date(now).toISOString() },
      now,
    ),
    "EXPIRED",
  );
  assert.equal(
    invitationEvent(
      { ...invitation, acceptedAt: "2026-10-22", roleExpiresAt: "2026-10-22" },
      now,
    ),
    "ACCEPTED",
  );
  assert.equal(
    invitationEvent(
      { ...invitation, acceptedAt: "2026-10-22", revokedAt: "2026-10-23" },
      now,
    ),
    "REVOKED",
  );
});
test("replacement is offered only for accepted unrevoked grants within recorded validity", () => {
  assert.equal(canReplace(invitation, now), false);
  assert.equal(
    canReplace({ ...invitation, acceptedAt: "2026-10-22" }, now),
    true,
  );
  assert.equal(
    canReplace(
      { ...invitation, acceptedAt: "2026-10-22", revokedAt: "2026-10-23" },
      now,
    ),
    false,
  );
  assert.equal(
    canReplace(
      {
        ...invitation,
        acceptedAt: "2026-10-22",
        roleExpiresAt: new Date(now).toISOString(),
      },
      now,
    ),
    false,
  );
});
test("history names the invited address until acceptance and the accepting account after it", () => {
  const pending: StaffInvitation = {
    ...invitation,
    accountId: null,
    recipientEmail: "nueva@example.test",
  };
  assert.deepEqual(invitationRecipient(pending), {
    kind: "address",
    email: "nueva@example.test",
  });
  assert.equal(invitationEvent(pending, now), "PENDING");
  assert.equal(canReplace(pending, now), false);
  assert.deepEqual(
    invitationRecipient({
      ...pending,
      accountId: "accepted",
      recipientEmail: null,
    }),
    { kind: "account", accountId: "accepted" },
  );
  // Invitations addressed to an account before email addressing still show it.
  assert.deepEqual(invitationRecipient(invitation), {
    kind: "account",
    accountId: "account",
  });
  assert.deepEqual(invitationRecipient({ ...pending, recipientEmail: null }), {
    kind: "withdrawn",
  });
});
test("a new staff invitation is addressed to the trimmed email and a replacement names no recipient", () => {
  const permissions = [
    { operation: "RESERVATION_READ" as const, unitId: null },
  ];
  assert.deepEqual(
    staffInvitationBody({
      kind: "manager",
      email: "  Persona@Example.test ",
      expiresAt: "2026-10-24T10:00:00Z",
      roleExpiresAt: "",
      permissions,
    }),
    {
      email: "Persona@Example.test",
      expiresAt: "2026-10-24T10:00:00Z",
      roleExpiresAt: null,
      permissions,
    },
  );
  assert.deepEqual(
    staffInvitationBody({
      kind: "administrator",
      email: "admin@example.test",
      expiresAt: "2026-10-24T10:00:00Z",
      roleExpiresAt: "2026-12-01T00:00:00Z",
      permissions,
    }),
    {
      email: "admin@example.test",
      expiresAt: "2026-10-24T10:00:00Z",
      roleExpiresAt: "2026-12-01T00:00:00Z",
    },
  );
  const replacement = staffInvitationBody({
    kind: "manager",
    email: "ignored@example.test",
    expiresAt: "2026-10-24T10:00:00Z",
    roleExpiresAt: "",
    permissions,
    replacement: invitation,
    reason: " Nuevo alcance ",
  });
  assert.deepEqual(replacement, {
    expiresAt: "2026-10-24T10:00:00Z",
    roleExpiresAt: null,
    permissions,
    replacesInvitationId: "invitation",
    reason: "Nuevo alcance",
  });
  assert.equal("email" in replacement, false);
  assert.equal("accountId" in replacement, false);
});
test("security withdrawal offers current holders, pending accounts and pending addresses only", () => {
  const label = (email: string) => ({ name: "", email });
  const later = "2026-10-30T10:00:00Z",
    past = "2026-10-20T10:00:00Z";
  const candidates = securityCandidates(
    {
      administrators: [
        {
          accountId: "admin",
          accountLabel: label("admin@example.test"),
          invitationId: "a1",
          grantedAt: past,
          expiresAt: null,
          revokedAt: null,
          active: true,
        },
        {
          accountId: "former",
          invitationId: "a2",
          grantedAt: past,
          expiresAt: null,
          revokedAt: past,
          active: false,
        },
        {
          accountId: "lapsed",
          invitationId: "a3",
          grantedAt: past,
          expiresAt: past,
          revokedAt: null,
          active: false,
        },
      ],
      administratorInvitations: [
        // The accepted invitation of the administrator listed above.
        { ...invitation, accountId: "admin", acceptedAt: past },
        { ...invitation, accountId: null, recipientEmail: "new@example.test" },
        {
          ...invitation,
          accountId: null,
          recipientEmail: "late@example.test",
          expiresAt: past,
        },
        {
          ...invitation,
          accountId: null,
          recipientEmail: "gone@example.test",
          revokedAt: past,
        },
        { ...invitation, accountId: null, recipientEmail: null },
      ],
      managerInvitations: [
        {
          ...invitation,
          accountId: "manager",
          accountLabel: label("manager@example.test"),
          acceptedAt: past,
          roleExpiresAt: later,
          permissions: [{ operation: "REPORT_READ", unitId: null }],
        },
        {
          ...invitation,
          accountId: "admin",
          acceptedAt: past,
          permissions: [{ operation: "PRIVACY_READ", unitId: null }],
        },
        {
          ...invitation,
          accountId: "expired-grant",
          acceptedAt: past,
          roleExpiresAt: past,
        },
        { ...invitation, accountId: "legacy" },
        { ...invitation, accountId: null, recipientEmail: "new@example.test" },
      ],
    },
    now,
  );
  assert.deepEqual(
    candidates.map((c) =>
      c.kind === "account" ? [c.value, c.roles] : [c.value],
    ),
    [
      ["account:admin", ["administrator", "manager"]],
      ["account:legacy", ["pending"]],
      ["account:manager", ["manager"]],
      ["address:new@example.test"],
    ],
  );
  const [admin] = candidates;
  const address = candidates.at(-1);
  assert.ok(admin && address);
  assert.deepEqual(securityWithdrawalRequest("/api/m/t", admin, " Robo "), {
    path: "/api/m/t/accounts/admin/revoke-access-for-security",
    body: { reason: "Robo" },
  });
  assert.deepEqual(securityWithdrawalRequest("/api/m/t", address, "Robo"), {
    path: "/api/m/t/invitation-addresses/revoke-for-security",
    body: { email: "new@example.test", reason: "Robo" },
  });
});
