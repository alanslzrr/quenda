export const moduleDefinition = {
  name: "identity",
  dependencies: [],
} as const;

export { accessFailureAudit } from "./access-audit.ts";
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
export { registerMunicipalIdentity } from "./municipal-routes.ts";
export {
  acceptAdministratorInvitation,
  createMunicipality,
  replaceInitialAdministratorInvitation,
} from "./municipality.ts";
export { requireOperator } from "./operator.ts";
export { listMunicipalProfiles } from "./profiles.ts";
export { consumeAdministrativeAttempt } from "./rate-limit.ts";
export { requireRecentMfa } from "./reauthentication.ts";
export { createRequestActor } from "./request-actor.ts";
export { authenticationSchema, registerAuthentication } from "./routes.ts";
