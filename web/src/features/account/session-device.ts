// Describe only information supplied by the user agent; no inferred location or device identity.
export function sessionDevice(
  agent: string | null | undefined,
  locale: "es" | "gl",
) {
  if (!agent)
    return locale === "es"
      ? "Navegador no identificado"
      : "Navegador non identificado";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : locale === "es"
            ? "Navegador"
            : "Navegador";
  const platform = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Windows/.test(agent)
        ? "Windows"
        : /Macintosh|Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : null;
  return platform ? `${browser} · ${platform}` : browser;
}
