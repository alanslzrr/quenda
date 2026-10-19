export const moduleDefinition = {
  name: "communications",
  dependencies: ["identity"],
} as const;
export { listOwnNotices } from "./notices.ts";
export { registerCommunications } from "./routes.ts";
