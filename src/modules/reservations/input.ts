import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
export interface CreateReservationInput {
  unitId: string;
  startsAt: string;
  endsAt: string;
}
function instant(value: string): string {
  try {
    const valueInstant = Temporal.Instant.from(value);
    if (valueInstant.epochNanoseconds % 1_000_000n !== 0n)
      throw new HttpError("INVALID_INPUT");
    return valueInstant.toString({ smallestUnit: "millisecond" });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError("INVALID_INPUT");
    throw error;
  }
}

export function normalizeReservationInput(input: CreateReservationInput) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.unitId,
    )
  )
    throw new HttpError("INVALID_INPUT");
  const normalized = {
    unitId: input.unitId.toLowerCase(),
    startsAt: instant(input.startsAt),
    endsAt: instant(input.endsAt),
  };
  if (Temporal.Instant.compare(normalized.startsAt, normalized.endsAt) >= 0)
    throw new HttpError("INVALID_INPUT");
  return normalized;
}
