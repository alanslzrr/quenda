export const moduleDefinition = {
  name: "communications",
  dependencies: ["identity"],
} as const;
export { listOwnNotices } from "./notices.ts";
export type { ReservationMailEvent } from "./reservation-mail.ts";
export { reservationMail } from "./reservation-mail.ts";
export { registerCommunications } from "./routes.ts";
