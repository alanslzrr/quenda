export const moduleDefinition = {
  name: "collaboration",
  dependencies: ["identity", "catalog"],
} as const;
export type { ActivateAgreementInput } from "./activation.ts";
export { activateAgreement } from "./activation.ts";
export type { AgreementApprovalInput } from "./approvals.ts";
export { approveAgreement } from "./approvals.ts";
export { syncReservationConsumption } from "./consumption.ts";
export type { IssueCredentialInput } from "./credentials.ts";
export {
  issueAgreementCredential,
  revokeAgreementCredential,
} from "./credentials.ts";
export type { AgreementDraftInput, AgreementVersionInput } from "./drafts.ts";
export { createAgreementDraft, normalizeAgreementDraft } from "./drafts.ts";
export { listAgreementVersions, readAgreementVersion } from "./queries.ts";
export { weeklyQuotaPeriod } from "./quota-period.ts";
export type { ReleaseAgreementRestrictionInput } from "./reopening.ts";
export {
  readUnitAgreementRestriction,
  releaseUnitAgreementRestriction,
} from "./reopening.ts";
export { registerCollaboration } from "./routes.ts";
export { suspendAgreement } from "./suspension.ts";
export { createAgreementVersion } from "./versions.ts";
