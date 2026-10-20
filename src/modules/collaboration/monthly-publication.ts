export interface MonthlyPublicationCandidate {
  agreementId: string;
  month: string;
  revision: number;
  cutoff: string;
  controlVersion: number;
  sourceDigest: string;
  participants: string[];
  assessment:
    | { status: "NOT_PUBLISHABLE" }
    | {
        status: "THRESHOLD_MET";
        reservations: number;
        reservedMinutes: number;
      };
}
export interface MonthlyPublicationReview {
  // The storage layer supplies only the latest review by each participant.
  reviewerTenantId: string;
  agreementId: string;
  month: string;
  revision: number;
  controlVersion: number;
  sourceDigest: string;
  recipientTenantId: string;
  recipientAccountId: string;
  releaseHistoryDigest: string;
  decision: "APPROVE" | "REJECT";
  auxiliaryReference: string;
  ownDataReference: string;
  priorReleasesReference: string;
  correctionReference: string | null;
}
const suppressed = () => ({ status: "NOT_PUBLISHABLE" as const });
const reference = (value: string | null) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 500;
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);

// Internal decision only. The delivery command must recheck live permissions,
// capability and release history, and append its audit record atomically.
export function authorizeMonthlyPublication(input: {
  candidate: MonthlyPublicationCandidate;
  recipient: { tenantId: string; accountId: string };
  releaseHistoryDigest: string;
  authorized: boolean;
  capabilityEnabled: boolean;
  reviews: MonthlyPublicationReview[];
}) {
  const { candidate: c, recipient: r } = input;
  const participants = new Set(c.participants);
  if (
    !input.authorized ||
    !input.capabilityEnabled ||
    c.assessment.status !== "THRESHOLD_MET" ||
    c.controlVersion !== 1 ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1 ||
    !digest(c.sourceDigest) ||
    !digest(input.releaseHistoryDigest) ||
    !r.accountId ||
    !participants.has(r.tenantId) ||
    participants.size === 0 ||
    participants.size !== c.participants.length ||
    !Number.isSafeInteger(c.assessment.reservations) ||
    c.assessment.reservations < 0 ||
    !Number.isFinite(c.assessment.reservedMinutes) ||
    c.assessment.reservedMinutes < 0
  )
    return suppressed();
  for (const tenant of participants) {
    const reviews = input.reviews.filter(
      (review) => review.reviewerTenantId === tenant,
    );
    if (reviews.length !== 1) return suppressed();
    const review = reviews[0]!;
    if (
      review.decision !== "APPROVE" ||
      review.agreementId !== c.agreementId ||
      review.month !== c.month ||
      review.revision !== c.revision ||
      review.controlVersion !== c.controlVersion ||
      review.sourceDigest !== c.sourceDigest ||
      review.recipientAccountId !== r.accountId ||
      review.recipientTenantId !== r.tenantId ||
      review.releaseHistoryDigest !== input.releaseHistoryDigest ||
      !reference(review.auxiliaryReference) ||
      !reference(review.ownDataReference) ||
      !reference(review.priorReleasesReference) ||
      (c.revision > 1 && !reference(review.correctionReference))
    )
      return suppressed();
  }
  return {
    status: "PUBLISHABLE" as const,
    agreementId: c.agreementId,
    month: c.month,
    revision: c.revision,
    cutoff: c.cutoff,
    controlVersion: c.controlVersion,
    reservations: c.assessment.reservations,
    reservedMinutes: c.assessment.reservedMinutes,
  };
}
