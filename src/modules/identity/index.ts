export const moduleDefinition = {
  name: "identity",
  dependencies: [],
} as const;

export type {
  AuthConfiguration,
  AuthenticatedAccount,
  Authentication,
} from "./auth.ts";
export { authOptions, createAuthentication } from "./auth.ts";
export { registerMunicipalIdentity } from "./municipal-routes.ts";
export {
  acceptAdministratorInvitation,
  createMunicipality,
} from "./municipality.ts";
export { requireOperator } from "./operator.ts";
export { requireRecentMfa } from "./reauthentication.ts";
export { authenticationSchema, registerAuthentication } from "./routes.ts";
