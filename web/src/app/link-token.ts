// A link token lives only in module memory. The URL is cleaned right after the
// first read, so a remount of the same page (for example when the account
// session resolves) would otherwise find nothing.
const held = new Map<string, string>();

export function takeLinkToken(pathname: string, fromUrl: string) {
  if (fromUrl) held.set(pathname, fromUrl);
  return fromUrl || held.get(pathname) || "";
}

export function releaseLinkToken(pathname: string) {
  held.delete(pathname);
}
