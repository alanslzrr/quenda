import { isIP } from "node:net";

type Range = { start: bigint; end: bigint };
const mappedStart = 0xffff00000000n;
const ipv4End = (1n << 32n) - 1n;

function range(address: string, family: number, prefix: number): Range {
  // URL canonicalizes embedded IPv4 and compressed IPv6, after strict isIP validation.
  const parts =
    family === 4
      ? address.split(".")
      : new URL(`http://[${address}]`).hostname.slice(1, -1).split(":");
  if (family === 6 && parts.includes("")) {
    const empty = parts.indexOf("");
    const nonempty = parts.filter(Boolean).length;
    parts.splice(
      empty,
      parts.length - nonempty,
      ...Array<string>(8 - nonempty).fill("0"),
    );
  }
  const bits = family === 4 ? 32 : 128;
  const value = parts.reduce(
    (total, part) =>
      (total << BigInt(family === 4 ? 8 : 16)) +
      BigInt(Number.parseInt(part, family === 4 ? 10 : 16)),
    0n,
  );
  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  return { start, end: start + (1n << hostBits) - 1n };
}
function coversAll(ranges: Range[], end: bigint) {
  let next = 0n;
  for (const item of ranges.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  )) {
    if (item.start > next) return false;
    if (item.end >= next) next = item.end + 1n;
  }
  return next > end;
}
export function trustedProxies(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const values = raw.split(",").map((v) => v.trim());
  const v4: Range[] = [],
    v6: Range[] = [];
  const invalid = () => new Error("Invalid configuration: TRUSTED_PROXY_CIDRS");
  for (const value of values) {
    const [address = "", prefix, ...extra] = value.split("/");
    const family = isIP(address);
    if (
      !family ||
      address.includes("%") ||
      extra.length ||
      (prefix !== undefined &&
        (!/^[1-9]\d*$/.test(prefix) ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw invalid();
    const subnet = range(
      address,
      family,
      Number(prefix ?? (family === 4 ? 32 : 128)),
    );
    if (family === 4) v4.push(subnet);
    else {
      v6.push(subnet);
      // Fastify compares IPv4 peers as mapped IPv6 against IPv6 subnets.
      const start = subnet.start > mappedStart ? subnet.start : mappedStart;
      const end =
        subnet.end < mappedStart + ipv4End ? subnet.end : mappedStart + ipv4End;
      if (start <= end)
        v4.push({ start: start - mappedStart, end: end - mappedStart });
    }
  }
  if (coversAll(v4, ipv4End) || coversAll(v6, (1n << 128n) - 1n))
    throw invalid();
  return [...new Set(values)];
}
