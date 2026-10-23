import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReplace,
  invitationEvent,
  municipalOnly,
  type StaffInvitation,
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
