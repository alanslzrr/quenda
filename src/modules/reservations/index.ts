export const moduleDefinition = {
  name: "reservations",
  dependencies: ["identity", "catalog", "collaboration"],
} as const;
export { acceptReservationUsageRules } from "./accept-usage-rules.ts";
export { createBlock, releaseBlock } from "./blocks.ts";
export { cancelReservation } from "./cancel.ts";
export { createReservation } from "./create.ts";
export { modifyReservation } from "./modify.ts";
export {
  listMunicipalReservations,
  listOwnReservations,
  readReservation,
} from "./queries.ts";
export { registerReservations } from "./routes.ts";
