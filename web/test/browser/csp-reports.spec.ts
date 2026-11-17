import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { test } from "./fixtures";

interface Violation {
  documentURL: string;
  effectiveDirective: string;
  blockedURL: string;
  disposition: string;
  statusCode: number;
  originalPolicy: string;
  sample: string;
}

/**
 * The development server only sends the Trusted Types rule. The production web image's headers are read from its
 * configuration: the page gets its image directive and reporting directives, a blocked image raises a real violation,
 * and that violation, in both delivery formats, is accepted by the same-origin endpoint.
 */
test("the production policy reports violations to the same-origin endpoint", async ({
  page,
}) => {
  const headers = await readFile("nginx/security-headers.conf", "utf8");
  const policy = /Content-Security-Policy "([^"]+)"/.exec(headers)?.[1] ?? "";
  const endpoints = /Reporting-Endpoints '([^']+)'/.exec(headers)?.[1];
  expect(endpoints).toBe('csp="/api/csp-reports"');
  const directives = policy.split(";").map((directive) => directive.trim());
  expect(directives).toContain("report-uri /api/csp-reports");
  expect(directives).toContain("report-to csp");
  expect(directives).toContain("require-trusted-types-for 'script'");
  expect(directives).toContain("trusted-types default");
  const image = directives.find((directive) => directive.startsWith("img-src"));
  expect(image).toBeTruthy();

  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      if (route.request().resourceType() !== "document")
        return route.fallback();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": `${image}; report-uri /api/csp-reports; report-to csp`,
          "reporting-endpoints": endpoints ?? "",
        },
      });
    },
  );
  await page.goto("/");
  const violation = await page.evaluate(
    () =>
      new Promise<Violation>((resolve) => {
        document.addEventListener(
          "securitypolicyviolation",
          (event) =>
            resolve({
              documentURL: event.documentURI,
              effectiveDirective: event.effectiveDirective,
              blockedURL: event.blockedURI,
              disposition: event.disposition,
              statusCode: event.statusCode,
              originalPolicy: event.originalPolicy,
              sample: event.sample,
            }),
          { once: true },
        );
        const blocked = document.createElement("img");
        blocked.src = "https://images.example.test/blocked.png?id=1";
        document.body.append(blocked);
      }),
  );
  expect(violation.effectiveDirective).toBe("img-src");
  expect(violation.disposition).toBe("enforce");
  expect(violation.originalPolicy).toContain("report-to csp");

  const replies = await page.evaluate(async (body) => {
    const send = async (type: string, payload: unknown) => {
      const response = await fetch("/api/csp-reports", {
        method: "POST",
        headers: { "content-type": type },
        body: JSON.stringify(payload),
      });
      return { status: response.status, body: await response.text() };
    };
    return [
      await send("application/reports+json", [
        {
          type: "csp-violation",
          age: 0,
          url: location.href,
          user_agent: navigator.userAgent,
          body,
        },
      ]),
      await send("application/csp-report", {
        "csp-report": {
          "document-uri": body.documentURL,
          "effective-directive": body.effectiveDirective,
          "violated-directive": body.effectiveDirective,
          "blocked-uri": body.blockedURL,
          "original-policy": body.originalPolicy,
          disposition: body.disposition,
          "status-code": body.statusCode,
          "script-sample": body.sample,
        },
      }),
    ];
  }, violation);
  expect(replies).toEqual([
    { status: 204, body: "" },
    { status: 204, body: "" },
  ]);
});
