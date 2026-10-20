import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../../src/app.ts";
import { databaseMetrics } from "../../src/database/metrics.ts";
import { processReservationEmail } from "../../src/modules/communications/index.ts";
import { createAuthentication } from "../../src/modules/identity/index.ts";
import type { MailMessage } from "../../src/shared/mail.ts";
import { browser } from "../helpers/auth-client.ts";
import { freePort, withDatabase } from "../helpers/postgres.ts";
import { performanceFixture } from "./fixture.ts";
import {
  acceptanceLoad,
  assessAcceptance,
  type LoadSlot,
  runLoad,
} from "./load.ts";

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--smoke"))
    throw new Error("Only --smoke is supported");
  const smoke = args.includes("--smoke"),
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  const dirty = Boolean(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  );
  const output = `${os.tmpdir()}/quenda-performance-${randomUUID()}.json`;
  await withDatabase(async (pools) => {
    const port = await freePort(),
      origin = `http://127.0.0.1:${port}`;
    const config = { origin, secret: randomBytes(32).toString("hex") };
    const messages: MailMessage[] = [];
    const transport = {
      send: async (message: MailMessage) => {
        messages.push(message);
      },
    };
    const app = await buildApp({
      database: { check: async () => {}, close: async () => {} },
      domain: pools.domain,
      logLevel: "silent",
      identity: {
        authentication: createAuthentication(pools.auth, config, transport),
        config,
      },
    });
    let stopping = false,
      workerFailure = false;
    let workerTask: Promise<void> | undefined;
    const mailOptions = {
      origin,
      locale: "es",
      leaseSeconds: 30,
      maxAttempts: 3,
      retrySeconds: 1,
    } as const;
    try {
      const accounts: string[] = [],
        cookies: string[] = [];
      for (let i = 0; i < 10; i++) {
        const client = browser(app, `192.0.2.${i + 1}`, origin),
          email = `load-${i}@example.test`,
          password = "Synthetic-load-password-123!";
        const registered = await client.request("/api/auth/sign-up/email", {
          email,
          password,
          name: `Load ${i}`,
        });
        assert.equal(registered.statusCode, 200, registered.body);
        accounts.push(registered.json().user.id);
        const message = messages.find(
          (item) => item.to === email && item.text.includes("verify-email"),
        );
        assert.ok(message);
        const link = new URL(message.text.trim().split("\n").at(-1) ?? "");
        assert.ok(
          [200, 302].includes(
            (await client.request(link.pathname + link.search)).statusCode,
          ),
        );
        const signed = await client.request("/api/auth/sign-in/email", {
          email,
          password,
        });
        assert.equal(signed.statusCode, 200, signed.body);
        cookies.push(client.cookie());
      }
      const fixture = await performanceFixture(pools, accounts);
      const discard = { send: async (_message: MailMessage) => {} };
      while (
        (await processReservationEmail(pools.worker, discard, mailOptions)) !==
        "IDLE"
      ) {}
      messages.length = 0;
      await app.listen({ host: "127.0.0.1", port });
      workerTask = (async () => {
        try {
          while (!stopping) {
            const outcome = await processReservationEmail(
              pools.worker,
              discard,
              mailOptions,
            );
            if (outcome === "IDLE") await delay(10);
          }
        } catch {
          workerFailure = true;
        }
      })();
      let commandIndex = 0;
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 2);
      future.setUTCHours(0, 0, 0, 0);
      const execute = async (slot: LoadSlot, signal: AbortSignal) => {
        const headers: Record<string, string> = {
          origin,
          cookie: cookies[slot.session] ?? "",
        };
        let route = "/api/me/reservations",
          method = "GET",
          body: string | undefined;
        if (slot.kind === "write") {
          const index = commandIndex++,
            unit = fixture.units[index % 30];
          assert.ok(unit);
          const start = new Date(
            future.getTime() + Math.floor(index / 30) * 3600000,
          );
          route = `/api/municipalities/${unit.tenantId}/reservations`;
          method = "POST";
          headers["idempotency-key"] = `load-${index}`;
          headers["content-type"] = "application/json";
          body = JSON.stringify({
            unitId: unit.unitId,
            startsAt: start.toISOString(),
            endsAt: new Date(start.getTime() + 3600000).toISOString(),
          });
        }
        const availabilityRead = slot.kind === "read" && slot.index % 10 === 0;
        if (availabilityRead) {
          const unit = fixture.units[Math.floor(slot.index / 10) % 30];
          assert.ok(unit);
          route = `/api/public/municipalities/${unit.tenantId}/units/${unit.unitId}/availability?date=${future.toISOString().slice(0, 10)}&durationMinutes=60`;
        }
        const response = await fetch(origin + route, {
          method,
          headers,
          signal,
          ...(body ? { body } : {}),
        });
        const json = (await response.json()) as {
          items?: unknown[];
          slots?: unknown[];
          id?: string;
          status?: string;
        };
        return {
          status: response.status,
          valid:
            slot.kind === "read"
              ? response.status === 200 &&
                Array.isArray(availabilityRead ? json.slots : json.items)
              : response.status === 201 &&
                typeof json.id === "string" &&
                json.status === "CONFIRMADA",
        };
      };
      process.stderr.write("Performance dataset ready; warming up\n");
      const warmup = await runLoad(
        { ...acceptanceLoad, requests: smoke ? 25 : 300 },
        execute,
      );
      const connections = { domain: 0, auth: 0, worker: 0, waiting: 0 };
      const sample = () => {
        for (const key of ["domain", "auth", "worker"] as const)
          connections[key] = Math.max(connections[key], pools[key].totalCount);
        connections.waiting = Math.max(
          connections.waiting,
          pools.domain.waitingCount +
            pools.auth.waitingCount +
            pools.worker.waitingCount,
        );
      };
      sample();
      const monitor = setInterval(sample, 100);
      const before = {
        domain: databaseMetrics(pools.domain),
        auth: databaseMetrics(pools.auth),
      };
      const startedAt = new Date(),
        cpuBefore = process.cpuUsage();
      process.stderr.write(
        `Performance measurement started (${smoke ? "smoke, not acceptance" : "600 seconds"})\n`,
      );
      let measured: Awaited<ReturnType<typeof runLoad>>;
      try {
        measured = await runLoad(
          {
            ...acceptanceLoad,
            requests: smoke ? 100 : acceptanceLoad.requests,
          },
          execute,
        );
      } finally {
        clearInterval(monitor);
      }
      const endedAt = new Date(),
        cpu = process.cpuUsage(cpuBefore);
      // Bounded drain after measurement; any remaining items are reported, not hidden.
      const drainDeadline = performance.now() + 10000;
      while (
        performance.now() < drainDeadline &&
        (
          await pools.worker.query(
            "SELECT pending::int FROM domain.reservation_email_health()",
          )
        ).rows[0].pending > 0
      )
        await delay(20);
      stopping = true;
      await workerTask;
      const outbox = (
        await pools.migration.query(
          "SELECT count(*)::int AS total,count(*) FILTER(WHERE accepted_at IS NULL)::int AS unaccepted,percentile_disc(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM accepted_at-created_at)*1000) FILTER(WHERE accepted_at IS NOT NULL) AS p50_ms,percentile_disc(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM accepted_at-created_at)*1000) FILTER(WHERE accepted_at IS NOT NULL) AS p95_ms,max(extract(epoch FROM accepted_at-created_at)*1000) AS maximum_ms FROM domain.reservation_email WHERE created_at >= $1 AND created_at <= $2",
          [startedAt, endedAt],
        )
      ).rows[0];
      const gate = assessAcceptance(measured);
      const warmupPassed = warmup.samples.every(
        (item) => item.outcome === "valid",
      );
      const report = {
        mode: smoke ? "smoke" : "acceptance",
        workload: {
          ownReservationReads: "70%",
          availabilityReads: "10%",
          reservationCreates: "20%",
          mail: "local in-memory transport, no provider latency",
        },
        revision,
        dirty,
        fixture: fixture.totals,
        environment: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          cpus: os.cpus().length,
          cpu: os.cpus()[0]?.model,
          totalMemory: os.totalmem(),
          region: "local loopback; client, API and PostgreSQL on same host",
          poolMaximum: 5,
        },
        warmup,
        measured,
        gate,
        connections,
        database: {
          before,
          after: {
            domain: databaseMetrics(pools.domain),
            auth: databaseMetrics(pools.auth),
          },
        },
        outbox,
        cpuUsageMicroseconds: cpu,
        memory: process.memoryUsage(),
        workerFailure,
        passed:
          !smoke &&
          !dirty &&
          warmupPassed &&
          gate.passed &&
          !workerFailure &&
          outbox.unaccepted === 0,
      };
      await writeFile(output, JSON.stringify(report, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({ report: output, mode: report.mode, passed: report.passed, gate, summary: measured.summary, outbox })}\n`,
      );
      if (
        !warmupPassed ||
        workerFailure ||
        measured.samples.some((item) => item.outcome !== "valid") ||
        (!smoke && !report.passed)
      )
        process.exitCode = 1;
    } finally {
      stopping = true;
      await workerTask;
      await app.close();
    }
  });
}
main().catch(() => {
  process.stderr.write(
    "Performance run failed before producing a valid acceptance report\n",
  );
  process.exitCode = 1;
});
