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
export { requireOperator } from "./operator.ts";
export { authenticationSchema, registerAuthentication } from "./routes.ts";
