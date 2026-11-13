import { createContext } from "react";
// A scoped UI recovery action, never a mutation retry callback.
export const ReauthenticationContext = createContext<(() => void) | null>(null);

export const ReauthenticationNoticeContext = createContext<{
  register: (id: string) => () => void;
  pending: boolean;
  /** The first section still waiting for verification: only it explains the wait in full. */
  first?: string | undefined;
} | null>(null);
