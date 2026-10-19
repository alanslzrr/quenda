export const moduleDefinition = {
  name: "identity",
  dependencies: [],
} as const;

export { requireAdministrator } from "./administrator.ts";
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
export { registerMunicipalIdentity } from "./municipal-routes.ts";
export {
  acceptAdministratorInvitation,
  createMunicipality,
  replaceInitialAdministratorInvitation,
} from "./municipality.ts";
export { requireOperator } from "./operator.ts";
export { consumeAdministrativeAttempt } from "./rate-limit.ts";
export { requireRecentMfa } from "./reauthentication.ts";
export { createRequestActor } from "./request-actor.ts";
export { authenticationSchema, registerAuthentication } from "./routes.ts";
