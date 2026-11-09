export type CsvValue = string | number | boolean | null | undefined;

// A spreadsheet runs a cell that begins with one of these as a formula, so a stored
// value such as "=HYPERLINK(...)" would execute when the file is opened.
const formulaStart = /^[=+\-@\t\r]/;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && formulaStart.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * RFC 4180 file: header row, CRLF line ends, double-quoted fields where needed.
 * It starts with a byte order mark so spreadsheet programs read UTF-8 correctly.
 */
export function toCsv<T extends Record<string, CsvValue>>(
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): string {
  const lines = [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}
