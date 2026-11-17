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
