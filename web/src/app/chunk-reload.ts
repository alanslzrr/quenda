const key = "quenda.chunk-reload";
const chunkFailure =
  /ChunkLoadError|dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** A lazy route chunk that no longer exists after a deployment fails with one of these messages. */
export function isChunkError(error: unknown) {
  const text =
    error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return chunkFailure.test(text);
}

/**
 * Allows one automatic reload per window. Without storage the guard cannot
 * prevent a reload loop, so the user is shown the recovery screen instead.
 */
export function mayReloadOnce(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  now: number,
  windowMs = 10_000,
) {
  try {
    if (!storage) return false;
    const last = Number(storage.getItem(key));
    if (Number.isFinite(last) && last > 0 && now - last < windowMs)
      return false;
    storage.setItem(key, String(now));
    return true;
  } catch {
    return false;
  }
}
