-- Existing reservations and publication history are preserved. A legacy unit
-- without usable current rules is absent from public projections until fixed.
ALTER TABLE domain.unit_usage_rules
 ADD CONSTRAINT usage_rules_nonblank CHECK(text_content ~ '[^[:space:]]') NOT VALID;

CREATE OR REPLACE FUNCTION domain.public_units(tenant uuid,facility uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id FROM domain.reservable_unit u
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 WHERE u.tenant_id=tenant AND f.id=facility AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND u.calendar_version IS NOT NULL
 AND rules.text_content ~ '[^[:space:]]'
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT 21
$$;
DROP FUNCTION domain.public_unit_calendar(uuid,uuid);
CREATE FUNCTION domain.public_unit_calendar(tenant uuid,unit uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,timezone text,municipal_advance_days integer,cancellation_minutes integer,version integer,calendar jsonb,booking_policy_version integer,usage_rules_version integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,m.timezone,m.advance_days,m.cancellation_minutes,v.version,
 jsonb_build_object('minimumMinutes',v.minimum_minutes,'maximumMinutes',v.maximum_minutes,'stepMinutes',v.step_minutes,'advanceDays',v.advance_days,'weekly',v.weekly,'exceptions',v.exceptions),
 m.booking_policy_version,u.usage_rules_version
 FROM domain.reservable_unit u JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.municipality m ON m.id=u.tenant_id
 JOIN domain.unit_calendar_version v ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.calendar_version)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 WHERE u.tenant_id=tenant AND u.id=unit AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND rules.text_content ~ '[^[:space:]]'
$$;
CREATE OR REPLACE FUNCTION domain.public_unit_usage_rules(tenant uuid,resource uuid) RETURNS TABLE(version integer,text_content text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT v.version,v.text_content FROM domain.unit_usage_rules v
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id,u.usage_rules_version)=(v.tenant_id,v.unit_id,v.version)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE u.tenant_id=tenant AND u.id=resource AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND v.text_content ~ '[^[:space:]]'
$$;
REVOKE ALL ON FUNCTION domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid),domain.public_unit_usage_rules(uuid,uuid)
 FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid),domain.public_unit_usage_rules(uuid,uuid)
 TO quenda_domain;

-- Guard new publication transitions without rewriting previously published
-- rows. The unit row lock serializes publication with changes to its rules.
CREATE FUNCTION domain.check_publication_usage_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.published_at IS NOT NULL AND NEW.withdrawn_at IS NULL AND NOT EXISTS(
  SELECT 1 FROM domain.unit_usage_rules v
  WHERE (v.tenant_id,v.unit_id,v.version)=(NEW.tenant_id,NEW.id,NEW.usage_rules_version)
  AND v.text_content ~ '[^[:space:]]'
 ) THEN RAISE EXCEPTION 'Usage rules required for publication' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION domain.check_publication_usage_rules() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE TRIGGER publication_usage_rules BEFORE INSERT OR UPDATE OF published_at,withdrawn_at ON domain.reservable_unit
 FOR EACH ROW EXECUTE FUNCTION domain.check_publication_usage_rules();
