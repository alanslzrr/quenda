import { setTimeout as delay } from "node:timers/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

// The conformance target of the browser suite: WCAG 2.0 and 2.1, levels A and AA.
const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Finite CSS transitions and animations, and Motion's Web Animations, change
// colour and opacity after navigation or interaction. Reduced motion does not
// remove them (it keeps colour and opacity changes), so a scan during one of
// them reads intermediate contrast. Infinite ones, such as spinners, never end.
const animating = () =>
  document
    .getAnimations()
    .some(
      (animation) =>
        animation.playState === "running" &&
        animation.effect?.getTiming().iterations !== Infinity,
    );

/**
 * Waits until no finite animation runs, observed twice in a row so that an
 * animation started by the end of another one is also awaited. The check only
 * reads the document timeline, so it also works under an installed fake clock.
 */
export async function settleAnimations(page: Page) {
  await expect
    .poll(
      async () => {
        if (await page.evaluate(animating)) return false;
        await delay(50);
        return !(await page.evaluate(animating));
      },
      { message: "finite animations settle before the accessibility scan" },
    )
    .toBe(true);
}

/**
 * Axe violations of the settled page. By default only the WCAG 2.0 and 2.1 A
 * and AA rules run; `allRules` adds axe's best practices.
 */
export async function accessibilityViolations(
  page: Page,
  options: { include?: string; allRules?: boolean } = {},
) {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page });
  if (options.include) builder = builder.include(options.include);
  if (!options.allRules) builder = builder.withTags(wcagTags);
  return (await builder.analyze()).violations;
}
