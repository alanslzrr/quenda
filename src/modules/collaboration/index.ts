export const moduleDefinition = {
  name: "collaboration",
  dependencies: ["identity", "catalog"],
} as const;
export type { AgreementApprovalInput } from "./approvals.ts";
export { approveAgreement } from "./approvals.ts";
export type { AgreementDraftInput, AgreementVersionInput } from "./drafts.ts";
export { createAgreementDraft, normalizeAgreementDraft } from "./drafts.ts";
export { weeklyQuotaPeriod } from "./quota-period.ts";
export { registerCollaboration } from "./routes.ts";
export { createAgreementVersion } from "./versions.ts";
