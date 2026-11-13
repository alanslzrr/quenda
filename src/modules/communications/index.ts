export const moduleDefinition = {
  name: "communications",
  dependencies: ["identity", "catalog"],
} as const;
export { readUnitIndicators } from "./indicator-query.ts";
export { municipalIndicators } from "./indicators.ts";
export {
  countUnreadNotices,
  listOwnNotices,
  readOwnNotices,
} from "./notices.ts";
export type { ReservationMailEvent } from "./reservation-mail.ts";
export { reservationMail } from "./reservation-mail.ts";
export { registerCommunications } from "./routes.ts";
export type { EmailWorkerOptions } from "./worker.ts";
export { processReservationEmail } from "./worker.ts";
