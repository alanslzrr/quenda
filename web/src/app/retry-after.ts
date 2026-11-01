const fallbackSeconds = 60;
const maximumDelay = 2_147_483_647;

// HTTP dates, not the arbitrary numeric/date strings accepted by Date.parse.
const httpDate =
  /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

function parseHttpDate(value: string | null): number {
  return value && httpDate.test(value.trim()) ? Date.parse(value) : NaN;
}

/** A local deadline, calculated once when the response arrives, never on render.
 * Unusable or overflowing headers use a finite conservative wait, not a locked UI.
 */
export function retryAfterDeadline(
  value: string | null,
  now = Date.now(),
  serverDate: string | null = null,
): number {
  const header = value?.trim() ?? "";
  let delay = NaN;
  if (/^\d+$/.test(header)) delay = Number(header) * 1000;
  else {
    const target = parseHttpDate(header);
    const serverNow = parseHttpDate(serverDate);
    if (Number.isFinite(target))
      delay = Math.max(
        0,
        target - (Number.isFinite(serverNow) ? serverNow : now),
      );
  }
  return (
    now +
    (Number.isSafeInteger(delay) && delay >= 0 && delay <= maximumDelay
      ? delay
      : fallbackSeconds * 1000)
  );
}

export function retrySecondsLeft(
  deadline: number | undefined,
  now = Date.now(),
) {
  return deadline === undefined
    ? 0
    : Math.max(0, Math.ceil((deadline - now) / 1000));
}
