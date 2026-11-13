-- Photographs of a facility or of one of its units, shown in the public catalog.
-- The server stores only its own re-encoding (two sizes, no metadata), never the
-- uploaded file. A unit photo also records its facility so both lists share one
-- ordering rule. Position 1 is the cover.
CREATE TABLE domain.catalog_photo (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 facility_id uuid NOT NULL,
 unit_id uuid,
 position smallint NOT NULL CHECK (position BETWEEN 1 AND 6),
 alt_gl text NOT NULL CHECK (length(btrim(alt_gl)) BETWEEN 1 AND 250),
 alt_es text NOT NULL CHECK (length(btrim(alt_es)) BETWEEN 1 AND 250),
 width integer NOT NULL CHECK (width BETWEEN 900 AND 1500),
 height integer NOT NULL CHECK (height BETWEEN 600 AND 1000),
 large bytea NOT NULL CHECK (octet_length(large) BETWEEN 1 AND 2000000),
 small bytea NOT NULL CHECK (octet_length(small) BETWEEN 1 AND 500000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,facility_id) REFERENCES domain.facility(tenant_id,id),
 FOREIGN KEY (tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 -- Deferred so a reorder can swap positions inside one transaction.
 CONSTRAINT catalog_photo_position UNIQUE NULLS NOT DISTINCT (tenant_id,facility_id,unit_id,position) DEFERRABLE INITIALLY DEFERRED
);
-- WebP is already compressed; skip the futile TOAST compression attempt.
ALTER TABLE domain.catalog_photo ALTER COLUMN large SET STORAGE EXTERNAL, ALTER COLUMN small SET STORAGE EXTERNAL;
CREATE INDEX catalog_photo_unit ON domain.catalog_photo(tenant_id,unit_id) WHERE unit_id IS NOT NULL;
ALTER TABLE domain.catalog_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.catalog_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_photo_maintenance ON domain.catalog_photo TO quenda_migrator USING (true) WITH CHECK (true);
-- Facility photos follow the facility profile (CATALOG_MANAGE without a unit);
-- unit photos follow the unit, so a manager limited to one unit maintains its photos.
CREATE POLICY catalog_photo_read ON domain.catalog_photo FOR SELECT TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND (domain.lock_permission('CATALOG_CREATE',NULL) OR domain.lock_permission('CATALOG_MANAGE',unit_id)));
CREATE POLICY catalog_photo_add ON domain.catalog_photo FOR INSERT TO quenda_domain
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND domain.lock_permission('CATALOG_MANAGE',unit_id));
CREATE POLICY catalog_photo_change ON domain.catalog_photo FOR UPDATE TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND domain.lock_permission('CATALOG_MANAGE',unit_id))
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND domain.lock_permission('CATALOG_MANAGE',unit_id));
CREATE POLICY catalog_photo_remove ON domain.catalog_photo FOR DELETE TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND domain.lock_permission('CATALOG_MANAGE',unit_id));
GRANT SELECT,INSERT,DELETE ON domain.catalog_photo TO quenda_domain;
GRANT UPDATE (position,alt_gl,alt_es) ON domain.catalog_photo TO quenda_domain;

CREATE TABLE domain.catalog_photo_event (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 facility_id uuid NOT NULL,
 unit_id uuid,
 photo_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('ADDED','DESCRIBED','MOVED','REMOVED')),
 previous_state jsonb,
 next_state jsonb,
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,facility_id) REFERENCES domain.facility(tenant_id,id),
 FOREIGN KEY (tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 CHECK ((action='ADDED')=(previous_state IS NULL) AND (action='REMOVED')=(next_state IS NULL))
);
CREATE INDEX catalog_photo_event_resource ON domain.catalog_photo_event(tenant_id,facility_id,unit_id,occurred_at);
ALTER TABLE domain.catalog_photo_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.catalog_photo_event FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_photo_event_maintenance ON domain.catalog_photo_event TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY catalog_photo_event_read ON domain.catalog_photo_event FOR SELECT TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND (domain.lock_permission('CATALOG_CREATE',NULL) OR domain.lock_permission('CATALOG_MANAGE',NULL)));
CREATE POLICY catalog_photo_event_append ON domain.catalog_photo_event FOR INSERT TO quenda_domain
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND actor_id=nullif(current_setting('quenda.account_id',true),'')
  AND domain.lock_permission('CATALOG_MANAGE',unit_id));
GRANT SELECT,INSERT ON domain.catalog_photo_event TO quenda_domain;

-- Public reads: a photo is visible only while its facility, and its unit when it
-- has one, are published and not withdrawn, the same rule as the profile.
CREATE FUNCTION domain.public_catalog_photos(tenant uuid,owners uuid[])
RETURNS TABLE(owner_id uuid,id uuid,alt_gl text,alt_es text,width integer,height integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(p.unit_id,p.facility_id),p.id,p.alt_gl,p.alt_es,p.width,p.height
 FROM domain.catalog_photo p
 JOIN domain.facility f ON (f.tenant_id,f.id)=(p.tenant_id,p.facility_id)
 LEFT JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(p.tenant_id,p.unit_id)
 WHERE p.tenant_id=tenant AND coalesce(p.unit_id,p.facility_id)=ANY(owners[1:100])
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL
 AND (p.unit_id IS NULL OR (u.published_at IS NOT NULL AND u.withdrawn_at IS NULL))
 ORDER BY 1,p.position
$$;
CREATE FUNCTION domain.public_catalog_photo_content(tenant uuid,photo uuid,large_size boolean)
RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN large_size THEN p.large ELSE p.small END
 FROM domain.catalog_photo p
 JOIN domain.facility f ON (f.tenant_id,f.id)=(p.tenant_id,p.facility_id)
 LEFT JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(p.tenant_id,p.unit_id)
 WHERE p.tenant_id=tenant AND p.id=photo
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL
 AND (p.unit_id IS NULL OR (u.published_at IS NOT NULL AND u.withdrawn_at IS NULL))
$$;
REVOKE ALL ON FUNCTION domain.public_catalog_photos(uuid,uuid[]),domain.public_catalog_photo_content(uuid,uuid,boolean) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_catalog_photos(uuid,uuid[]),domain.public_catalog_photo_content(uuid,uuid,boolean) TO quenda_domain;
