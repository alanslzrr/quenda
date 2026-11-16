-- A municipality presents itself with a name and a logo of its own. The name chosen by the platform operator at
-- creation is kept as the official name; the municipal administration may change the name shown everywhere.
-- Logos are the server's own WebP re-encoding of an uploaded image, never the uploaded file.
ALTER TABLE domain.municipality
 ADD COLUMN official_name text CHECK (official_name IS NULL OR length(btrim(official_name)) BETWEEN 1 AND 200),
 ADD COLUMN branding_version integer NOT NULL DEFAULT 1 CHECK (branding_version>0);
UPDATE domain.municipality SET official_name=name;
ALTER TABLE domain.municipality ALTER COLUMN official_name SET NOT NULL;
CREATE FUNCTION domain.keep_official_name() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 NEW.official_name:=coalesce(NEW.official_name,NEW.name);
 RETURN NEW;
END $$;
CREATE TRIGGER municipality_official_name BEFORE INSERT ON domain.municipality
 FOR EACH ROW EXECUTE FUNCTION domain.keep_official_name();

CREATE TABLE domain.municipal_logo (
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 variant text NOT NULL CHECK (variant IN ('light','dark')),
 width integer NOT NULL CHECK (width BETWEEN 32 AND 512),
 height integer NOT NULL CHECK (height BETWEEN 32 AND 512),
 image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 400000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (tenant_id,variant)
);
ALTER TABLE domain.municipal_logo ALTER COLUMN image SET STORAGE EXTERNAL;
ALTER TABLE domain.municipal_logo ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_logo FORCE ROW LEVEL SECURITY;
CREATE POLICY municipal_logo_maintenance ON domain.municipal_logo TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.municipal_logo FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE TABLE domain.municipal_branding_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 version integer NOT NULL,
 action text NOT NULL CHECK (action IN ('RENAMED','LOGO_SET','LOGO_REMOVED')),
 previous_state jsonb NOT NULL,
 next_state jsonb NOT NULL,
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,version)
);
ALTER TABLE domain.municipal_branding_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_branding_event FORCE ROW LEVEL SECURITY;
CREATE POLICY branding_event_maintenance ON domain.municipal_branding_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.municipal_branding_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.branding_state(m domain.municipality) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('name',m.name,'logos',coalesce((
  SELECT jsonb_object_agg(l.variant,jsonb_build_object('width',l.width,'height',l.height,'bytes',octet_length(l.image)))
  FROM domain.municipal_logo l WHERE l.tenant_id=m.id),'{}'::jsonb))
$$;

CREATE FUNCTION domain.public_municipal_branding(selected uuid)
RETURNS TABLE(version integer,name text,official_name text,light_logo boolean,dark_logo boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.branding_version,m.name,m.official_name,
  EXISTS(SELECT 1 FROM domain.municipal_logo l WHERE l.tenant_id=m.id AND l.variant='light'),
  EXISTS(SELECT 1 FROM domain.municipal_logo l WHERE l.tenant_id=m.id AND l.variant='dark')
 FROM domain.municipality m WHERE m.id=selected
$$;
CREATE FUNCTION domain.public_municipal_logo(selected uuid,selected_variant text)
RETURNS TABLE(version integer,image bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.branding_version,l.image FROM domain.municipality m
 JOIN domain.municipal_logo l ON l.tenant_id=m.id AND l.variant=selected_variant WHERE m.id=selected
$$;

-- Opens a branding change: the caller administers the municipality and holds the version it read.
CREATE FUNCTION domain.lock_branding(expected integer,correlation uuid) RETURNS domain.municipality
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous domain.municipality%ROWTYPE;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_current_administrator()
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected NOT BETWEEN 1 AND 2147483646 OR correlation IS NULL
 THEN RAISE EXCEPTION 'Invalid branding' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM domain.municipality WHERE id=tenant FOR UPDATE;
 RETURN previous;
END $$;
CREATE FUNCTION domain.record_branding(previous domain.municipality,before jsonb,action_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed domain.municipality%ROWTYPE;
BEGIN
 UPDATE domain.municipality SET branding_version=previous.branding_version+1 WHERE id=previous.id RETURNING * INTO changed;
 INSERT INTO domain.municipal_branding_event(tenant_id,actor_id,version,action,previous_state,next_state,correlation_id)
 VALUES(previous.id,current_setting('quenda.account_id',true),changed.branding_version,action_value,
  before,domain.branding_state(changed),correlation);
 RETURN changed.branding_version;
END $$;

CREATE FUNCTION domain.rename_municipality(expected integer,name_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous domain.municipality%ROWTYPE:=domain.lock_branding(expected,correlation);
 before jsonb:=domain.branding_state(previous);
BEGIN
 IF name_value IS NULL OR name_value<>btrim(name_value) OR length(name_value) NOT BETWEEN 1 AND 120
 OR name_value ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid branding' USING ERRCODE='22023'; END IF;
 IF previous.id IS NULL OR previous.branding_version<>expected THEN RETURN NULL; END IF;
 UPDATE domain.municipality SET name=name_value WHERE id=previous.id;
 RETURN domain.record_branding(previous,before,'RENAMED',correlation);
END $$;
CREATE FUNCTION domain.save_municipal_logo(expected integer,variant_value text,image_value bytea,
 width_value integer,height_value integer,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous domain.municipality%ROWTYPE:=domain.lock_branding(expected,correlation);
 before jsonb:=domain.branding_state(previous);
BEGIN
 IF variant_value IS NULL OR variant_value NOT IN ('light','dark') OR image_value IS NULL
 THEN RAISE EXCEPTION 'Invalid branding' USING ERRCODE='22023'; END IF;
 IF previous.id IS NULL OR previous.branding_version<>expected THEN RETURN NULL; END IF;
 -- A dark variant only complements a main logo.
 IF variant_value='dark' AND NOT EXISTS(SELECT 1 FROM domain.municipal_logo WHERE tenant_id=previous.id AND variant='light')
 THEN RAISE EXCEPTION 'Invalid branding' USING ERRCODE='22023'; END IF;
 INSERT INTO domain.municipal_logo(tenant_id,variant,width,height,image)
 VALUES(previous.id,variant_value,width_value,height_value,image_value)
 ON CONFLICT(tenant_id,variant) DO UPDATE SET width=EXCLUDED.width,height=EXCLUDED.height,image=EXCLUDED.image,created_at=clock_timestamp();
 RETURN domain.record_branding(previous,before,'LOGO_SET',correlation);
END $$;
CREATE FUNCTION domain.remove_municipal_logo(expected integer,variant_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous domain.municipality%ROWTYPE:=domain.lock_branding(expected,correlation);
 before jsonb:=domain.branding_state(previous);
BEGIN
 IF variant_value IS NULL OR variant_value NOT IN ('light','dark')
 THEN RAISE EXCEPTION 'Invalid branding' USING ERRCODE='22023'; END IF;
 IF previous.id IS NULL OR previous.branding_version<>expected THEN RETURN NULL; END IF;
 -- Removing the main logo removes its dark variant too.
 DELETE FROM domain.municipal_logo WHERE tenant_id=previous.id AND (variant=variant_value OR variant_value='light');
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 RETURN domain.record_branding(previous,before,'LOGO_REMOVED',correlation);
END $$;

REVOKE ALL ON FUNCTION domain.keep_official_name(),domain.branding_state(domain.municipality),
 domain.lock_branding(integer,uuid),domain.record_branding(domain.municipality,jsonb,text,uuid)
 FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
REVOKE ALL ON FUNCTION domain.public_municipal_branding(uuid),domain.public_municipal_logo(uuid,text),
 domain.rename_municipality(integer,text,uuid),domain.save_municipal_logo(integer,text,bytea,integer,integer,uuid),
 domain.remove_municipal_logo(integer,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_municipal_branding(uuid),domain.public_municipal_logo(uuid,text),
 domain.rename_municipality(integer,text,uuid),domain.save_municipal_logo(integer,text,bytea,integer,integer,uuid),
 domain.remove_municipal_logo(integer,text,uuid) TO quenda_domain;
