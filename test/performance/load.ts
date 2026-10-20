import { setTimeout as delay } from "node:timers/promises";

export const acceptanceLoad = {
  requests: 3000,
  intervalMs: 200,
  sessions: 10,
  timeoutMs: 10000,
} as const;
export type RequestKind = "read" | "write";
export interface LoadSlot {
  index: number;
  session: number;
  kind: RequestKind;
  scheduledMs: number;
}
export interface LoadSample extends LoadSlot {
  outcome: "valid" | "invalid" | "transportError" | "timeout" | "sessionBusy";
  status: number | null;
  latencyMs: number;
  dispatchDelayMs: number;
  scheduledLatencyMs: number;
}
export function loadPlan(
  requests: number,
  intervalMs: number,
  sessions: number,
): LoadSlot[] {
  if (
    !Number.isSafeInteger(requests) ||
    requests < 1 ||
    requests > 100000 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isSafeInteger(sessions) ||
    sessions < 1 ||
    sessions > 1000
  )
    throw new Error("Invalid load parameters");
  return Array.from({ length: requests }, (_, index) => ({
    index,
    session: (index + Math.floor(index / sessions)) % sessions,
    kind: index % 5 === 4 ? "write" : "read",
    scheduledMs: index * intervalMs,
  }));
}
function distribution(values: number[]) {
  if (!values.length)
    return { count: 0, p50: null, p95: null, p99: null, maximum: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted[Math.ceil(p * sorted.length) - 1] as number;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: sorted.at(-1) as number,
  };
}
export function summarizeLoad(samples: LoadSample[]) {
  return Object.fromEntries(
    (["read", "write"] as const).map((kind) => {
      const selected = samples.filter((sample) => sample.kind === kind),
        valid = selected.filter((sample) => sample.outcome === "valid");
      return [
        kind,
        {
          scheduled: selected.length,
          outcomes: Object.fromEntries(
            (
              [
                "valid",
                "invalid",
                "transportError",
                "timeout",
                "sessionBusy",
              ] as const
            ).map((outcome) => [
              outcome,
              selected.filter((sample) => sample.outcome === outcome).length,
            ]),
          ),
          latencyMs: distribution(valid.map((sample) => sample.latencyMs)),
          scheduledLatencyMs: distribution(
            valid.map((sample) => sample.scheduledLatencyMs),
          ),
          dispatchDelayMs: distribution(
            selected.map((sample) => sample.dispatchDelayMs),
          ),
        },
      ];
    }),
  );
}

export async function runLoad(
  options: {
    requests: number;
    intervalMs: number;
    sessions: number;
    timeoutMs: number;
  },
  execute: (
    slot: LoadSlot,
    signal: AbortSignal,
  ) => Promise<{ status: number; valid: boolean }>,
) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error("Invalid request timeout");
  const plan = loadPlan(options.requests, options.intervalMs, options.sessions);
  const samples: LoadSample[] = [],
    active = new Set<number>(),
    pending: Promise<void>[] = [];
  let maximumActive = 0;
  const start = performance.now();
  for (const slot of plan) {
    const remaining = start + slot.scheduledMs - performance.now();
    if (remaining > 0) await delay(remaining);
    const dispatch = performance.now(),
      dispatchDelayMs = Math.max(0, dispatch - start - slot.scheduledMs);
    if (active.has(slot.session)) {
      samples.push({
        ...slot,
        outcome: "sessionBusy",
        status: null,
        latencyMs: 0,
        dispatchDelayMs,
        scheduledLatencyMs: dispatchDelayMs,
      });
      continue;
    }
    active.add(slot.session);
    maximumActive = Math.max(maximumActive, active.size);
    pending.push(
      (async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let outcome: LoadSample["outcome"] = "transportError",
          status: number | null = null;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("Request deadline"));
            }, options.timeoutMs);
          });
          const response = await Promise.race([
            Promise.resolve().then(() => execute(slot, controller.signal)),
            timeout,
          ]);
          status = response.status;
          outcome = response.valid ? "valid" : "invalid";
        } catch {
          outcome = controller.signal.aborted ? "timeout" : "transportError";
        } finally {
          clearTimeout(timer);
          const completed = performance.now();
          samples.push({
            ...slot,
            outcome,
            status,
            latencyMs: completed - dispatch,
            dispatchDelayMs,
            scheduledLatencyMs: completed - start - slot.scheduledMs,
          });
          active.delete(slot.session);
        }
      })(),
    );
  }
  // Preserve the whole measurement window even when the final request is fast.
  const remaining =
    start + options.requests * options.intervalMs - performance.now();
  if (remaining > 0) await delay(remaining);
  await Promise.all(pending);
  samples.sort((a, b) => a.index - b.index);
  return {
    plannedWindowMs: options.requests * options.intervalMs,
    elapsedMs: performance.now() - start,
    maximumActive,
    samples,
    summary: summarizeLoad(samples),
  };
}

// Only the full measured run can satisfy T-16. Warm-up and smoke runs are separate.
export function assessAcceptance(result: Awaited<ReturnType<typeof runLoad>>) {
  const expected = loadPlan(
    acceptanceLoad.requests,
    acceptanceLoad.intervalMs,
    acceptanceLoad.sessions,
  );
  const fullRun =
    result.plannedWindowMs === 600000 &&
    result.elapsedMs >= 600000 &&
    result.samples.length === expected.length &&
    result.samples.every((sample, index) => {
      const slot = expected[index];
      return (
        slot &&
        sample.index === slot.index &&
        sample.session === slot.session &&
        sample.kind === slot.kind &&
        sample.scheduledMs === slot.scheduledMs
      );
    });
  const summary = summarizeLoad(result.samples);
  const within = (kind: RequestKind, maximum: number) => {
    const report = summary[kind];
    return (
      report &&
      report.latencyMs.p95 !== null &&
      report.latencyMs.p95 <= maximum &&
      report.scheduledLatencyMs.p95 !== null &&
      report.scheduledLatencyMs.p95 <= maximum
    );
  };
  return {
    fullRun,
    noFailedRequests: result.samples.every(
      (sample) => sample.outcome === "valid",
    ),
    latencyTargets: Boolean(within("read", 1000) && within("write", 1500)),
    passed:
      fullRun &&
      result.samples.every((sample) => sample.outcome === "valid") &&
      Boolean(within("read", 1000) && within("write", 1500)),
  };
}
