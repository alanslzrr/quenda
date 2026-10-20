-- Approved retention is scoped to one controller and a fixed data family. No
-- deployment receives a legal period or a policy implicitly from this migration.
CREATE TABLE domain.retention_control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), revision bigint NOT NULL DEFAULT 0,
 instance_id uuid NOT NULL DEFAULT gen_random_uuid(), privacy_replayed_at timestamptz, privacy_checkpoint_sha256 text,
 restore_review_required boolean NOT NULL DEFAULT false
);
INSERT INTO domain.retention_control(id) VALUES(true);
CREATE TABLE domain.retention_policy (
 id uuid PRIMARY KEY, tenant_id uuid REFERENCES domain.municipality(id),
 category text NOT NULL CHECK(category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')),
 retention_days integer NOT NULL CHECK(retention_days BETWEEN 1 AND 365000),
 action text NOT NULL CHECK(action IN ('ERASE','BLOCK')),
 block_days integer CHECK(block_days BETWEEN 1 AND 365000),
 purpose text NOT NULL CHECK(length(btrim(purpose)) BETWEEN 1 AND 500),
 controller_reference text NOT NULL CHECK(length(btrim(controller_reference)) BETWEEN 1 AND 500),
 approval_reference text NOT NULL CHECK(length(btrim(approval_reference)) BETWEEN 1 AND 500),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 approved_by text NOT NULL REFERENCES auth."user"(id), approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz, superseded_at timestamptz, last_scanned_at timestamptz,
 CHECK((action='BLOCK')=(block_days IS NOT NULL)),
 CHECK((category IN ('IDENTITY','AUTHENTICATION') AND tenant_id IS NULL)
 OR (category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND tenant_id IS NOT NULL)
 OR category='AUTHORITY')
);
CREATE UNIQUE INDEX retention_active_policy ON domain.retention_policy(coalesce(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid),category) WHERE revoked_at IS NULL AND superseded_at IS NULL;
CREATE TABLE domain.retention_hold (
 id uuid PRIMARY KEY, tenant_id uuid REFERENCES domain.municipality(id), category text NOT NULL,
 target_key text, subject_id text, authority_reference text NOT NULL, reason text NOT NULL,
 created_by text NOT NULL REFERENCES auth."user"(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 released_at timestamptz,
 CHECK(category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')),
 CHECK((target_key IS NOT NULL)<>(subject_id IS NOT NULL)),
 CHECK(target_key IS NULL OR length(btrim(target_key)) BETWEEN 1 AND 500),
 CHECK(subject_id IS NULL OR length(btrim(subject_id)) BETWEEN 1 AND 128),
 CHECK((category IN ('IDENTITY','AUTHENTICATION') AND tenant_id IS NULL)
 OR (category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND tenant_id IS NOT NULL)
 OR category='AUTHORITY'),
 CHECK(length(btrim(authority_reference)) BETWEEN 1 AND 500 AND length(btrim(reason)) BETWEEN 1 AND 500)
);
CREATE INDEX retention_holds_active ON domain.retention_hold(category,tenant_id) WHERE released_at IS NULL;
CREATE TABLE domain.retention_event (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 operation text NOT NULL, policy_id uuid REFERENCES domain.retention_policy(id),
 tenant_id uuid, category text, target_key text, subject_id text,
 action text, actor_id text, authorization_reference text, reason text,
 correlation_id uuid, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE domain.retention_archive (
 id uuid PRIMARY KEY, event_id bigint NOT NULL UNIQUE REFERENCES domain.retention_event(id),
 tenant_id uuid, category text NOT NULL, target_key text NOT NULL, subject_id text,
 payload jsonb NOT NULL, blocked_at timestamptz NOT NULL DEFAULT clock_timestamp(), destroy_after timestamptz NOT NULL
);
CREATE INDEX retention_archive_subject ON domain.retention_archive(subject_id,category,tenant_id);
CREATE TABLE domain.retention_conflict (
 policy_id uuid NOT NULL REFERENCES domain.retention_policy(id), target_key text NOT NULL,
 reason text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(policy_id,target_key)
);
-- Maintenance-only tables: neither the worker nor a privacy delegate can inspect
-- blocked payloads through ordinary domain privileges or a general export.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['retention_control','retention_policy','retention_hold','retention_event','retention_archive','retention_conflict'] LOOP
  EXECUTE format('ALTER TABLE domain.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE domain.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY retention_maintenance ON domain.%I TO quenda_migrator USING(true) WITH CHECK(true)',table_name);
  EXECUTE format('REVOKE ALL ON domain.%I FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker',table_name);
 END LOOP;
END $$;

CREATE FUNCTION domain.lock_retention_control() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 UPDATE domain.retention_control SET revision=revision+1 WHERE id;
 IF EXISTS(SELECT 1 FROM domain.retention_control WHERE restore_review_required) THEN RAISE EXCEPTION 'Privacy restore review required' USING ERRCODE='55000'; END IF;
END $$;
REVOKE ALL ON FUNCTION domain.lock_retention_control() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.retention_target_held(scope_tenant uuid,scope_category text,target text,subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.retention_hold h WHERE h.tenant_id IS NOT DISTINCT FROM scope_tenant AND h.category=scope_category AND h.released_at IS NULL
 AND (h.target_key=target OR (h.subject_id=subject AND h.target_key IS NULL)))
$$;
REVOKE ALL ON FUNCTION domain.retention_target_held(uuid,text,text,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.approve_retention_policy(policy_id uuid,scope_tenant uuid,specification jsonb,correlation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); category_value text:=specification->>'category';
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RETURN 'FORBIDDEN'; END IF;
 PERFORM domain.lock_retention_control();
 IF policy_id IS NULL OR correlation_id IS NULL OR jsonb_typeof(specification) IS DISTINCT FROM 'object' THEN RETURN 'INVALID_INPUT'; END IF;
 IF NOT specification ?& ARRAY['category','retentionDays','action','purpose','controllerReference','approvalReference','reason']
 OR (specification-ARRAY['category','retentionDays','action','blockDays','purpose','controllerReference','approvalReference','reason'])<>'{}'::jsonb
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['category','action','purpose','controllerReference','approvalReference','reason']) AS required(key)
   WHERE jsonb_typeof(specification->required.key) IS DISTINCT FROM 'string')
 OR jsonb_typeof(specification->'retentionDays') IS DISTINCT FROM 'number'
 OR (specification ? 'blockDays' AND jsonb_typeof(specification->'blockDays') IS DISTINCT FROM 'number') THEN RETURN 'INVALID_INPUT'; END IF;
 IF category_value NOT IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')
 OR (category_value IN ('IDENTITY','AUTHENTICATION') AND scope_tenant IS NOT NULL)
 OR (category_value IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND scope_tenant IS NULL)
 OR specification->>'action' NOT IN ('ERASE','BLOCK')
 OR (specification->>'action'='BLOCK') IS DISTINCT FROM (specification ? 'blockDays')
 OR (specification->>'retentionDays') !~ '^[0-9]+$' OR (specification->>'retentionDays')::numeric NOT BETWEEN 1 AND 365000
 OR (specification ? 'blockDays' AND ((specification->>'blockDays') !~ '^[0-9]+$' OR (specification->>'blockDays')::numeric NOT BETWEEN 1 AND 365000))
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['purpose','controllerReference','approvalReference','reason']) AS required(key)
   WHERE length(btrim(specification->>required.key)) NOT BETWEEN 1 AND 500) THEN RETURN 'INVALID_INPUT'; END IF;
 IF scope_tenant IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.municipality WHERE id=scope_tenant) THEN RETURN 'NOT_FOUND'; END IF;
 UPDATE domain.retention_policy SET superseded_at=clock_timestamp() WHERE tenant_id IS NOT DISTINCT FROM scope_tenant AND category=category_value AND revoked_at IS NULL AND superseded_at IS NULL;
 INSERT INTO domain.retention_policy(id,tenant_id,category,retention_days,action,block_days,purpose,controller_reference,approval_reference,reason,approved_by)
 VALUES(policy_id,scope_tenant,category_value,(specification->>'retentionDays')::integer,specification->>'action',(specification->>'blockDays')::integer,btrim(specification->>'purpose'),btrim(specification->>'controllerReference'),btrim(specification->>'approvalReference'),btrim(specification->>'reason'),actor);
 INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,actor_id,authorization_reference,reason,correlation_id)
 VALUES('POLICY_APPROVED',policy_id,scope_tenant,category_value,actor,specification->>'approvalReference',specification->>'reason',correlation_id);
 RETURN 'OK';
END $$;
CREATE FUNCTION domain.list_retention_policies(scope_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_READ',scope_tenant) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('policies',coalesce(jsonb_agg(x.document ORDER BY x.approved_at DESC,x.id),'[]'::jsonb),'hasMore',(SELECT count(*)>100 FROM domain.retention_policy WHERE tenant_id IS NOT DISTINCT FROM scope_tenant)) INTO result FROM (
 SELECT id,approved_at,jsonb_build_object('policyId',id,'scopeTenantId',tenant_id,'category',category,'retentionDays',retention_days,'action',action,'blockDays',block_days,'purpose',purpose,'controllerReference',controller_reference,'approvalReference',approval_reference,'reason',reason,'approvedAt',approved_at,'revokedAt',revoked_at,'supersededAt',superseded_at) document
 FROM domain.retention_policy WHERE tenant_id IS NOT DISTINCT FROM scope_tenant ORDER BY (revoked_at IS NULL AND superseded_at IS NULL) DESC,approved_at DESC,id LIMIT 100) x;
 RETURN result;
END $$;
CREATE FUNCTION domain.revoke_retention_policy(policy_id uuid,scope_tenant uuid,reason text,correlation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RETURN 'FORBIDDEN'; END IF;
 PERFORM domain.lock_retention_control();
 IF reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500 OR correlation_id IS NULL THEN RETURN 'INVALID_INPUT'; END IF;
 UPDATE domain.retention_policy p SET revoked_at=clock_timestamp() WHERE p.id=policy_id AND p.tenant_id IS NOT DISTINCT FROM scope_tenant AND p.revoked_at IS NULL AND p.superseded_at IS NULL;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 INSERT INTO domain.retention_event(operation,policy_id,tenant_id,actor_id,reason,correlation_id) VALUES('POLICY_REVOKED',policy_id,scope_tenant,current_setting('quenda.account_id',true),reason,correlation_id);
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION domain.approve_retention_policy(uuid,uuid,jsonb,uuid),domain.list_retention_policies(uuid),domain.revoke_retention_policy(uuid,uuid,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.approve_retention_policy(uuid,uuid,jsonb,uuid),domain.list_retention_policies(uuid),domain.revoke_retention_policy(uuid,uuid,text,uuid) TO quenda_domain;

CREATE FUNCTION domain.set_retention_hold(hold_id uuid,scope_tenant uuid,specification jsonb,correlation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RETURN 'FORBIDDEN'; END IF;
 PERFORM domain.lock_retention_control();
 IF hold_id IS NULL OR correlation_id IS NULL OR jsonb_typeof(specification) IS DISTINCT FROM 'object' THEN RETURN 'INVALID_INPUT'; END IF;
 IF NOT specification ?& ARRAY['category','authorizationReference','reason']
 OR (specification-ARRAY['category','targetKey','subjectId','authorizationReference','reason'])<>'{}'::jsonb
 OR (specification ? 'targetKey')=(specification ? 'subjectId')
 OR EXISTS(SELECT 1 FROM jsonb_each(specification) AS field(key,value) WHERE jsonb_typeof(field.value) IS DISTINCT FROM 'string') THEN RETURN 'INVALID_INPUT'; END IF;
 IF specification->>'category' NOT IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')
 OR (specification->>'category' IN ('IDENTITY','AUTHENTICATION') AND scope_tenant IS NOT NULL)
 OR (specification->>'category' IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND scope_tenant IS NULL)
 OR (specification ? 'targetKey' AND length(btrim(specification->>'targetKey')) NOT BETWEEN 1 AND 500)
 OR (specification ? 'subjectId' AND length(btrim(specification->>'subjectId')) NOT BETWEEN 1 AND 128)
 OR length(btrim(specification->>'authorizationReference')) NOT BETWEEN 1 AND 500
 OR length(btrim(specification->>'reason')) NOT BETWEEN 1 AND 500 THEN RETURN 'INVALID_INPUT'; END IF;
 IF specification ? 'targetKey' AND NOT domain.retention_target_exists(scope_tenant,specification->>'category',btrim(specification->>'targetKey')) THEN RETURN 'NOT_FOUND'; END IF;
 IF specification ? 'subjectId' AND NOT domain.retention_subject_exists(scope_tenant,btrim(specification->>'subjectId')) THEN RETURN 'NOT_FOUND'; END IF;
 INSERT INTO domain.retention_hold(id,tenant_id,category,target_key,subject_id,authority_reference,reason,created_by)
 VALUES(hold_id,scope_tenant,specification->>'category',btrim(specification->>'targetKey'),btrim(specification->>'subjectId'),btrim(specification->>'authorizationReference'),btrim(specification->>'reason'),current_setting('quenda.account_id',true));
 INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,actor_id,authorization_reference,reason,correlation_id,details)
 VALUES('HOLD_CREATED',scope_tenant,specification->>'category',specification->>'targetKey',specification->>'subjectId',current_setting('quenda.account_id',true),specification->>'authorizationReference',specification->>'reason',correlation_id,jsonb_build_object('holdId',hold_id));
 RETURN 'OK';
END $$;
CREATE FUNCTION domain.release_retention_hold(hold_id uuid,scope_tenant uuid,authorization_reference text,reason text,correlation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RETURN 'FORBIDDEN'; END IF;
 PERFORM domain.lock_retention_control();
 IF length(btrim(authorization_reference)) NOT BETWEEN 1 AND 500 OR length(btrim(reason)) NOT BETWEEN 1 AND 500 OR authorization_reference IS NULL OR reason IS NULL OR correlation_id IS NULL THEN RETURN 'INVALID_INPUT'; END IF;
 UPDATE domain.retention_hold h SET released_at=clock_timestamp() WHERE h.id=hold_id AND h.tenant_id IS NOT DISTINCT FROM scope_tenant AND h.released_at IS NULL;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 INSERT INTO domain.retention_event(operation,tenant_id,actor_id,authorization_reference,reason,correlation_id,details)
 VALUES('HOLD_RELEASED',scope_tenant,current_setting('quenda.account_id',true),authorization_reference,reason,correlation_id,jsonb_build_object('holdId',hold_id));
 RETURN 'OK';
END $$;
CREATE FUNCTION domain.retention_status(scope_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_READ',scope_tenant) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('holds',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT id AS "holdId",category,target_key AS "targetKey",subject_id AS "subjectId",authority_reference AS "authorizationReference",reason,created_at AS "createdAt" FROM domain.retention_hold WHERE tenant_id IS NOT DISTINCT FROM scope_tenant AND released_at IS NULL ORDER BY created_at,id LIMIT 100) x),'[]'::jsonb),
 'conflicts',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT c.policy_id AS "policyId",p.category,c.target_key AS "targetKey",c.reason,c.last_seen_at AS "lastSeenAt" FROM domain.retention_conflict c JOIN domain.retention_policy p ON p.id=c.policy_id WHERE p.tenant_id IS NOT DISTINCT FROM scope_tenant AND p.revoked_at IS NULL AND p.superseded_at IS NULL ORDER BY c.last_seen_at,c.target_key LIMIT 100) x),'[]'::jsonb),
 'hasMoreHolds',(SELECT count(*)>100 FROM domain.retention_hold WHERE tenant_id IS NOT DISTINCT FROM scope_tenant AND released_at IS NULL),
 'hasMoreConflicts',(SELECT count(*)>100 FROM domain.retention_conflict c JOIN domain.retention_policy p ON p.id=c.policy_id WHERE p.tenant_id IS NOT DISTINCT FROM scope_tenant AND p.revoked_at IS NULL AND p.superseded_at IS NULL));
END $$;
REVOKE ALL ON FUNCTION domain.set_retention_hold(uuid,uuid,jsonb,uuid),domain.release_retention_hold(uuid,uuid,text,text,uuid),domain.retention_status(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.set_retention_hold(uuid,uuid,jsonb,uuid),domain.release_retention_hold(uuid,uuid,text,text,uuid),domain.retention_status(uuid) TO quenda_domain;

-- The fixed handlers are defined by the following migrations. They validate
-- each target again, lock dependencies, and never accept SQL or table names.
CREATE FUNCTION domain.retention_candidate_due(scope_tenant uuid,scope_category text,target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT 1 FROM domain.retention_conflict c JOIN domain.retention_policy p ON p.id=c.policy_id
 WHERE p.tenant_id IS NOT DISTINCT FROM scope_tenant AND p.category=scope_category AND p.revoked_at IS NULL AND p.superseded_at IS NULL
 AND c.target_key=target AND c.last_seen_at>statement_timestamp()-interval '1 hour')
$$;
REVOKE ALL ON FUNCTION domain.retention_candidate_due(uuid,text,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.retention_candidates(scope_tenant uuid,category text,cutoff timestamptz,batch_limit integer)
RETURNS TABLE(target_key text,subject_id text,anchor_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF category IN ('COMMUNICATIONS','RESERVATIONS') THEN RETURN QUERY SELECT * FROM domain.retention_booking_candidates(scope_tenant,category,cutoff,batch_limit);
 ELSIF category IN ('IDENTITY','AUTHENTICATION') THEN RETURN QUERY SELECT * FROM domain.retention_identity_candidates(scope_tenant,category,cutoff,batch_limit);
 ELSE RETURN QUERY SELECT * FROM domain.retention_municipal_candidates(scope_tenant,category,cutoff,batch_limit); END IF;
END $$;
CREATE FUNCTION domain.retention_apply(scope_tenant uuid,category text,target_key text,cutoff timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF category IN ('COMMUNICATIONS','RESERVATIONS') THEN RETURN domain.retention_booking_action(scope_tenant,category,target_key,cutoff);
 ELSIF category IN ('IDENTITY','AUTHENTICATION') THEN RETURN domain.retention_identity_action(scope_tenant,category,target_key,cutoff);
 ELSE RETURN domain.retention_municipal_action(scope_tenant,category,target_key,cutoff); END IF;
END $$;
REVOKE ALL ON FUNCTION domain.retention_candidates(uuid,text,timestamptz,integer),domain.retention_apply(uuid,text,text,timestamptz) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.process_retention_batch(batch_limit integer DEFAULT 10) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE p domain.retention_policy; c record; archived domain.retention_archive; outcome jsonb; event_number bigint; processed integer:=0; conflicts integer:=0; examined integer:=0; cutoff timestamptz;
BEGIN
 IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='23514'; END IF;
 PERFORM domain.lock_retention_control();
 -- Existing legal archives have their own approved destruction date. Revoking a
 -- prospective policy does not extend an already-approved legal retention.
 FOR archived IN SELECT * FROM domain.retention_archive WHERE destroy_after<=statement_timestamp() AND NOT domain.retention_target_held(tenant_id,category,target_key,subject_id) ORDER BY destroy_after,id LIMIT batch_limit FOR UPDATE LOOP
  IF domain.retention_target_held(archived.tenant_id,archived.category,archived.target_key,archived.subject_id) THEN CONTINUE; END IF;
  DELETE FROM domain.retention_archive WHERE id=archived.id;
  INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action,details)
  VALUES('ARCHIVE_DESTROYED',archived.tenant_id,archived.category,archived.target_key,archived.subject_id,'ERASE',jsonb_build_object('archiveId',archived.id,'blockedEvent',archived.event_id));
  processed:=processed+1;
 END LOOP;
 FOR p IN SELECT * FROM domain.retention_policy WHERE revoked_at IS NULL AND superseded_at IS NULL ORDER BY last_scanned_at NULLS FIRST,approved_at,id FOR UPDATE LOOP
  EXIT WHEN examined>=batch_limit;
  UPDATE domain.retention_policy SET last_scanned_at=clock_timestamp() WHERE id=p.id;
  cutoff:=statement_timestamp()-make_interval(days=>p.retention_days);
  FOR c IN SELECT * FROM domain.retention_candidates(p.tenant_id,p.category,cutoff,batch_limit) LOOP
   EXIT WHEN examined>=batch_limit;
   examined:=examined+1;
   BEGIN
    IF domain.retention_target_held(p.tenant_id,p.category,c.target_key,c.subject_id) THEN outcome:=jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD');
    ELSE outcome:=domain.retention_apply(p.tenant_id,p.category,c.target_key,cutoff); END IF;
    IF outcome->>'status'='APPLIED' THEN
     INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,subject_id,action,authorization_reference,details)
     VALUES('RETENTION_APPLIED',p.id,p.tenant_id,p.category,c.target_key,outcome->>'subjectId',p.action,p.approval_reference,jsonb_build_object('cutoff',cutoff,'blockDays',p.block_days)) RETURNING id INTO event_number;
     IF p.action='BLOCK' THEN
      INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after)
      VALUES(gen_random_uuid(),event_number,p.tenant_id,p.category,c.target_key,outcome->>'subjectId',outcome->'payload',statement_timestamp()+make_interval(days=>p.block_days));
     END IF;
     DELETE FROM domain.retention_conflict WHERE policy_id=p.id AND target_key=c.target_key;
     processed:=processed+1;
    ELSIF outcome->>'status'='CONFLICT' THEN
     INSERT INTO domain.retention_conflict(policy_id,target_key,reason) VALUES(p.id,c.target_key,outcome->>'reason')
     ON CONFLICT(policy_id,target_key) DO UPDATE SET reason=EXCLUDED.reason,last_seen_at=clock_timestamp();
     INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,reason) VALUES('RETENTION_SKIPPED',p.id,p.tenant_id,p.category,c.target_key,outcome->>'reason');
     conflicts:=conflicts+1;
    ELSIF outcome->>'status' IS DISTINCT FROM 'ABSENT' THEN RAISE EXCEPTION 'Invalid retention result'; END IF;
   EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO domain.retention_conflict(policy_id,target_key,reason) VALUES(p.id,c.target_key,'PROTECTED_DEPENDENCY') ON CONFLICT(policy_id,target_key) DO UPDATE SET reason=EXCLUDED.reason,last_seen_at=clock_timestamp();
    INSERT INTO domain.retention_event(operation,policy_id,tenant_id,category,target_key,reason) VALUES('RETENTION_SKIPPED',p.id,p.tenant_id,p.category,c.target_key,'PROTECTED_DEPENDENCY');
    conflicts:=conflicts+1;
   END;
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('processed',processed,'conflicts',conflicts,'examined',examined);
END $$;
REVOKE ALL ON FUNCTION domain.process_retention_batch(integer) FROM PUBLIC,quenda_auth,quenda_domain;
GRANT EXECUTE ON FUNCTION domain.process_retention_batch(integer) TO quenda_worker;

CREATE OR REPLACE FUNCTION domain.personal_data_restricted_categories(subject text,scope_tenant uuid,include_global boolean,include_municipal boolean)
RETURNS TABLE(category text,tenant_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT DISTINCT a.category,a.tenant_id FROM domain.retention_archive a WHERE a.subject_id=subject
 AND ((a.tenant_id IS NULL AND include_global) OR (a.tenant_id IS NOT NULL AND include_municipal AND (scope_tenant IS NULL OR a.tenant_id=scope_tenant)))
$$;

CREATE FUNCTION domain.execute_privacy_action(scope_tenant uuid,specification jsonb,correlation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE operation text:=specification->>'action'; category text:=specification->>'category'; target text:=specification->>'targetKey'; outcome jsonb; event_number bigint; block_days integer;
BEGIN
 IF NOT domain.lock_privacy_permission('PRIVACY_EXECUTE',scope_tenant) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 PERFORM domain.lock_retention_control();
 IF specification IS NULL OR jsonb_typeof(specification) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='23514'; END IF;
 IF correlation_id IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(specification) v WHERE v.key<>'blockDays' AND jsonb_typeof(v.value)<>'string')
 OR NOT specification ?& ARRAY['category','targetKey','action','authorizationReference','reason']
 OR (specification-ARRAY['category','targetKey','action','blockDays','authorizationReference','reason'])<>'{}'::jsonb
 OR category IS NULL OR category NOT IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','AUTHENTICATION','IDENTITY','AUTHORITY','ACCREDITATIONS')
 OR operation IS NULL OR operation NOT IN ('ERASE','BLOCK') OR coalesce(length(btrim(target)),0) NOT BETWEEN 1 AND 500
 OR coalesce(length(btrim(specification->>'authorizationReference')),0) NOT BETWEEN 1 AND 500 OR coalesce(length(btrim(specification->>'reason')),0) NOT BETWEEN 1 AND 500
 OR (category IN ('IDENTITY','AUTHENTICATION') AND scope_tenant IS NOT NULL)
 OR (category IN ('COMMUNICATIONS','RESERVATIONS','MUNICIPAL_PROFILE','ACCREDITATIONS') AND scope_tenant IS NULL)
 OR (operation='ERASE' AND specification ? 'blockDays')
 THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='23514'; END IF;
 IF operation='BLOCK' THEN
  IF coalesce(specification->>'blockDays','') !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'Invalid blocking period' USING ERRCODE='23514'; END IF;
  block_days:=(specification->>'blockDays')::integer;
  IF block_days>365000 THEN RAISE EXCEPTION 'Invalid blocking period' USING ERRCODE='23514'; END IF;
 END IF;
 BEGIN
  outcome:=domain.retention_apply(scope_tenant,category,target,statement_timestamp());
 EXCEPTION WHEN foreign_key_violation THEN outcome:=jsonb_build_object('status','CONFLICT','reason','PROTECTED_DEPENDENCY'); END;
 INSERT INTO domain.retention_event(operation,tenant_id,category,target_key,subject_id,action,actor_id,authorization_reference,reason,correlation_id,details)
 VALUES(CASE WHEN outcome->>'status'='APPLIED' THEN 'RIGHTS_ACTION_APPLIED' ELSE 'RIGHTS_ACTION_SKIPPED' END,scope_tenant,category,target,outcome->>'subjectId',operation,current_setting('quenda.account_id',true),specification->>'authorizationReference',specification->>'reason',correlation_id,jsonb_build_object('cutoff',statement_timestamp(),'blockDays',block_days,'outcome',outcome->>'status','conflict',outcome->>'reason')) RETURNING id INTO event_number;
 IF outcome->>'status'='APPLIED' AND operation='BLOCK' THEN
  INSERT INTO domain.retention_archive(id,event_id,tenant_id,category,target_key,subject_id,payload,destroy_after)
  VALUES(gen_random_uuid(),event_number,scope_tenant,category,target,outcome->>'subjectId',outcome->'payload',statement_timestamp()+make_interval(days=>block_days));
 END IF;
 RETURN (outcome-ARRAY['payload','subjectId'])||jsonb_build_object('eventId',event_number::text);
END $$;
REVOKE ALL ON FUNCTION domain.execute_privacy_action(uuid,jsonb,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.execute_privacy_action(uuid,jsonb,uuid) TO quenda_domain;
