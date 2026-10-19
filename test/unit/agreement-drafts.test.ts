import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgreementDraftInput,
  normalizeAgreementDraft,
} from "../../src/modules/collaboration/index.ts";

const tenant = "00000000-0000-4000-8000-000000000001";
const input: AgreementDraftInput = {
  name: " Name ",
  timeZone: "Europe/Madrid",
  startsAt: "2030-01-01T01:00:00+01:00",
  endsAt: "2031-01-01T00:00:00Z",
  purpose: "Purpose",
  legalBasis: "Reference",
  responsibilities: "Responsibilities",
  retentionPolicy: "Policy",
  eligibility: "acceso_abierto",
  weeklyLimit: null,
  aggregateReports: false,
  participants: [{ tenantId: tenant, accreditationIssuer: false, unitIds: [] }],
};
test("agreement draft normalizes content without inventing legal approval", () => {
  const result = normalizeAgreementDraft(input, tenant);
  assert.equal(result.name, "Name");
  assert.equal(result.startsAt, "2030-01-01T00:00:00.000Z");
  assert.equal(result.weeklyLimit, null);
  assert.notEqual(result.participants, input.participants);
});
test("agreement drafts reject invalid dates, zones, limits and repeated participation", () => {
  for (const override of [
    { startsAt: input.endsAt },
    { timeZone: "+01:00" },
    { weeklyLimit: 0 },
    { weeklyLimit: 1.5 },
    { purpose: " " },
    { participants: [] },
    { participants: [...input.participants, ...input.participants] },
    {
      participants: [
        {
          ...input.participants[0],
          tenantId: tenant,
          accreditationIssuer: false,
          unitIds: [tenant, tenant],
        },
      ],
    },
  ])
    assert.throws(
      () => normalizeAgreementDraft({ ...input, ...override }, tenant),
      { code: "INVALID_INPUT" },
    );
});
