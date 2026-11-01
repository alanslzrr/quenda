import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import { retrySecondsLeft } from "./retry-after.ts";

export function canRefetch(error: unknown) {
  return !(error instanceof ApiError) || !retrySecondsLeft(error.retryAt);
}
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        // A failed initial load is retried explicitly, not just by remounting it.
        // refetchOnMount only governs queries that already have data.
        retryOnMount: false,
        refetchOnMount: (query) => canRefetch(query.state.error),
        refetchOnWindowFocus: (query) => canRefetch(query.state.error),
        refetchOnReconnect: (query) => canRefetch(query.state.error),
        retry: (count, error) =>
          count < 1 &&
          canRefetch(error) &&
          (!(error instanceof ApiError) || error.status >= 500),
      },
      mutations: { retry: false },
    },
  });
}
