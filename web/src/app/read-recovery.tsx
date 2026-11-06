import { createContext, Fragment, type ReactNode, useContext } from "react";
import { ApiError } from "./api";
import { Failure } from "./feedback";
import { ReauthenticationNoticeContext } from "./reauthentication-context";

// Keep local editors mounted across recoverable read errors, never after loss of authority.
export function discardEditor(error: unknown) {
  return (
    error instanceof ApiError &&
    [401, 403, 404].includes(error.status) &&
    error.code !== "REAUTHENTICATION_REQUIRED"
  );
}
// A failed background refresh keeps its data; only a read that never succeeded, or lost authority, replaces the view.
export function blocksEditor(query: {
  isError: boolean;
  error: unknown;
  data: unknown;
}) {
  return (
    query.isError && (query.data === undefined || discardEditor(query.error))
  );
}
const ReadBlocked = createContext(false);
export function useReadBlocked() {
  const failedRead = useContext(ReadBlocked);
  const verification = useContext(ReauthenticationNoticeContext);
  return failedRead || !!verification?.pending;
}
export function EditorRecovery({
  error,
  retry,
  children,
}: {
  error: unknown;
  retry: () => void;
  children: ReactNode;
}) {
  const inherited = useContext(ReadBlocked);
  return (
    <ReadBlocked.Provider value={inherited || !!error}>
      {error ? <Failure error={error} retry={retry} /> : null}
      <Fragment key="editor">{children}</Fragment>
    </ReadBlocked.Provider>
  );
}
