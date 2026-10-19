CREATE INDEX reservation_account_page ON domain.reservation(account_id,id,tenant_id);
CREATE FUNCTION domain.own_reservations(after_id uuid,after_tenant uuid)
RETURNS TABLE(tenant_id uuid,id uuid,unit_id uuid,starts_at timestamptz,ends_at timestamptz,status text,
 revision integer,calendar_version integer,cancellation_minutes integer,timezone text,municipality text,unit_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.unit_id,r.starts_at,r.ends_at,r.status,r.revision,r.calendar_version,r.cancellation_minutes,r.timezone,m.name,u.name
 FROM domain.reservation r JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND (after_id IS NULL OR (r.id,r.tenant_id)>(after_id,after_tenant))
 ORDER BY r.id,r.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservations(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_reservations(uuid,uuid) TO quenda_domain;
