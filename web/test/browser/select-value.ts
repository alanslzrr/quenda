import { expect, type Page } from "@playwright/test";
/** Read the native form option's label, then interact through the visible Lumen control. */
export async function selectValue(
  page: Page,
  name: string,
  label: string | RegExp,
  value: string,
) {
  const option = page
    .locator(`select[name="${name}"] option`)
    .filter({ hasText: /.*/ });
  await expect
    .poll(async () =>
      option.evaluateAll(
        (items, value) =>
          items.some((item) => (item as HTMLOptionElement).value === value),
        value,
      ),
    )
    .toBe(true);
  const text = await option.evaluateAll(
    (items, value) =>
      (
        items.find(
          (item) => (item as HTMLOptionElement).value === value,
        ) as HTMLOptionElement
      ).text,
    value,
  );
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: text, exact: true }).click();
}
