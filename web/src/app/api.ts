export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(
    status: number,
    code: string,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  locale: "es" | "gl" = "gl",
): Promise<T> {
  // Relative same-origin requests only: cookies and CSRF policy stay with Quenda.
  if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("Invalid API path");
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("accept-language", locale);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.code ?? "REQUEST_FAILED",
      data.error?.message ??
        (locale === "gl"
          ? "Non se puido completar a solicitude."
          : "No se pudo completar la solicitud."),
      data.requestId,
    );
  return data as T;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Account {
  accountId: string;
  email: string;
  mfaVerified: boolean;
}
export interface Municipality {
  id: string;
  name: string;
  timeZone: string;
}
export interface Appearance {
  version: number;
  lightPalette: "neutral" | "blue" | "green";
  darkPalette: "neutral" | "blue" | "green";
  defaultTheme: "light" | "dark";
}
export interface Navigation {
  municipalities: Page<{
    id: string;
    name: string;
    administrator: boolean;
    permissions: { operation: string; unitId: string | null }[];
  }>;
  platform: { operator: boolean; permissions: string[] };
}
