import { useQuery } from "@tanstack/react-query";
import { api, type Navigation } from "./api";
import { staffEntry } from "./staff-scope";

const key = "quenda.staff-entry";
const fresh = 60_000;

interface Stored {
  accountId: string;
  at: number;
  to: string | null;
}

function read(accountId: string): Stored | undefined {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(key) ?? "null",
    ) as Stored | null;
    return value?.accountId === accountId && typeof value.at === "number"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function write(value: Stored) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Without storage the entry is simply requested on each load. */
  }
}

/** Private reads share a per-account request budget, so a full reload within a minute reuses the last answer. */
export function useStaffEntry(
  accountId: string | undefined,
  enabled: boolean,
  locale: "es" | "gl",
) {
  const stored = accountId ? read(accountId) : undefined;
  const query = useQuery({
    queryKey: ["private", accountId, "navigation", "entry"],
    enabled: !!accountId && enabled,
    staleTime: fresh,
    retry: false,
    initialData: stored?.to,
    initialDataUpdatedAt: stored?.at,
    queryFn: async ({ signal }) => {
      const to = staffEntry(
        await api<Navigation>("/api/me/navigation", { signal }, locale),
      );
      if (accountId) write({ accountId, at: Date.now(), to });
      return to;
    },
  });
  return {
    to: query.data ?? null,
    error: accountId && enabled ? query.error : null,
    retry: () => void query.refetch(),
  };
}
