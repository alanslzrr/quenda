ALTER TABLE domain.municipality
 ADD COLUMN appearance_version integer NOT NULL DEFAULT 1 CHECK(appearance_version>0),
 ADD COLUMN light_palette text NOT NULL DEFAULT 'neutral' CHECK(light_palette IN ('neutral','blue','green')),
 ADD COLUMN dark_palette text NOT NULL DEFAULT 'neutral' CHECK(dark_palette IN ('neutral','blue','green')),
 ADD COLUMN default_theme text NOT NULL DEFAULT 'light' CHECK(default_theme IN ('light','dark'));
CREATE TABLE domain.municipal_appearance_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 version integer NOT NULL,
 previous_state jsonb NOT NULL,
 next_state jsonb NOT NULL,
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,version)
);
ALTER TABLE domain.municipal_appearance_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_appearance_event FORCE ROW LEVEL SECURITY;
CREATE POLICY appearance_event_maintenance ON domain.municipal_appearance_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.municipal_appearance_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE FUNCTION domain.public_municipal_appearance(selected uuid)
RETURNS TABLE(version integer,light_palette text,dark_palette text,default_theme text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.appearance_version,m.light_palette,m.dark_palette,m.default_theme FROM domain.municipality m WHERE m.id=selected
$$;
CREATE FUNCTION domain.save_municipal_appearance(expected integer,light_value text,dark_value text,default_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous domain.municipality%ROWTYPE;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_current_administrator()
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected NOT BETWEEN 1 AND 2147483646 OR correlation IS NULL
 OR light_value IS NULL OR light_value NOT IN ('neutral','blue','green')
 OR dark_value IS NULL OR dark_value NOT IN ('neutral','blue','green')
 OR default_value IS NULL OR default_value NOT IN ('light','dark')
 THEN RAISE EXCEPTION 'Invalid appearance' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR previous.appearance_version<>expected THEN RETURN NULL; END IF;
 UPDATE domain.municipality SET appearance_version=expected+1,light_palette=light_value,dark_palette=dark_value,default_theme=default_value WHERE id=tenant;
 INSERT INTO domain.municipal_appearance_event(tenant_id,actor_id,version,previous_state,next_state,correlation_id)
 VALUES(tenant,actor,expected+1,jsonb_build_object('lightPalette',previous.light_palette,'darkPalette',previous.dark_palette,'defaultTheme',previous.default_theme),
 jsonb_build_object('lightPalette',light_value,'darkPalette',dark_value,'defaultTheme',default_value),correlation);
 RETURN expected+1;
END $$;
REVOKE ALL ON FUNCTION domain.public_municipal_appearance(uuid),domain.save_municipal_appearance(integer,text,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_municipal_appearance(uuid),domain.save_municipal_appearance(integer,text,text,text,uuid) TO quenda_domain;
