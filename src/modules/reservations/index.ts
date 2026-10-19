export const moduleDefinition = {
  name: "reservations",
  dependencies: ["identity", "catalog", "collaboration"],
} as const;
export { createBlock, releaseBlock } from "./blocks.ts";
export { cancelReservation } from "./cancel.ts";
export { createReservation } from "./create.ts";
export { modifyReservation } from "./modify.ts";
export { listMunicipalReservations, listOwnReservations } from "./queries.ts";
export { registerReservations } from "./routes.ts";
