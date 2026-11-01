export const moduleDefinition = {
  name: "identity",
  dependencies: [],
} as const;

export { accessFailureAudit } from "./access-audit.ts";
export { accountLabelSchema, accountLabels } from "./account-labels.ts";
export { requireAdministrator } from "./administrator.ts";
export {
  listMunicipalAdministratorInvitations,
  listMunicipalAdministrators,
} from "./administrator-query.ts";
export type {
  AuthConfiguration,
  AuthenticatedAccount,
  Authentication,
} from "./auth.ts";
export { authOptions, createAuthentication } from "./auth.ts";
export { deactivateAccount } from "./deactivation.ts";
export {
  inviteAdministrator,
  listOwnAdministratorInvitations,
  revokeAdministrator,
  revokeAdministratorInvitation,
} from "./invitations.ts";
export type { ManagerInvitationInput, Operation } from "./manager.ts";
export {
  acceptManager,
  inviteManager,
  listOwnManagerInvitations,
  operations,
  requirePermission,
  revokeManager,
} from "./manager.ts";
export { listMunicipalManagerInvitations } from "./manager-query.ts";
export {
  makeAdministratorIndefinite,
  recoverMunicipalAdministrator,
  revokeMunicipalAccessForSecurity,
} from "./municipal-continuity.ts";
export { registerMunicipalIdentity } from "./municipal-routes.ts";
export {
  acceptAdministratorInvitation,
  createMunicipality,
  replaceInitialAdministratorInvitation,
} from "./municipality.ts";
export { requireOperator } from "./operator.ts";
export {
  readAccountPreferences,
  saveAccountPreferences,
} from "./preferences.ts";
export { listMunicipalProfiles } from "./profiles.ts";
export { consumeAdministrativeAttempt } from "./rate-limit.ts";
export { requireRecentMfa } from "./reauthentication.ts";
export { createRequestActor } from "./request-actor.ts";
export { processRetentionBatch } from "./retention-worker.ts";
export { authenticationSchema, registerAuthentication } from "./routes.ts";
export { suspendAccount } from "./security.ts";
