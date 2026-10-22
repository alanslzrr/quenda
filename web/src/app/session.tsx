import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { forgetCommand } from "../features/reservations/commands";
import { type Account, ApiError, api } from "./api";

const SessionContext = createContext<{
  account: Account | null | undefined;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
} | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["session"],
    queryFn: async ({ signal }) => {
      try {
        return await api<Account>("/api/me", { signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
  const previousAccount = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = query.data?.accountId;
    const previous = previousAccount.current;
    previousAccount.current = current;
    if (previous && previous !== current) {
      forgetCommand();
      void client.cancelQueries({ queryKey: ["private", previous] });
      client.removeQueries({ queryKey: ["private", previous] });
    }
  }, [client, query.data?.accountId]);
  async function refresh() {
    await client.cancelQueries({ queryKey: ["session"] });
    const next = await api<Account>("/api/me");
    const current = client.getQueryData<Account | null>(["session"]);
    if (current?.accountId !== next.accountId) {
      await client.cancelQueries({ queryKey: ["private"] });
      client.removeQueries({ queryKey: ["private"] });
    }
    client.setQueryData(["session"], next);
  }
  async function signOut() {
    await api("/api/auth/sign-out", { method: "POST", body: "{}" });
    forgetCommand();
    await client.cancelQueries();
    client.removeQueries({ queryKey: ["private"] });
    client.setQueryData(["session"], null);
  }
  return (
    <SessionContext.Provider
      value={{
        account: query.data,
        loading: query.isPending,
        error: query.error,
        refresh,
        signOut,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider required");
  return value;
}
