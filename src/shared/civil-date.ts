import { Temporal } from "@js-temporal/polyfill";
import { HttpError } from "../http/errors.ts";

export function civilDate(value: string): string {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
      throw new Error();
    if (Temporal.PlainDate.from(value).toString() !== value) throw new Error();
    return value;
  } catch {
    throw new HttpError("INVALID_INPUT");
  }
}
export function civilMonth(value: string): string {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new HttpError("INVALID_INPUT");
  civilDate(`${value}-01`);
  return value;
}
