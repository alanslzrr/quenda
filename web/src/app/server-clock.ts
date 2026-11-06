let offset = 0;

/** Difference between the server and browser clocks; zero when the server time is unusable. */
export function clockOffset(serverTime: string | null, localNow: number) {
  const server = serverTime ? Date.parse(serverTime) : Number.NaN;
  return Number.isFinite(server) ? server - localNow : 0;
}

/** Every API response carries a Date header, so the clock is learned without a dedicated request. */
export function recordServerDate(header: string | null, localNow = Date.now()) {
  const next = clockOffset(header, localNow);
  // The header has one-second resolution; ignore it when it is missing or implausible.
  if (header && Math.abs(next) < 24 * 60 * 60 * 1000) offset = next;
}

/** Cancellation windows are decided by the server clock, so this is only a display hint. */
export function serverNow() {
  return Date.now() + offset;
}
