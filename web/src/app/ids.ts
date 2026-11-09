const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined): value is string {
  return value !== undefined && uuid.test(value);
}

/** Route parameters that name a resource; every one is a UUID, so anything else cannot reach `/api/`. */
export function hasInvalidIds(
  params: Readonly<Record<string, string | undefined>>,
) {
  return Object.entries(params).some(
    ([name, value]) =>
      /Id$/.test(name) && value !== undefined && !isUuid(value),
  );
}
