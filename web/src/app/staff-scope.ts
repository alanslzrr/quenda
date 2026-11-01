import type { Navigation } from "./api";

/** Where «Gestión» leads, or null when the account manages nothing. Navigation only: every page still authorizes. */
export function staffEntry(navigation: Navigation): string | null {
  const managed = navigation.municipalities?.items ?? [];
  const platform =
    !!navigation.platform &&
    (navigation.platform.operator ||
      navigation.platform.permissions?.length > 0);
  if (!platform && !managed.length) return null;
  const only =
    !platform && managed.length === 1 && !navigation.municipalities.nextCursor
      ? managed[0]
      : undefined;
  return only ? `/administracion/${only.id}` : "/administracion";
}
