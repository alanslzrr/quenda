/** The names the private reservation detail carries, readable even when the space has been withdrawn. */
export interface ReservationPlace {
  municipalityName?: string | null;
  facilityName?: string | null;
  unitName?: string | null;
}

/** The line above the space name: what the page adds first, then municipality and facility, skipping what is unknown. */
export function placeContext(
  place: ReservationPlace,
  ...lead: (string | undefined)[]
) {
  return [...lead, place.municipalityName, place.facilityName]
    .filter((part): part is string => !!part?.trim())
    .join(" · ");
}

/** The space name, or the fallback only when the detail genuinely has none. */
export function placeUnitName(place: ReservationPlace, fallback: string) {
  return place.unitName?.trim() ? place.unitName : fallback;
}

/**
 * Whether the holder can still cancel: allowed until the accepted deadline, otherwise why not. A cancellation dialog
 * that stays open after its reservation changed elsewhere states this instead of offering the action.
 */
export function cancellation(
  reservation: {
    status: "CONFIRMADA" | "CANCELADA" | "FINALIZADA";
    startsAt: string;
    cancellationMinutes: number;
  },
  holder: boolean,
  now: number,
): "allowed" | "cancelled" | "closed" {
  if (reservation.status === "CANCELADA") return "cancelled";
  const start = Date.parse(reservation.startsAt);
  return holder &&
    reservation.status === "CONFIRMADA" &&
    start > now &&
    now <= start - reservation.cancellationMinutes * 60000
    ? "allowed"
    : "closed";
}
