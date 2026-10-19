export const moduleDefinition = {
  name: "collaboration",
  dependencies: ["identity", "catalog"],
} as const;
export type { AgreementDraftInput } from "./drafts.ts";
export { createAgreementDraft, normalizeAgreementDraft } from "./drafts.ts";
export { weeklyQuotaPeriod } from "./quota-period.ts";
