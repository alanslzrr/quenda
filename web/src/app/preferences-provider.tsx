import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { api } from "./api";
import {
  type Locale,
  readVisitorPreferences,
  saveVisitorPreferences,
  type ThemePreference,
} from "./preferences";
import { useSession } from "./session";
import { browserStorage } from "./storage.ts";

interface Preferences {
  locale: Locale;
  theme: ThemePreference | null;
  save: (patch: {
    locale?: Locale;
    theme?: ThemePreference | null;
  }) => Promise<void>;
  pending: boolean;
  t: (es: string, gl: string) => string;
}
const PreferencesContext = createContext<Preferences | null>(null);
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const client = useQueryClient();
  const [visitor, setVisitor] = useState(() => {
    return readVisitorPreferences(browserStorage("local"), navigator.languages);
  });
  const [pending, setPending] = useState(false);
  const id = account?.accountId;
  const query = useQuery({
    queryKey: ["private", id, "preferences"],
    enabled: !!id,
    queryFn: async ({ signal }) => {
      const [locale, theme] = await Promise.all([
        api<{ locale: Locale | null }>(
          "/api/me/preferences",
          { signal },
          visitor.locale,
        ),
        api<{ theme: ThemePreference | null }>(
          "/api/me/theme",
          { signal },
          visitor.locale,
        ),
      ]);
      return { ...locale, ...theme };
    },
    // Preferences change only through this provider; focus refetches would spend the shared private-read budget.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (
        event.storageArea !== browserStorage("local") ||
        (event.key !== null && event.key !== "quenda.preferences")
      )
        return;
      if (id)
        void client.invalidateQueries({
          queryKey: ["private", id, "preferences"],
        });
      else
        setVisitor(
          readVisitorPreferences(browserStorage("local"), navigator.languages),
        );
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [id, client]);
  // Until the account's preferences arrive, or when they cannot be read (rate limit, network), the last ones seen in
  // this browser apply, so the page never flashes into the other theme or language.
  const known = id ? query.data : undefined;
  const locale = known ? (known.locale ?? visitor.locale) : visitor.locale;
  const theme = known ? known.theme : visitor.theme;
  useEffect(() => {
    if (!known) return;
    const next = { locale: known.locale ?? visitor.locale, theme: known.theme };
    if (next.locale === visitor.locale && next.theme === visitor.theme) return;
    setVisitor(next);
    saveVisitorPreferences(browserStorage("local"), next);
  }, [known, visitor]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  async function save(patch: {
    locale?: Locale;
    theme?: ThemePreference | null;
  }) {
    if (pending) return;
    setPending(true);
    try {
      if (id) {
        if (patch.locale)
          await api(
            "/api/me/preferences",
            { method: "PUT", body: JSON.stringify({ locale: patch.locale }) },
            locale,
          );
        if (patch.theme !== undefined)
          await api(
            "/api/me/theme",
            { method: "PUT", body: JSON.stringify({ theme: patch.theme }) },
            locale,
          );
        await client.invalidateQueries({
          queryKey: ["private", id, "preferences"],
        });
      } else {
        const next = { ...visitor, ...patch };
        setVisitor(next);
        saveVisitorPreferences(browserStorage("local"), next);
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <PreferencesContext.Provider
      value={{
        locale,
        theme,
        save,
        pending,
        t: (es, gl) => (locale === "gl" ? gl : es),
      }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}
export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("PreferencesProvider required");
  return value;
}
