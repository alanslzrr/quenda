import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../../http/errors.ts";
import type { UnitCalendarInput } from "../catalog/index.ts";
import type { MetricUnit } from "./indicators.ts";
export interface IndicatorHistory {
  calendars: Array<{
    version: number;
    createdAt: string;
    calendar: UnitCalendarInput;
  }>;
  publications: Array<{
    operation:
      | "PUBLISH_UNIT"
      | "WITHDRAW_UNIT"
      | "PUBLISH_FACILITY"
      | "WITHDRAW_FACILITY";
    occurredAt: string;
  }>;
}
export function publishedCalendarSlices(
  history: IndicatorHistory,
  start: string,
  end: string,
): MetricUnit["calendars"] {
  const first = Temporal.Instant.from(start).epochNanoseconds,
    last = Temporal.Instant.from(end).epochNanoseconds;
  const calendars = history.calendars
    .map((row) => ({
      ...row,
      at: Temporal.Instant.from(row.createdAt).epochNanoseconds,
    }))
    .sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : a.version - b.version,
    );
  const publications = history.publications.map((row) => ({
    ...row,
    at: Temporal.Instant.from(row.occurredAt).epochNanoseconds,
  }));
  // Legacy event timestamps have no sequence: contradictory transitions at the
  // same instant cannot be ordered reliably and must not silently change totals.
  const transitions = new Map<string, string>();
  for (const row of publications) {
    const key = `${row.operation.endsWith("UNIT") ? "unit" : "facility"}:${row.at}`;
    const previous = transitions.get(key);
    if (previous && previous !== row.operation) throw new HttpError("CONFLICT");
    transitions.set(key, row.operation);
  }
  publications.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const boundaries = [
    ...new Set(
      [
        first,
        last,
        ...calendars.map((row) => row.at),
        ...publications.map((row) => row.at),
      ].filter((at) => at >= first && at <= last),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result: MetricUnit["calendars"] = [];
  let publishedUnit = false,
    publishedFacility = false,
    calendarIndex = 0,
    publicationIndex = 0;
  let calendar: UnitCalendarInput | undefined;
  for (let n = 0; n < boundaries.length - 1; n++) {
    const at = boundaries[n],
      until = boundaries[n + 1];
    if (at === undefined || until === undefined) continue;
    while (
      calendarIndex < calendars.length &&
      (calendars[calendarIndex]?.at ?? last) <= at
    )
      calendar = calendars[calendarIndex++]?.calendar;
    while (
      publicationIndex < publications.length &&
      (publications[publicationIndex]?.at ?? last) <= at
    ) {
      const row = publications[publicationIndex++];
      if (!row) continue;
      if (row.operation.endsWith("UNIT"))
        publishedUnit = row.operation === "PUBLISH_UNIT";
      else publishedFacility = row.operation === "PUBLISH_FACILITY";
    }
    if (calendar && publishedUnit && publishedFacility && at < until)
      result.push({
        start: Temporal.Instant.fromEpochNanoseconds(at).toString(),
        end: Temporal.Instant.fromEpochNanoseconds(until).toString(),
        calendar,
      });
  }
  return result;
}
