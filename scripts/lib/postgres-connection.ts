export function postgresCommandConnection(connection: string) {
  const url = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1) ||
    url.hash
  )
    throw new Error("Invalid PostgreSQL connection");
  for (const key of url.searchParams.keys())
    if (
      ![
        "sslmode",
        "sslrootcert",
        "sslcert",
        "sslkey",
        "connect_timeout",
      ].includes(key)
    )
      throw new Error("Unsupported PostgreSQL connection option");
  const password = decodeURIComponent(url.password);
  url.password = "";
  return { url, password };
}
