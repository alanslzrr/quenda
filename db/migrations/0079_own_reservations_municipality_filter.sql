DROP FUNCTION domain.own_reservations(uuid,uuid);
CREATE FUNCTION domain.own_reservations(after_id uuid,after_tenant uuid,filter_tenant uuid DEFAULT NULL)
RETURNS TABLE(tenant_id uuid,id uuid,unit_id uuid,starts_at timestamptz,ends_at timestamptz,status text,
 revision integer,calendar_version integer,cancellation_minutes integer,timezone text,municipality text,unit_name text,
 usage_rules_version integer,rules_accepted_at timestamptz,booking_policy_version integer,conditions_accepted_at timestamptz,
 non_cancellable_accepted boolean,usage_rules_unit_id uuid,pending_usage_rules_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.tenant_id,r.id,r.unit_id,r.starts_at,r.ends_at,r.status,r.revision,r.calendar_version,r.cancellation_minutes,r.timezone,
 m.name,u.name,r.usage_rules_version,r.rules_accepted_at,r.booking_policy_version,r.conditions_accepted_at,r.non_cancellable_accepted,
 r.usage_rules_unit_id,r.pending_usage_rules_version
 FROM domain.reservation r JOIN domain.municipality m ON m.id=r.tenant_id
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(r.tenant_id,r.unit_id)
 WHERE r.account_id=nullif(current_setting('quenda.account_id',true),'')
 AND (filter_tenant IS NULL OR r.tenant_id=filter_tenant)
 AND (after_id IS NULL OR (r.id,r.tenant_id)>(after_id,after_tenant))
 ORDER BY r.id,r.tenant_id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_reservations(uuid,uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_reservations(uuid,uuid,uuid) TO quenda_domain;
