import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeMonthlyPublication,
  type MonthlyPublicationCandidate,
  type MonthlyPublicationReview,
} from "../../src/modules/collaboration/monthly-publication.ts";

function fixture() {
  const candidate: MonthlyPublicationCandidate = {
    agreementId: "agreement",
    month: "2024-03",
    revision: 1,
    cutoff: "2024-04-01T00:00:00Z",
    controlVersion: 1,
    sourceDigest: "a".repeat(64),
    participants: ["a", "b"],
    assessment: {
      status: "THRESHOLD_MET",
      reservations: 20,
      reservedMinutes: 1200,
    },
  };
  const recipient = { tenantId: "a", accountId: "recipient" };
  const releaseHistoryDigest = "b".repeat(64);
  const reviews: MonthlyPublicationReview[] = candidate.participants.map(
    (reviewerTenantId) => ({
      reviewerTenantId,
      agreementId: candidate.agreementId,
      month: candidate.month,
      revision: 1,
      controlVersion: 1,
      sourceDigest: candidate.sourceDigest,
      recipientTenantId: recipient.tenantId,
      recipientAccountId: recipient.accountId,
      releaseHistoryDigest,
      decision: "APPROVE",
      auxiliaryReference: "review/auxiliary",
      ownDataReference: "review/own-data",
      priorReleasesReference: "review/prior-releases",
      correctionReference: null,
    }),
  );
  return {
    candidate,
    recipient,
    releaseHistoryDigest,
    reviews,
    authorized: true,
    capabilityEnabled: true,
  };
}
test("publication requires every participant review and reveals only the fixed aggregate", () => {
  const input = fixture();
  assert.deepEqual(authorizeMonthlyPublication(input), {
    status: "PUBLISHABLE",
    agreementId: "agreement",
    month: "2024-03",
    revision: 1,
    cutoff: "2024-04-01T00:00:00Z",
    controlVersion: 1,
    reservations: 20,
    reservedMinutes: 1200,
  });
  for (const change of [
    { authorized: false },
    { capabilityEnabled: false },
    { reviews: input.reviews.slice(1) },
    { reviews: [...input.reviews, input.reviews[0]!] },
    { recipient: { ...input.recipient, tenantId: "foreign" } },
    {
      candidate: {
        ...input.candidate,
        assessment: { status: "NOT_PUBLISHABLE" as const },
      },
    },
    { candidate: { ...input.candidate, controlVersion: 2 } },
  ])
    assert.deepEqual(authorizeMonthlyPublication({ ...input, ...change }), {
      status: "NOT_PUBLISHABLE",
    });
});
test("reviews bind recipient, source, month, revision, control and prior releases", () => {
  const input = fixture();
  for (const change of [
    { decision: "REJECT" as const },
    { recipientAccountId: "other" },
    { recipientTenantId: "b" },
    { agreementId: "other" },
    { month: "2024-04" },
    { revision: 2 },
    { controlVersion: 2 },
    { sourceDigest: "c".repeat(64) },
    { releaseHistoryDigest: "c".repeat(64) },
    { auxiliaryReference: " " },
    { ownDataReference: "" },
    { priorReleasesReference: "" },
  ])
    assert.deepEqual(
      authorizeMonthlyPublication({
        ...input,
        reviews: [{ ...input.reviews[0]!, ...change }, input.reviews[1]!],
      }),
      { status: "NOT_PUBLISHABLE" },
    );
  assert.deepEqual(
    authorizeMonthlyPublication({
      ...input,
      releaseHistoryDigest: "c".repeat(64),
    }),
    { status: "NOT_PUBLISHABLE" },
  );
});
test("corrections require fresh unanimous evidence about differences, not inherited approval", () => {
  const input = fixture();
  const correction = {
    ...input,
    candidate: { ...input.candidate, revision: 2 },
  };
  assert.deepEqual(authorizeMonthlyPublication(correction), {
    status: "NOT_PUBLISHABLE",
  });
  const reviews = input.reviews.map((r) => ({ ...r, revision: 2 }));
  assert.deepEqual(authorizeMonthlyPublication({ ...correction, reviews }), {
    status: "NOT_PUBLISHABLE",
  });
  assert.equal(
    authorizeMonthlyPublication({
      ...correction,
      reviews: reviews.map((r) => ({
        ...r,
        correctionReference: "review/differences",
      })),
    }).status,
    "PUBLISHABLE",
  );
});
