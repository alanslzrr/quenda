export const moduleDefinition = {
  name: "catalog",
  dependencies: ["identity"],
} as const;

export { readUnitCalendar, saveUnitCalendar } from "./calendar-store.ts";
export { createFacility, createReservableUnit } from "./drafts.ts";
export {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";
export { publishCatalogResource } from "./publication.ts";
export { listCatalogResources } from "./queries.ts";
export { registerCatalog } from "./routes.ts";
export { withdrawCatalogResource } from "./withdrawal.ts";
