import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

/** Difference between the server and browser clocks; zero when the server time is unusable. */
export function clockOffset(serverTime: string, localNow: number) {
  const server = Date.parse(serverTime);
  return Number.isFinite(server) ? server - localNow : 0;
}

/** Cancellation windows are decided by the server clock, so the browser clock is only a display hint. */
export function useServerOffset() {
  const query = useQuery({
    queryKey: ["public", "server-clock"],
    queryFn: async ({ signal }) => {
      const policy = await api<{ serverTime: string }>(
        "/api/public/reservation-command-policy",
        { signal },
      );
      return clockOffset(policy.serverTime, Date.now());
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  return query.data ?? 0;
}
