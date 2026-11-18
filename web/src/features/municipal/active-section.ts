/**
 * The management section a path belongs to. Sections own their path and the
 * paths below it; the catalogue section sits at the municipality's root, so it
 * owns only that root and its facility and unit pages. A page outside every
 * listed section (one the person has no permission for) highlights none.
 */
export function activeSection(ids: string[], pathname: string, base: string) {
  // A reservation opened from the agenda (or from its access code) belongs to the agenda.
  const current = pathname.startsWith(`${base}/reservas/`)
    ? `${base}/agenda`
    : pathname.replace(/\/+$/, "");
  const owns = (id: string) =>
    id === base
      ? current === base ||
        current.startsWith(`${base}/instalaciones/`) ||
        current.startsWith(`${base}/unidades/`)
      : current === id || current.startsWith(`${id}/`);
  return ids.filter(owns).sort((a, b) => b.length - a.length)[0] ?? "";
}
