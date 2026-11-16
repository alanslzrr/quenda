import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Appearance, api, type Municipality } from "./api";
import styles from "./branding.module.css";
import type { Locale } from "./preferences";
import { usePreferences } from "./preferences-provider";
import { canRefetch } from "./query";
import { useMunicipalTheme } from "./theme-provider";

export interface Branding {
  version: number;
  name: string;
  officialName: string;
  logos: { light: boolean; dark: boolean };
}
export type LogoVariant = "light" | "dark";

/** Branding travels with the public municipality record, so it shares that query and its cache. */
export const municipalityKey = (tenantId: string | undefined) => [
  "public",
  tenantId,
  "municipality",
];
/** The version in the address makes a changed logo a new resource, so no cache ever shows the old one. */
export const logoUrl = (
  tenantId: string,
  variant: LogoVariant,
  version: number,
) => `/api/public/municipalities/${tenantId}/logo/${variant}?v=${version}`;

/** Anything unexpected from the server reads as "no logo" rather than breaking the header or the menu. */
export function normalizeBranding(value: Partial<Branding> | null): Branding {
  return {
    version: Number.isInteger(value?.version) ? (value?.version as number) : 1,
    name: typeof value?.name === "string" ? value.name : "",
    officialName:
      typeof value?.officialName === "string" ? value.officialName : "",
    logos: {
      light: value?.logos?.light === true,
      dark: value?.logos?.light === true && value?.logos?.dark === true,
    },
  };
}

/** One definition for the public municipality record, so the header, branding and pages always share a request. */
const municipalityQuery = (tenantId: string | undefined, locale: Locale) =>
  queryOptions({
    queryKey: municipalityKey(tenantId),
    enabled: !!tenantId,
    queryFn: ({ signal }) =>
      api<Municipality>(
        `/api/public/municipalities/${tenantId}`,
        { signal },
        locale,
      ),
  });

/** Lives here rather than in the catalog pages so the eager layout does not pull those lazy routes into the entry. */
export function useMunicipality(tenantId: string | undefined) {
  const { locale } = usePreferences();
  return useQuery(municipalityQuery(tenantId, locale));
}

export function useBranding(tenantId: string | undefined) {
  const { locale } = usePreferences();
  return useQuery({
    ...municipalityQuery(tenantId, locale),
    select: (municipality) =>
      normalizeBranding({
        name: municipality?.name,
        officialName: municipality?.officialName,
        ...municipality?.branding,
      }),
  });
}

/** The municipality's logo, switching to its dark version when the interface is dark and one exists. */
export function MunicipalLogo({
  tenantId,
  branding,
  size = "md",
}: {
  tenantId: string;
  branding: Branding;
  size?: "sm" | "md" | "lg";
}) {
  if (!branding.logos.light) return null;
  return (
    <span
      className={styles.logo}
      data-size={size}
      data-dark={branding.logos.dark || undefined}
      aria-hidden="true"
    >
      <img
        className={styles.light}
        src={logoUrl(tenantId, "light", branding.version)}
        alt=""
        decoding="async"
      />
      {branding.logos.dark && (
        <img
          className={styles.dark}
          src={logoUrl(tenantId, "dark", branding.version)}
          alt=""
          decoding="async"
        />
      )}
    </span>
  );
}

/** While a municipality's pages are open, the browser tab shows its logo. */
export function useMunicipalFavicon(
  tenantId: string | undefined,
  branding: Branding | undefined,
) {
  const href =
    tenantId && branding?.logos.light
      ? logoUrl(tenantId, "light", branding.version)
      : null;
  useEffect(() => {
    if (!href) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const previous = { href: link.href, type: link.type };
    link.href = href;
    link.type = "image/webp";
    return () => {
      link.href = previous.href;
      link.type = previous.type;
    };
  }, [href]);
}

/** Applies a municipality's theme and favicon to every page that belongs to it. */
export function usePublicAppearance(tenantId: string | undefined) {
  const { locale } = usePreferences();
  const client = useQueryClient();
  const queryKey = ["public", tenantId, "appearance"];
  const appearance = useQuery({
    queryKey,
    enabled: !!tenantId,
    // Every page of a municipality (public, management, reservations) needs it, and it rarely changes; reading it
    // once every few minutes keeps it from using up the shared public request budget. Saving it refreshes it.
    staleTime: 5 * 60_000,
    // Appearance falls back silently, so there is no manual retry control.
    // Re-entering may recover it, but never before its rate-limit deadline.
    retryOnMount: canRefetch(client.getQueryState(queryKey)?.error),
    queryFn: ({ signal }) =>
      api<Appearance>(
        `/api/public/municipalities/${tenantId}/appearance`,
        { signal },
        locale,
      ),
  });
  useMunicipalTheme(appearance.data);
  useMunicipalFavicon(tenantId, useBranding(tenantId).data);
}
