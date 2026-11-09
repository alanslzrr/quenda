-- Published legal texts: privacy information, legal notice and accessibility statement.
-- tenant_id NULL is the instance-level text. Rows are append-only: a new version never edits an older one.
CREATE TABLE domain.legal_notice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid REFERENCES domain.municipality(id),
 kind text NOT NULL CHECK (kind IN ('privacy','legal','accessibility')),
 version integer NOT NULL CHECK (version > 0),
 body jsonb NOT NULL CHECK (jsonb_typeof(body)='object' AND pg_column_size(body) <= 65536),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 correlation_id uuid NOT NULL,
 published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX legal_notice_tenant_version ON domain.legal_notice(tenant_id,kind,version) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX legal_notice_instance_version ON domain.legal_notice(kind,version) WHERE tenant_id IS NULL;
ALTER TABLE domain.legal_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.legal_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_notice_maintenance ON domain.legal_notice TO quenda_migrator USING (true) WITH CHECK (true);
REVOKE ALL ON domain.legal_notice FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE FUNCTION domain.reject_legal_notice_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Legal notices are append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER legal_notice_append_only BEFORE UPDATE OR DELETE ON domain.legal_notice
 FOR EACH ROW EXECUTE FUNCTION domain.reject_legal_notice_change();

-- Latest published text. Version 0 and an empty body mean the scope exists but has published nothing yet.
CREATE FUNCTION domain.public_legal_notice(selected uuid,notice_kind text)
RETURNS TABLE(version integer,body jsonb,published_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(n.version,0),coalesce(n.body,'{}'::jsonb),n.published_at
 FROM (SELECT 1) s
 LEFT JOIN LATERAL (
  SELECT l.version,l.body,l.published_at FROM domain.legal_notice l
  WHERE l.kind=notice_kind AND l.tenant_id IS NOT DISTINCT FROM selected ORDER BY l.version DESC LIMIT 1
 ) n ON true
 WHERE notice_kind IN ('privacy','legal','accessibility')
 AND (selected IS NULL OR EXISTS (SELECT 1 FROM domain.municipality m WHERE m.id=selected))
$$;
CREATE FUNCTION domain.save_legal_notice(selected uuid,notice_kind text,expected integer,notice_body jsonb,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
 tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid; latest integer;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF notice_kind IS NULL OR notice_kind NOT IN ('privacy','legal','accessibility')
  OR expected IS NULL OR expected NOT BETWEEN 0 AND 2147483646
  OR notice_body IS NULL OR jsonb_typeof(notice_body)<>'object' OR correlation IS NULL
 THEN RAISE EXCEPTION 'Invalid notice' USING ERRCODE='22023'; END IF;
 IF selected IS NULL THEN
  IF NOT domain.lock_current_operator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 ELSE
  IF tenant IS DISTINCT FROM selected OR NOT domain.lock_current_administrator()
  THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('legal_notice:'||coalesce(selected::text,'instance')||':'||notice_kind,0));
 SELECT coalesce(max(l.version),0) INTO latest FROM domain.legal_notice l
 WHERE l.kind=notice_kind AND l.tenant_id IS NOT DISTINCT FROM selected;
 IF latest<>expected THEN RETURN NULL; END IF;
 INSERT INTO domain.legal_notice(tenant_id,kind,version,body,actor_id,correlation_id)
 VALUES(selected,notice_kind,latest+1,notice_body,actor,correlation);
 RETURN latest+1;
END $$;
REVOKE ALL ON FUNCTION domain.public_legal_notice(uuid,text),domain.save_legal_notice(uuid,text,integer,jsonb,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_legal_notice(uuid,text),domain.save_legal_notice(uuid,text,integer,jsonb,uuid) TO quenda_domain;
