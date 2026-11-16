// Building an Intl formatter costs far more than using one, and slot lists, calendars and charts
// ask for the same few configurations on every render, so each one is built once and reused.
// Locales are plain tags (not Intl.Locale objects) so the serialized key cannot collide.
type Locales = string | readonly string[] | undefined;

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

// The time zone travels inside the options, so it is part of the key too.
const keyOf = (locales: Locales, options: object | undefined) =>
  JSON.stringify([locales ?? null, options ?? null]);

export function dateTimeFormat(
  locales: Locales,
  options?: Intl.DateTimeFormatOptions,
) {
  const key = keyOf(locales, options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locales, options);
    dateFormats.set(key, format);
  }
  return format;
}

export function numberFormat(
  locales: Locales,
  options?: Intl.NumberFormatOptions,
) {
  const key = keyOf(locales, options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locales, options);
    numberFormats.set(key, format);
  }
  return format;
}
