import { createContext } from "react";
// A scoped UI recovery action, never a mutation retry callback.
export const ReauthenticationContext = createContext<(() => void) | null>(null);

export const ReauthenticationNoticeContext = createContext<{
  register: (id: string) => () => void;
  pending: boolean;
} | null>(null);
