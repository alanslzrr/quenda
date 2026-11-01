-- Public lists describe what a visitor can still choose: how many offerable
-- units a facility has, and the booking length range of each unit.
DROP FUNCTION domain.public_facilities(uuid,uuid);
CREATE FUNCTION domain.public_facilities(tenant uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,units integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.id,f.name,(
  SELECT count(*)::integer FROM domain.reservable_unit u
  JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
  WHERE (u.tenant_id,u.facility_id)=(f.tenant_id,f.id) AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
  AND u.calendar_version IS NOT NULL AND rules.text_content ~ '[^[:space:]]'
 ) FROM domain.facility f WHERE f.tenant_id=tenant
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND (after_id IS NULL OR f.id>after_id)
 ORDER BY f.id LIMIT 21
$$;

DROP FUNCTION domain.public_units(uuid,uuid,uuid);
CREATE FUNCTION domain.public_units(tenant uuid,facility uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,minimum_minutes integer,maximum_minutes integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,c.minimum_minutes,c.maximum_minutes
 FROM domain.reservable_unit u
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 JOIN domain.unit_calendar_version c ON (c.tenant_id,c.unit_id,c.version)=(u.tenant_id,u.id,u.calendar_version)
 WHERE u.tenant_id=tenant AND f.id=facility AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND u.calendar_version IS NOT NULL
 AND rules.text_content ~ '[^[:space:]]'
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT 21
$$;

REVOKE ALL ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid)
 FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid) TO quenda_domain;
