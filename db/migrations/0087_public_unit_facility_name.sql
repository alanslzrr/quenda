-- The public unit detail names its facility so clients need not page the catalog.
DROP FUNCTION domain.public_unit_calendar(uuid,uuid);
CREATE FUNCTION domain.public_unit_calendar(tenant uuid,unit uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,timezone text,municipal_advance_days integer,cancellation_minutes integer,version integer,calendar jsonb,booking_policy_version integer,usage_rules_version integer,facility_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,m.timezone,m.advance_days,m.cancellation_minutes,v.version,
 jsonb_build_object('minimumMinutes',v.minimum_minutes,'maximumMinutes',v.maximum_minutes,'stepMinutes',v.step_minutes,'advanceDays',v.advance_days,'weekly',v.weekly,'exceptions',v.exceptions),
 m.booking_policy_version,u.usage_rules_version,f.name
 FROM domain.reservable_unit u JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.municipality m ON m.id=u.tenant_id
 JOIN domain.unit_calendar_version v ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.calendar_version)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 WHERE u.tenant_id=tenant AND u.id=unit AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND rules.text_content ~ '[^[:space:]]'
$$;
REVOKE ALL ON FUNCTION domain.public_unit_calendar(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_unit_calendar(uuid,uuid) TO quenda_domain;
