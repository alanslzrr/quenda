/** Reading `window.localStorage` itself throws when site data is blocked, so every access goes through here. */
export function browserStorage(kind: "local" | "session"): Storage | undefined {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}
