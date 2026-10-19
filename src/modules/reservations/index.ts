export const moduleDefinition = {
  name: "reservations",
  dependencies: ["identity", "catalog", "collaboration"],
} as const;
export { cancelReservation } from "./cancel.ts";
export { createReservation } from "./create.ts";
export { registerReservations } from "./routes.ts";
