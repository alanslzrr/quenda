-- What a citizen needs to choose a facility: where it is, what it offers, how accessible it is and whom to ask.
-- Every field is optional and published together with the facility; none is required to publish.
ALTER TABLE domain.facility
 ADD COLUMN address text CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 300),
 ADD COLUMN postal_code text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'),
 ADD COLUMN latitude numeric(8,6) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
 ADD COLUMN longitude numeric(9,6) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
 ADD COLUMN description_gl text CHECK (description_gl IS NULL OR length(btrim(description_gl)) BETWEEN 1 AND 1000),
 ADD COLUMN description_es text CHECK (description_es IS NULL OR length(btrim(description_es)) BETWEEN 1 AND 1000),
 ADD COLUMN accessibility_gl text CHECK (accessibility_gl IS NULL OR length(btrim(accessibility_gl)) BETWEEN 1 AND 1000),
 ADD COLUMN accessibility_es text CHECK (accessibility_es IS NULL OR length(btrim(accessibility_es)) BETWEEN 1 AND 1000),
 ADD COLUMN contact_phone text CHECK (contact_phone IS NULL OR contact_phone ~ '^[0-9+() .-]{3,30}$'),
 ADD COLUMN contact_email text CHECK (contact_email IS NULL OR (length(contact_email)<=254 AND contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
 ADD COLUMN profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
 ADD CONSTRAINT facility_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL));
ALTER TABLE domain.reservable_unit
 ADD COLUMN kind text CHECK (kind IS NULL OR kind IN ('polideportiva','pabellon','futbol','tenis','padel','piscina','sala','gimnasio','atletismo','otro')),
 ADD COLUMN indoor boolean,
 ADD COLUMN capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 10000),
 ADD COLUMN description_gl text CHECK (description_gl IS NULL OR length(btrim(description_gl)) BETWEEN 1 AND 1000),
 ADD COLUMN description_es text CHECK (description_es IS NULL OR length(btrim(description_es)) BETWEEN 1 AND 1000),
 ADD COLUMN profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0);

GRANT UPDATE (address,postal_code,latitude,longitude,description_gl,description_es,accessibility_gl,accessibility_es,contact_phone,contact_email,profile_version) ON domain.facility TO quenda_domain;
GRANT UPDATE (kind,indoor,capacity,description_gl,description_es,profile_version) ON domain.reservable_unit TO quenda_domain;

-- One JSON shape for the profile, used by the public projections and the administrative read.
CREATE FUNCTION domain.facility_profile_json(f domain.facility) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'address',f.address,'postalCode',f.postal_code,
  'location',CASE WHEN f.latitude IS NULL THEN NULL ELSE jsonb_build_object('latitude',f.latitude,'longitude',f.longitude) END,
  'description',nullif(jsonb_strip_nulls(jsonb_build_object('gl',f.description_gl,'es',f.description_es)),'{}'::jsonb),
  'accessibility',nullif(jsonb_strip_nulls(jsonb_build_object('gl',f.accessibility_gl,'es',f.accessibility_es)),'{}'::jsonb),
  'contact',nullif(jsonb_strip_nulls(jsonb_build_object('phone',f.contact_phone,'email',f.contact_email)),'{}'::jsonb)))
$$;
CREATE FUNCTION domain.unit_profile_json(u domain.reservable_unit) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object(
  'kind',u.kind,'indoor',u.indoor,'capacity',u.capacity,
  'description',nullif(jsonb_strip_nulls(jsonb_build_object('gl',u.description_gl,'es',u.description_es)),'{}'::jsonb)))
$$;
REVOKE ALL ON FUNCTION domain.facility_profile_json(domain.facility),domain.unit_profile_json(domain.reservable_unit) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.facility_profile_json(domain.facility),domain.unit_profile_json(domain.reservable_unit) TO quenda_domain;

CREATE TABLE domain.catalog_profile_event (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 facility_id uuid NOT NULL,
 unit_id uuid,
 version integer NOT NULL CHECK (version > 1),
 previous_state jsonb NOT NULL,
 next_state jsonb NOT NULL,
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,facility_id) REFERENCES domain.facility(tenant_id,id),
 FOREIGN KEY (tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id)
);
CREATE INDEX catalog_profile_event_resource ON domain.catalog_profile_event(tenant_id,facility_id,unit_id,version);
ALTER TABLE domain.catalog_profile_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.catalog_profile_event FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_profile_event_maintenance ON domain.catalog_profile_event TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY catalog_profile_event_read ON domain.catalog_profile_event FOR SELECT TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND (domain.lock_permission('CATALOG_CREATE',NULL) OR domain.lock_permission('CATALOG_MANAGE',NULL)));
CREATE POLICY catalog_profile_event_append ON domain.catalog_profile_event FOR INSERT TO quenda_domain
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND actor_id=nullif(current_setting('quenda.account_id',true),'')
  AND ((unit_id IS NULL AND domain.lock_permission('CATALOG_MANAGE',NULL))
    OR (unit_id IS NOT NULL AND domain.lock_permission('CATALOG_MANAGE',unit_id))));
GRANT SELECT,INSERT ON domain.catalog_profile_event TO quenda_domain;

-- Public projections carry the profile of what they list. Only published, non-withdrawn resources are visible.
DROP FUNCTION domain.public_facilities(uuid,uuid);
CREATE FUNCTION domain.public_facilities(tenant uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,units integer,profile jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT f.id,f.name,(
  SELECT count(*)::integer FROM domain.reservable_unit u
  JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
  WHERE (u.tenant_id,u.facility_id)=(f.tenant_id,f.id) AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
  AND u.calendar_version IS NOT NULL AND rules.text_content ~ '[^[:space:]]'
 ),domain.facility_profile_json(f) FROM domain.facility f WHERE f.tenant_id=tenant
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND (after_id IS NULL OR f.id>after_id)
 ORDER BY f.id LIMIT 21
$$;
DROP FUNCTION domain.public_units(uuid,uuid,uuid);
CREATE FUNCTION domain.public_units(tenant uuid,facility uuid,after_id uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,minimum_minutes integer,maximum_minutes integer,profile jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,c.minimum_minutes,c.maximum_minutes,domain.unit_profile_json(u)
 FROM domain.reservable_unit u
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 JOIN domain.unit_calendar_version c ON (c.tenant_id,c.unit_id,c.version)=(u.tenant_id,u.id,u.calendar_version)
 WHERE u.tenant_id=tenant AND f.id=facility AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND u.calendar_version IS NOT NULL
 AND rules.text_content ~ '[^[:space:]]'
 AND (after_id IS NULL OR u.id>after_id) ORDER BY u.id LIMIT 21
$$;
DROP FUNCTION domain.public_unit_calendar(uuid,uuid);
CREATE FUNCTION domain.public_unit_calendar(tenant uuid,unit uuid)
RETURNS TABLE(id uuid,name text,facility_id uuid,timezone text,municipal_advance_days integer,cancellation_minutes integer,version integer,calendar jsonb,booking_policy_version integer,usage_rules_version integer,facility_name text,profile jsonb,facility_profile jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT u.id,u.name,u.facility_id,m.timezone,m.advance_days,m.cancellation_minutes,v.version,
 jsonb_build_object('minimumMinutes',v.minimum_minutes,'maximumMinutes',v.maximum_minutes,'stepMinutes',v.step_minutes,'advanceDays',v.advance_days,'weekly',v.weekly,'exceptions',v.exceptions),
 m.booking_policy_version,u.usage_rules_version,f.name,domain.unit_profile_json(u),domain.facility_profile_json(f)
 FROM domain.reservable_unit u JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 JOIN domain.municipality m ON m.id=u.tenant_id
 JOIN domain.unit_calendar_version v ON (v.tenant_id,v.unit_id,v.version)=(u.tenant_id,u.id,u.calendar_version)
 JOIN domain.unit_usage_rules rules ON (rules.tenant_id,rules.unit_id,rules.version)=(u.tenant_id,u.id,u.usage_rules_version)
 WHERE u.tenant_id=tenant AND u.id=unit AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL AND rules.text_content ~ '[^[:space:]]'
$$;
REVOKE ALL ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_facilities(uuid,uuid),domain.public_units(uuid,uuid,uuid),domain.public_unit_calendar(uuid,uuid) TO quenda_domain;
