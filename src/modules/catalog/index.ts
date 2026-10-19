export const moduleDefinition = {
  name: "catalog",
  dependencies: ["identity"],
} as const;

export { createFacility, createReservableUnit } from "./drafts.ts";
export {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";
export { listCatalogResources } from "./queries.ts";
export { registerCatalog } from "./routes.ts";

export { withdrawCatalogResource } from "./withdrawal.ts";
