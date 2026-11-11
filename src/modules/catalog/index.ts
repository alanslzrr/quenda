export const moduleDefinition = {
  name: "catalog",
  dependencies: ["identity"],
} as const;

export type { UnitCalendarInput } from "./calendar.ts";
export { readUnitCalendar, saveUnitCalendar } from "./calendar-store.ts";
export { createFacility, createReservableUnit } from "./drafts.ts";
export {
  inspectCatalogResource,
  renameCatalogResource,
} from "./maintenance.ts";
export { utcOpeningIntervals } from "./opening.ts";
export {
  candidateAvailability,
  nextHabitualSlot,
  publicAvailability,
  publicFacilities,
  publicUnitCalendar,
  publicUnits,
} from "./public.ts";
export { availabilityResponse } from "./public-routes.ts";
export { publishCatalogResource } from "./publication.ts";
export { listCatalogResources } from "./queries.ts";
export { validateReservableInterval } from "./reservation-rules.ts";
export { registerCatalog } from "./routes.ts";
export type { CalendarSlot } from "./slots.ts";
export { withdrawCatalogResource } from "./withdrawal.ts";
