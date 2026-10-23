import { createContext } from "react";
// A scoped UI recovery action, never a mutation retry callback.
export const ReauthenticationContext = createContext<(() => void) | null>(null);
