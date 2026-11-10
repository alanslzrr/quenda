-- Per-object, revocable controller approvals. No role receives general access
-- to another municipality's personal data or blocked archives.
CREATE TABLE domain.shared_retention_review (
 owner_tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 category text NOT NULL CHECK(category IN ('RESERVATIONS','ACCREDITATIONS')),
 target_key uuid NOT NULL,
 reviewer_tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 approved boolean NOT NULL,
 actor_id text NOT NULL,
 authorization_reference text NOT NULL CHECK(length(btrim(authorization_reference)) BETWEEN 1 AND 500),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_tenant_id,category,target_key,reviewer_tenant_id)
);
ALTER TABLE domain.shared_retention_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.shared_retention_review FORCE ROW LEVEL SECURITY;
CREATE POLICY shared_retention_maintenance ON domain.shared_retention_review TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.shared_retention_review FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.shared_retention_material(owner_tenant uuid,requested_category text,target uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE content jsonb; agreements uuid[]; controllers uuid[]; subject text;
BEGIN
 IF requested_category='RESERVATIONS' THEN
  SELECT to_jsonb(r),r.account_id INTO content,subject FROM domain.reservation r WHERE (r.tenant_id,r.id)=(owner_tenant,target);
  IF NOT FOUND THEN RETURN NULL; END IF;
  content:=jsonb_build_object('reservation',content,
   'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.revision) FROM domain.reservation_event e WHERE (e.tenant_id,e.reservation_id)=(owner_tenant,target)),'[]'::jsonb),
   'consumption',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.agreement_id) FROM domain.agreement_consumption c WHERE (c.tenant_id,c.reservation_id)=(owner_tenant,target)),'[]'::jsonb),
   'consumptionEvents',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM domain.agreement_consumption_event e WHERE (e.tenant_id,e.reservation_id)=(owner_tenant,target)),'[]'::jsonb));
  SELECT array_agg(DISTINCT a.id) INTO agreements FROM (
   SELECT c.agreement_id id FROM domain.agreement_consumption c WHERE (c.tenant_id,c.reservation_id)=(owner_tenant,target)
   UNION SELECT e.agreement_id FROM domain.agreement_consumption_event e WHERE (e.tenant_id,e.reservation_id)=(owner_tenant,target)
  ) a;
 ELSIF requested_category='ACCREDITATIONS' THEN
  SELECT to_jsonb(c),ARRAY[c.agreement_id],s.account_id INTO content,agreements,subject
  FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
  WHERE c.issuer_tenant_id=owner_tenant AND c.id=target;
  IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE RETURN NULL; END IF;
 SELECT array_agg(DISTINCT p.tenant_id ORDER BY p.tenant_id) INTO controllers
 FROM (SELECT owner_tenant tenant_id UNION SELECT a.tenant_id FROM domain.agreement_participant a WHERE a.agreement_id=ANY(agreements)) p;
 RETURN jsonb_build_object('content',content,'controllers',controllers,'subjectId',subject,'shared',cardinality(agreements)>0);
END $$;
REVOKE ALL ON FUNCTION domain.shared_retention_material(uuid,text,uuid) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.shared_retention_digest(owner_tenant uuid,requested_category text,target uuid,requested_action text,block_days integer,material jsonb)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'owner',owner_tenant,'category',requested_category,'target',target,
  'action',requested_action,'blockDays',block_days,'material',material,
  'policy',(SELECT p.id FROM domain.retention_policy p WHERE p.tenant_id=owner_tenant AND p.category=requested_category AND p.revoked_at IS NULL AND p.superseded_at IS NULL)
 )::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION domain.shared_retention_digest(uuid,text,uuid,text,integer,jsonb) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.shared_retention_context(reviewer uuid,owner_tenant uuid,requested_category text,target uuid,requested_action text,block_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE material jsonb; fingerprint text; controllers jsonb;
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_READ',reviewer) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF requested_action IS NULL OR requested_action NOT IN ('ERASE','BLOCK') OR (requested_action='BLOCK') IS DISTINCT FROM (block_days IS NOT NULL)
 OR block_days NOT BETWEEN 1 AND 365000 THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023'; END IF;
 material:=domain.shared_retention_material(owner_tenant,requested_category,target);
 IF material IS NULL OR NOT (material->'controllers') ? reviewer::text OR NOT coalesce((material->>'shared')::boolean,false) THEN RETURN NULL; END IF;
 fingerprint:=domain.shared_retention_digest(owner_tenant,requested_category,target,requested_action,block_days,material);
 SELECT jsonb_agg(jsonb_build_object('tenantId',m.id,'name',m.name,'approved',coalesce(r.approved AND r.digest=fingerprint,false)) ORDER BY m.id) INTO controllers
 FROM jsonb_array_elements_text(material->'controllers') c JOIN domain.municipality m ON m.id=c.value::uuid
 LEFT JOIN domain.shared_retention_review r ON (r.owner_tenant_id,r.category,r.target_key,r.reviewer_tenant_id)=(owner_tenant,requested_category,target,m.id);
 RETURN jsonb_build_object('ownerTenantId',owner_tenant,'category',requested_category,'targetKey',target,'action',requested_action,'blockDays',block_days,'digest',fingerprint,'controllers',controllers);
END $$;
REVOKE ALL ON FUNCTION domain.shared_retention_context(uuid,uuid,text,uuid,text,integer) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.shared_retention_context(uuid,uuid,text,uuid,text,integer) TO quenda_domain;

CREATE FUNCTION domain.review_shared_retention(reviewer uuid,owner_tenant uuid,requested_category text,target uuid,requested_action text,block_days integer,expected_digest text,approved boolean,authorization_value text,rationale text,correlation uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE context jsonb; actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',reviewer) THEN RETURN 'FORBIDDEN'; END IF;
 PERFORM domain.lock_retention_control();
 IF approved IS NULL OR correlation IS NULL OR expected_digest IS NULL OR expected_digest !~ '^[a-f0-9]{64}$'
 OR coalesce(length(btrim(authorization_value)),0) NOT BETWEEN 1 AND 500 OR coalesce(length(btrim(rationale)),0) NOT BETWEEN 1 AND 500 THEN RETURN 'INVALID_INPUT'; END IF;
 context:=domain.shared_retention_context(reviewer,owner_tenant,requested_category,target,requested_action,block_days);
 IF context IS NULL THEN RETURN 'NOT_FOUND'; END IF;
 IF context->>'digest'<>expected_digest THEN RETURN 'CONFLICT'; END IF;
 INSERT INTO domain.shared_retention_review(owner_tenant_id,category,target_key,reviewer_tenant_id,digest,approved,actor_id,authorization_reference,reason)
 VALUES(owner_tenant,requested_category,target,reviewer,expected_digest,approved,actor,authorization_value,rationale)
 ON CONFLICT(owner_tenant_id,category,target_key,reviewer_tenant_id) DO UPDATE
 SET digest=EXCLUDED.digest,approved=EXCLUDED.approved,actor_id=EXCLUDED.actor_id,authorization_reference=EXCLUDED.authorization_reference,reason=EXCLUDED.reason,reviewed_at=clock_timestamp();
 INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,action,actor_id,authorization_reference,reason,correlation_id,details)
 VALUES(CASE WHEN approved THEN 'SHARED_RETENTION_APPROVED' ELSE 'SHARED_RETENTION_WITHDRAWN' END,reviewer,requested_category,target::text,requested_action,actor,authorization_value,rationale,correlation,
  jsonb_build_object('ownerTenantId',owner_tenant,'digest',expected_digest,'blockDays',block_days));
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION domain.review_shared_retention(uuid,uuid,text,uuid,text,integer,text,boolean,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.review_shared_retention(uuid,uuid,text,uuid,text,integer,text,boolean,text,text,uuid) TO quenda_domain;

CREATE FUNCTION domain.shared_retention_allowed(owner_tenant uuid,requested_category text,target uuid,requested_action text,block_days integer,verified_replay boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE material jsonb; fingerprint text;
BEGIN
 material:=domain.shared_retention_material(owner_tenant,requested_category,target);
 IF material IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(material->'controllers') c WHERE domain.retention_target_held(c.value::uuid,requested_category,target::text,material->>'subjectId')) THEN RETURN false; END IF;
 IF verified_replay THEN
  RETURN (session_user='quenda_migrator' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) AND EXISTS(SELECT 1 FROM domain.retention_control WHERE id AND restore_review_required);
 END IF;
 IF requested_action IS NULL OR requested_action NOT IN ('ERASE','BLOCK') OR (requested_action='BLOCK') IS DISTINCT FROM (block_days IS NOT NULL) OR block_days NOT BETWEEN 1 AND 365000 THEN RETURN false; END IF;
 fingerprint:=domain.shared_retention_digest(owner_tenant,requested_category,target,requested_action,block_days,material);
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(material->'controllers') c WHERE NOT EXISTS(
  SELECT 1 FROM domain.shared_retention_review r WHERE (r.owner_tenant_id,r.category,r.target_key,r.reviewer_tenant_id)=(owner_tenant,requested_category,target,c.value::uuid) AND r.approved AND r.digest=fingerprint));
END $$;
REVOKE ALL ON FUNCTION domain.shared_retention_allowed(uuid,text,uuid,text,integer,boolean) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
