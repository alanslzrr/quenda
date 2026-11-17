/**
 * The CSP requires Trusted Types for every HTML sink. The application writes no HTML strings itself; the only
 * library that does is Radix Select, which injects one fixed stylesheet through React's `dangerouslySetInnerHTML`.
 * This `default` policy (the one name the CSP allows) accepts exactly that markup and rejects anything else, so any
 * other string reaching `innerHTML` still throws. Browsers without Trusted Types do not enforce the directive.
 */
export const allowedHtml = new Set([
  "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}",
]);

type TrustedTypesFactory = {
  createPolicy(
    name: string,
    rules: { createHTML(value: string): string | null },
  ): unknown;
};

const factory = (globalThis as { trustedTypes?: TrustedTypesFactory })
  .trustedTypes;
// Returning null makes the sink assignment fail, exactly as with no policy at all.
factory?.createPolicy("default", {
  createHTML: (value) => (allowedHtml.has(value) ? value : null),
});
