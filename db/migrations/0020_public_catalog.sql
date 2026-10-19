-- Public, fixed projections. No municipal identity context is needed or created.
CREATE FUNCTION domain.public_facilities(tenant uuid,after_id uuid)
RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.id,f.name FROM domain.facility f WHERE f.tenant_id=tenant
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND (after_id IS NULL OR f.id>after_id)
 ORDER BY f.id LIMIT 21
$$;
CREATE FUNCTION domain.public_units(tenant uuid,facility uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id FROM domain.reservable_unit u JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE u.tenant_id=tenant AND f.id=facility AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND u.calendar_version IS NOT NULL
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT 21
$$;
CREATE FUNCTION domain.public_unit_calendar(tenant uuid,unit uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,timezone text,municipal_advance_days integer,cancellation_minutes integer,version integer,calendar jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,m.timezone,m.advance_days,m.cancellation_minutes,v.version,
 jsonb_build_object('minimumMinutes',v.minimum_minutes,'maximumMinutes',v.maximum_minutes,'stepMinutes',v.step_minutes,'advanceDays',v.advance_days,'weekly',v.weekly,'exceptions',v.exceptions)
 FROM domain.reservable_unit u JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.municipality m ON m.id=u.tenant_id
 JOIN domain.unit_calendar_version v ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.calendar_version)
 WHERE u.tenant_id=tenant AND u.id=unit AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL
$$;
REVOKE ALL ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid) TO quenda_domain;
