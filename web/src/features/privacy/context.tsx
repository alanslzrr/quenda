import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { api, type Navigation } from "../../app/api";
import { Failure, Loading } from "../../app/feedback";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { useMunicipalTheme } from "../../app/theme-provider";
import { Denied, endpoint, useMunicipality } from "../municipal/shared";
import { directoryAvailable, explicitPrivacy } from "./model";
export interface Scope {
  base: string;
  view: string;
  name: string;
  global: boolean;
  read: boolean;
  execute: boolean;
  /** Whether the actor may already list the people linked to this municipality. */
  directory: boolean;
}
const Context = createContext<Scope | null>(null);
export function usePrivacyScope() {
  const s = useContext(Context);
  if (!s) throw new Error("Missing privacy scope");
  return s;
}
export function MunicipalPrivacyScope({ children }: { children: ReactNode }) {
  const m = useMunicipality();
  const scope = {
    base: endpoint(m.id),
    view: `/administracion/${m.id}/privacidad`,
    name: m.name,
    global: false,
    read: explicitPrivacy(m.permissions, "PRIVACY_READ"),
    execute: explicitPrivacy(m.permissions, "PRIVACY_EXECUTE"),
    directory: directoryAvailable({
      global: false,
      administrator: m.administrator,
    }),
  };
  return scope.read || scope.execute ? (
    <Context.Provider value={scope}>{children}</Context.Provider>
  ) : (
    <Denied />
  );
}
export function GlobalPrivacyScope({ children }: { children: ReactNode }) {
  useMunicipalTheme(undefined);
  const { account } = useSession();
  const { locale, t } = usePreferences();
  const query = useQuery({
    queryKey: ["private", account?.accountId, "privacy-navigation", locale],
    queryFn: ({ signal }) =>
      api<Navigation>("/api/me/navigation", { signal }, locale),
    retry: false,
  });
  if (query.isPending) return <Loading />;
  if (query.isError)
    return <Failure error={query.error} retry={() => void query.refetch()} />;
  const p = query.data.platform.permissions;
  const scope = {
    base: "/api/platform",
    view: "/plataforma/privacidad",
    name: t(
      "Identidad y seguridad globales",
      "Identidade e seguridade globais",
    ),
    global: true,
    read: p.includes("PRIVACY_READ"),
    execute: p.includes("PRIVACY_EXECUTE"),
    directory: false,
  };
  return scope.read || scope.execute ? (
    <Context.Provider value={scope}>{children}</Context.Provider>
  ) : (
    <Denied />
  );
}
export function usePrivacyQuery<T>(path: string) {
  const scope = usePrivacyScope();
  const { account } = useSession();
  const { locale } = usePreferences();
  return useQuery({
    queryKey: [
      "private",
      account?.accountId,
      "privacy",
      scope.base,
      path,
      locale,
    ],
    queryFn: ({ signal }) =>
      api<T>(`${scope.base}/${path}`, { signal }, locale),
    retry: false,
    gcTime: 0,
  });
}
