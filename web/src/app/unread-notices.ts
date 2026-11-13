import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { usePreferences } from "./preferences-provider";
import { useSession } from "./session";

export const unreadNoticesKey = (accountId: string | undefined) => [
  "private",
  accountId,
  "notices-unread",
];

/** Unread notices of the signed-in account, refreshed every minute and when the window regains focus. */
export function useUnreadNotices() {
  const { account } = useSession();
  const { locale } = usePreferences();
  const query = useQuery({
    queryKey: unreadNoticesKey(account?.accountId),
    queryFn: ({ signal }) =>
      api<{ unread: number }>("/api/me/notices/unread", { signal }, locale),
    enabled: !!account,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  return account ? (query.data?.unread ?? 0) : 0;
}
