import { allowed, canEnter } from "../reporting/model.ts";

type Authority = Parameters<typeof canEnter>[0];

/** First section this authority can open, so entering management never ends on a refusal. */
export function landingSection(m: Authority): string | null {
  const has = (...operations: string[]) =>
    m.administrator ||
    m.permissions.some((p) => operations.includes(p.operation));
  if (has("CATALOG_CREATE", "CATALOG_MANAGE")) return "";
  if (has("RESERVATION_READ", "RESERVATION_MANAGE", "UNIT_BLOCK"))
    return "/agenda";
  if (canEnter(m)) return "/uso-de-los-espacios";
  if (canEnter(m, true)) return "/exportaciones";
  if (allowed(m, "REPORT_READ", null)) return "/informes";
  if (
    m.permissions.some(
      (p) =>
        p.unitId === null &&
        ["PRIVACY_READ", "PRIVACY_EXECUTE"].includes(p.operation),
    )
  )
    return "/privacidad";
  return null;
}
