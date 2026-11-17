import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Pool } from "pg";
import {
  blockedSource,
  cspReportPath,
  registerCspReports,
} from "../../src/http/csp-reports.ts";
import { registerErrors } from "../../src/http/errors.ts";
import { publicSubjectHash } from "../../src/http/public-rate-limit.ts";

const config = { origin: "https://quenda.test", secret: "csp-test-only" };

async function reportApp(allowed = Number.POSITIVE_INFINITY) {
  const lines: string[] = [];
  const subjects: string[] = [];
  const pool = {
    query: async (_sql: string, [subject]: [string]) => {
      subjects.push(subject);
      return {
        rows: [{ allowed: subjects.length <= allowed, retry_after: 42 }],
      };
    },
  } as unknown as Pool;
  const app = Fastify({
    logger: { level: "info", stream: { write: (line) => lines.push(line) } },
  });
  registerErrors(app);
  await registerCspReports(app, pool, config);
  await app.ready();
  const events = () =>
    lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === "CSP_VIOLATION");
  return { app, lines, subjects, events };
}

const post = (
  app: Awaited<ReturnType<typeof reportApp>>["app"],
  contentType: string,
  payload: string,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url: cspReportPath,
    remoteAddress: "192.0.2.80",
    headers: { "content-type": contentType, ...headers },
    payload,
  });

// Every field a browser may send that must never reach the log.
const marker = "persona@example.test";
const reportingApiReport = (overrides: Record<string, unknown> = {}) => ({
  type: "csp-violation",
  age: 12,
  url: `https://quenda.test/perfil?email=${marker}`,
  user_agent: `Agent ${marker}`,
  body: {
    documentURL: `https://quenda.test/municipios/ejemplo/unidades/1?email=${marker}#fragmento`,
    referrer: `https://quenda.test/?q=${marker}`,
    blockedURL: `https://cdn.example.test/ruta/script.js?token=${marker}`,
    effectiveDirective: "script-src-elem",
    originalPolicy: "default-src 'self'",
    sourceFile: `https://quenda.test/assets/app.js?${marker}`,
    sample: `alert('${marker}')`,
    disposition: "enforce",
    lineNumber: 10,
    columnNumber: 4,
    statusCode: 200,
    ...overrides,
  },
});

test("Reporting API reports log only directive, blocked origin, page path, disposition and status", async () => {
  const { app, lines, events } = await reportApp();
  try {
    const response = await post(
      app,
      "application/reports+json",
      JSON.stringify([
        reportingApiReport(),
        // A page of another origin is not about this instance.
        reportingApiReport({ documentURL: "https://other.example.test/a" }),
        reportingApiReport({
          blockedURL: "trusted-types-sink",
          effectiveDirective: "require-trusted-types-for",
          disposition: "report",
        }),
      ]),
      { cookie: "", origin: "https://quenda.test" },
    );
    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    const logged = events();
    assert.equal(logged.length, 2);
    const fields = (entry: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(entry).filter(
          ([key]) =>
            !["level", "time", "pid", "hostname", "reqId"].includes(key),
        ),
      );
    assert.deepEqual(fields(logged[0]), {
      event: "CSP_VIOLATION",
      directive: "script-src-elem",
      blocked: "https://cdn.example.test",
      documentPath: "/municipios/ejemplo/unidades/1",
      disposition: "enforce",
      status: 200,
      msg: "Content security policy violation",
    });
    assert.deepEqual(fields(logged[1]), {
      event: "CSP_VIOLATION",
      directive: "require-trusted-types-for",
      blocked: "trusted-types-sink",
      documentPath: "/municipios/ejemplo/unidades/1",
      disposition: "report",
      status: 200,
      msg: "Content security policy violation",
    });
    assert.match(String(logged[0].reqId), /./);
    const all = lines.join("\n");
    for (const leaked of [marker, "fragmento", "/ruta/", "token", "alert"])
      assert.ok(!all.includes(leaked), leaked);
  } finally {
    await app.close();
  }
});

test("legacy report-uri reports are accepted without session or Origin", async () => {
  const { app, events } = await reportApp();
  try {
    for (const [report, blocked, directive] of [
      [
        {
          "document-uri": `https://quenda.test/reservas?email=${marker}`,
          "violated-directive": "script-src 'self'",
          "blocked-uri": "inline",
          "original-policy": "script-src 'self'",
          "script-sample": marker,
          "status-code": 200,
        },
        "inline",
        "script-src",
      ],
      [
        {
          "document-uri": "https://quenda.test/",
          "effective-directive": "img-src",
          "violated-directive": "img-src",
          "blocked-uri": `blob:https://quenda.test/${marker}`,
          disposition: "enforce",
        },
        "blob:",
        "img-src",
      ],
    ] as const) {
      const response = await post(
        app,
        "application/csp-report; charset=utf-8",
        JSON.stringify({ "csp-report": report }),
      );
      assert.equal(response.statusCode, 204);
      assert.equal(response.body, "");
      const entry = events().at(-1);
      assert.equal(entry.blocked, blocked);
      assert.equal(entry.directive, directive);
      assert.ok(!JSON.stringify(entry).includes(marker));
    }
    assert.equal(events()[0].documentPath, "/reservas");
    assert.equal(events()[0].disposition, null);
  } finally {
    await app.close();
  }
});

test("oversized, malformed, invalid and non-report bodies are rejected without echoing them", async () => {
  const { app, events } = await reportApp();
  try {
    const cases = [
      [
        "application/reports+json",
        JSON.stringify([
          reportingApiReport({ sample: marker.repeat(16384 / marker.length) }),
        ]),
        413,
        "PAYLOAD_TOO_LARGE",
      ],
      [
        "application/csp-report",
        `{"csp-report": "${marker}`,
        400,
        "INVALID_INPUT",
      ],
      [
        "application/reports+json",
        JSON.stringify([{ ...reportingApiReport(), type: "deprecation" }]),
        400,
        "INVALID_INPUT",
      ],
      [
        "application/reports+json",
        JSON.stringify([reportingApiReport({ effectiveDirective: marker })]),
        400,
        "INVALID_INPUT",
      ],
      ["application/reports+json", "[]", 400, "INVALID_INPUT"],
      [
        "application/csp-report",
        JSON.stringify({ "csp-report": { "document-uri": marker } }),
        400,
        "INVALID_INPUT",
      ],
      [
        "application/json",
        JSON.stringify([reportingApiReport()]),
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ],
      ["text/plain", marker, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ] as const;
    for (const [contentType, payload, status, code] of cases) {
      const response = await post(app, contentType, payload);
      assert.equal(
        response.statusCode,
        status,
        `${contentType} ${payload.slice(0, 40)}`,
      );
      assert.equal(response.json().error.code, code);
      assert.ok(!response.body.includes(marker));
    }
    assert.equal(events().length, 0);
  } finally {
    await app.close();
  }
});

test("reports have their own public allowance per address", async () => {
  const { app, subjects, events } = await reportApp(2);
  try {
    const body = JSON.stringify([reportingApiReport()]);
    assert.equal(
      (await post(app, "application/reports+json", body)).statusCode,
      204,
    );
    assert.equal(
      (await post(app, "application/reports+json", body)).statusCode,
      204,
    );
    const limited = await post(app, "application/reports+json", body);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "RATE_LIMITED");
    assert.equal(limited.headers["retry-after"], "42");
    // Limited before parsing: the third report is not logged.
    assert.equal(events().length, 2);
    const subject = publicSubjectHash(
      config.secret,
      "csp-report\u0000192.0.2.80",
    );
    assert.deepEqual(subjects, [subject, subject, subject]);
    assert.notEqual(subject, publicSubjectHash(config.secret, "192.0.2.80"));
  } finally {
    await app.close();
  }
});

test("blocked sources keep an origin, a keyword or a scheme, never a path", () => {
  assert.equal(blockedSource(undefined), null);
  assert.equal(blockedSource(""), null);
  assert.equal(blockedSource("eval"), "eval");
  assert.equal(blockedSource("inline"), "inline");
  assert.equal(
    blockedSource("https://user:pass@cdn.example.test:8443/a?b#c"),
    "https://cdn.example.test:8443",
  );
  assert.equal(
    blockedSource("wss://socket.example.test/live"),
    "wss://socket.example.test",
  );
  assert.equal(blockedSource("data:text/html;base64,PHNjcmlwdD4="), "data:");
  assert.equal(
    blockedSource("chrome-extension://abcdef/script.js"),
    "chrome-extension:",
  );
  assert.equal(blockedSource("not a url"), "other");
});
