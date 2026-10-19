export const moduleDefinition = {
  name: "reservations",
  dependencies: ["identity", "catalog", "collaboration"],
} as const;
export { createReservation } from "./create.ts";
