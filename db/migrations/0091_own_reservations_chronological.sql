-- "My reservations" lists the most recent first. The cursor is the full sort key
-- (start, id, municipality), so pages neither repeat nor skip rows that share a start.
-- cursor_start carries the start with microsecond precision for that cursor.
DROP FUNCTION domain.own_reservations(uuid,uuid,uuid);
CREATE FUNCTION domain.own_reservations(after_start timestamptz,after_id uuid,after_tenant uuid,filter_tenant uuid DEFAULT NULL)
RETURNS TABLE(tenant_id uuid,id uuid,unit_id uuid,starts_at timestamptz,ends_at timestamptz,status text,
 revision integer,calendar_version integer,cancellation_minutes integer,timezone text,municipality text,unit_name text,
 usage_rules_version integer,rules_accepted_at timestamptz,booking_policy_version integer,conditions_accepted_at timestamptz,
 non_cancellable_accepted boolean,usage_rules_unit_id uuid,pending_usage_rules_version integer,cursor_start text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.unit_id,r.starts_at,r.ends_at,r.status,r.revision,r.calendar_version,r.cancellation_minutes,r.timezone,
 m.name,u.name,r.usage_rules_version,r.rules_accepted_at,r.booking_policy_version,r.conditions_accepted_at,r.non_cancellable_accepted,
 r.usage_rules_unit_id,r.pending_usage_rules_version,
 to_char(r.starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 FROM domain.reservation r JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND (filter_tenant IS NULL OR r.tenant_id=filter_tenant)
 AND (after_id IS NULL OR (r.starts_at,r.id,r.tenant_id)<(after_start,after_id,after_tenant))
 ORDER BY r.starts_at DESC,r.id DESC,r.tenant_id DESC LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservations(timestamptz,uuid,uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservations(timestamptz,uuid,uuid,uuid) TO quenda_domain;

-- Municipalities where the account holds reservations, for the history filter.
-- It is the account's own footprint, not a directory of municipalities.
CREATE FUNCTION domain.own_reservation_municipalities(after_tenant uuid)
RETURNS TABLE(tenant_id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.id,m.name FROM domain.municipality m
 WHERE (after_tenant IS NULL OR m.id>after_tenant)
 AND EXISTS(SELECT 1 FROM domain.reservation r WHERE r.tenant_id=m.id
   AND r.account_id=nullif(current_setting('quenda.account_id',true),''))
 ORDER BY m.id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservation_municipalities(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservation_municipalities(uuid) TO quenda_domain;

-- Matches the history sort key so each page is an index range scan.
CREATE INDEX reservation_owner_recent ON domain.reservation(account_id,starts_at DESC,id DESC,tenant_id DESC);
