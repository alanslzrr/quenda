import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

export function browser(
  app: FastifyInstance,
  remoteAddress: string,
  origin = "https://quenda.test",
) {
  const cookies = new Map<string, string>();
  return {
    cookie: () =>
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    async request(
      url: string,
      body?: Record<string, unknown>,
      extraHeaders: Record<string, string> = {},
    ) {
      const response = await app.inject({
        method: body ? "POST" : "GET",
        url,
        remoteAddress,
        headers: {
          origin,
          cookie: [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
          ...extraHeaders,
        },
        ...(body ? { payload: body } : {}),
      });
      const setCookies = response.headers["set-cookie"];
      for (const cookie of typeof setCookies === "string"
        ? [setCookies]
        : (setCookies ?? [])) {
        const pair = cookie.split(";")[0] ?? "";
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (!value || /max-age=0/i.test(cookie)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return response;
    },
  };
}

// Independent RFC 6238 test implementation; production verification is Better Auth's.
export function totp(secret: string, stepOffset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid test TOTP secret");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
    Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = (mac[19] ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
