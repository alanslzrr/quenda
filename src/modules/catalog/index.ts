export const moduleDefinition = {
  name: "catalog",
  dependencies: ["identity"],
} as const;

export { createFacility, createReservableUnit } from "./drafts.ts";
export { registerCatalog } from "./routes.ts";
