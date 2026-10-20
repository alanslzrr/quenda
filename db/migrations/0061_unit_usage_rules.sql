CREATE TABLE domain.unit_usage_rules (
 tenant_id uuid NOT NULL,
 unit_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 text_content text NOT NULL CHECK(length(btrim(text_content)) BETWEEN 1 AND 20000),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,unit_id,version),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id)
);
ALTER TABLE domain.unit_usage_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.unit_usage_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_rules_maintenance ON domain.unit_usage_rules TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY usage_rules_read ON domain.unit_usage_rules FOR SELECT TO quenda_domain
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',unit_id));
GRANT SELECT ON domain.unit_usage_rules TO quenda_domain;
ALTER TABLE domain.reservable_unit ADD COLUMN usage_rules_version integer;
ALTER TABLE domain.reservable_unit ADD FOREIGN KEY(tenant_id,id,usage_rules_version)
 REFERENCES domain.unit_usage_rules(tenant_id,unit_id,version);
-- A single capability appends immutable evidence and advances the pointer.
-- Runtime roles cannot rewrite a version or point back to an old one.
CREATE FUNCTION domain.save_unit_usage_rules(resource uuid,expected integer,content text,reason text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous integer;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_permission('CATALOG_MANAGE',resource)
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected<0 OR expected>=2147483647 OR content IS NULL OR length(btrim(content)) NOT BETWEEN 1 AND 20000
 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500 OR correlation IS NULL
 THEN RAISE EXCEPTION 'Invalid rules' USING ERRCODE='22023'; END IF;
 SELECT coalesce(usage_rules_version,0) INTO previous FROM domain.reservable_unit WHERE tenant_id=tenant AND id=resource FOR UPDATE;
 IF NOT FOUND OR previous<>expected THEN RETURN NULL; END IF;
 INSERT INTO domain.unit_usage_rules(tenant_id,unit_id,version,text_content,actor_id,reason,correlation_id)
 VALUES(tenant,resource,expected+1,content,actor,btrim(reason),correlation);
 UPDATE domain.reservable_unit SET usage_rules_version=expected+1 WHERE tenant_id=tenant AND id=resource;
 RETURN expected+1;
END $$;
REVOKE ALL ON FUNCTION domain.save_unit_usage_rules(uuid,integer,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.save_unit_usage_rules(uuid,integer,text,text,uuid) TO quenda_domain;
-- Public output excludes editor identity, internal reason and correlation.
CREATE FUNCTION domain.public_unit_usage_rules(tenant uuid,resource uuid) RETURNS TABLE(version integer,text_content text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT v.version,v.text_content FROM domain.unit_usage_rules v
 JOIN domain.reservable_unit u ON (u.tenant_id,u.id,u.usage_rules_version)=(v.tenant_id,v.unit_id,v.version)
 JOIN domain.facility f ON (f.tenant_id,f.id)=(u.tenant_id,u.facility_id)
 WHERE u.tenant_id=tenant AND u.id=resource AND u.published_at IS NOT NULL AND u.withdrawn_at IS NULL
 AND f.published_at IS NOT NULL AND f.withdrawn_at IS NULL
$$;
REVOKE ALL ON FUNCTION domain.public_unit_usage_rules(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_unit_usage_rules(uuid,uuid) TO quenda_domain;
