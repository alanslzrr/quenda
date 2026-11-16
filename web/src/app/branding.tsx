import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api";
import styles from "./branding.module.css";
import { usePreferences } from "./preferences-provider";
import { canRefetch } from "./query";

export interface Branding {
  version: number;
  name: string;
  officialName: string;
  logos: { light: boolean; dark: boolean };
}
export type LogoVariant = "light" | "dark";

export const brandingKey = (tenantId: string | undefined) => [
  "public",
  tenantId,
  "branding",
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

export function useBranding(tenantId: string | undefined) {
  const { locale } = usePreferences();
  const client = useQueryClient();
  const queryKey = brandingKey(tenantId);
  return useQuery({
    queryKey,
    enabled: !!tenantId,
    // Like the appearance, a missing logo falls back silently and retries only after a rate-limit deadline.
    retryOnMount: canRefetch(client.getQueryState(queryKey)?.error),
    queryFn: async ({ signal }) =>
      normalizeBranding(
        await api<Partial<Branding>>(
          `/api/public/municipalities/${tenantId}/branding`,
          { signal },
          locale,
        ),
      ),
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
