import { expect, type Locator, type Page } from "@playwright/test";

// The application's date, date-time and month fields replace native inputs: they are driven the way a person uses
// them, by opening the calendar and moving with the keyboard, never by writing into a hidden value.

type Label = string | RegExp;
const source = (label: Label) =>
  typeof label === "string"
    ? label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : label.source.replace(/^\^|\$$/g, "");
const group = (scope: Page | Locator, label: Label) =>
  scope.getByRole("group", {
    name: typeof label === "string" ? label : label,
    exact: typeof label === "string",
  });

/** The value a date or month field submits (`YYYY-MM-DD` or `YYYY-MM`). */
export function fieldValue(scope: Page | Locator, label: Label) {
  return group(scope, label).locator('input[aria-hidden="true"]');
}

/** Chooses a civil date (`YYYY-MM-DD`) on the calendar of the field named `label`. */
export async function pickDate(
  page: Page,
  label: Label,
  date: string,
  scope: Page | Locator = page,
) {
  const field = group(scope, label);
  await field.getByRole("button").first().click();
  const dialog = page.getByRole("dialog").last();
  const focused = dialog.locator('[data-present] [data-date][tabindex="0"]');
  await expect(focused).toBeFocused();
  const from = (await focused.getAttribute("data-date")) ?? date;
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = date.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  while (months) {
    const year = Math.abs(months) >= 12;
    const forward = months > 0;
    await page.keyboard.press(
      `${year ? "Shift+" : ""}${forward ? "PageDown" : "PageUp"}`,
    );
    months -= (forward ? 1 : -1) * (year ? 12 : 1);
  }
  const day = dialog.locator(`[data-present] [data-date="${date}"]`);
  await expect(day).toBeVisible();
  await day.click();
  await expect(fieldValue(scope, label)).toHaveValue(date);
  // The calendar closes once the choice has settled, as it does for a person.
  await expect(dialog).toBeHidden();
}

/** Chooses a date and types the time of a date-time field from a `YYYY-MM-DDTHH:mm` value. */
export async function pickDateTime(
  page: Page,
  label: Label,
  value: string,
  scope: Page | Locator = page,
) {
  const [date, time] = value.split("T");
  await pickDate(page, label, date, scope);
  await scope
    .getByRole("textbox", {
      name:
        typeof label === "string"
          ? `${label} · hora`
          : new RegExp(`(?:${source(label)}).* · hora$`),
      exact: typeof label === "string",
    })
    .fill(time.slice(0, 5));
}

/** Chooses a month (`YYYY-MM`) in the month field named `label`. */
export async function pickMonth(
  page: Page,
  label: Label,
  month: string,
  scope: Page | Locator = page,
) {
  await group(scope, label).getByRole("button").first().click();
  const dialog = page.getByRole("dialog").last();
  const target = Number(month.slice(0, 4));
  for (let step = 0; step < 50; step++) {
    const shown = Number(
      (
        await dialog.locator("[data-month]").first().getAttribute("data-month")
      )?.slice(0, 4),
    );
    if (shown === target) break;
    await dialog
      .getByRole("button", {
        name:
          shown > target
            ? /^A(ñ|n)o anterior$/
            : /^A(ñ|n)o (siguiente|seguinte)$/,
      })
      .click();
  }
  await dialog.locator(`[data-month="${month}"]`).click();
  await expect(fieldValue(scope, label)).toHaveValue(month);
  await expect(dialog).toBeHidden();
}
