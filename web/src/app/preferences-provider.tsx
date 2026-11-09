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
  type Theme,
} from "./preferences";
import { useSession } from "./session";
import { browserStorage } from "./storage.ts";

interface Preferences {
  locale: Locale;
  theme: Theme | null;
  save: (patch: { locale?: Locale; theme?: Theme }) => Promise<void>;
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
        api<{ theme: Theme | null }>(
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
  const locale = id ? (query.data?.locale ?? visitor.locale) : visitor.locale;
  const theme = id ? (query.data?.theme ?? null) : visitor.theme;
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  async function save(patch: { locale?: Locale; theme?: Theme }) {
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
        if (patch.theme)
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
