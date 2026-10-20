-- Administrative authority requires a usable identity, not merely an unrevoked
-- role. Existing invitations and grants retain their historical evidence.
ALTER TABLE domain.administrator_invitation DROP CONSTRAINT administrator_invitation_grant_source_check;
ALTER TABLE domain.administrator_invitation ADD CHECK(grant_source IN ('PLATFORM','MUNICIPAL','RECOVERY'));
ALTER TABLE domain.identity_event ADD COLUMN verification_reference text;
ALTER TABLE domain.identity_event ADD CHECK(verification_reference IS NULL OR length(btrim(verification_reference)) BETWEEN 1 AND 500);
ALTER TABLE domain.identity_event DROP CONSTRAINT identity_event_operation_check;
ALTER TABLE domain.identity_event ADD CHECK(operation IN (
 'CREATE_MUNICIPALITY','INVITE_ADMINISTRATOR','ACCEPT_ADMINISTRATOR','REVOKE_INVITATION','REVOKE_ADMINISTRATOR',
 'MAKE_ADMINISTRATOR_INDEFINITE','SECURITY_REVOKE_ADMINISTRATOR','RECOVER_ADMINISTRATOR'));
ALTER TABLE domain.identity_event ADD CHECK(operation NOT IN ('MAKE_ADMINISTRATOR_INDEFINITE','SECURITY_REVOKE_ADMINISTRATOR','RECOVER_ADMINISTRATOR')
 OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500));
ALTER TABLE domain.identity_event ADD CHECK(operation<>'RECOVER_ADMINISTRATOR' OR verification_reference IS NOT NULL);

CREATE OR REPLACE FUNCTION domain.current_is_administrator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.municipal_administrator a
  WHERE a.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
   AND a.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())
   AND domain.responsible_account_enabled(a.account_id))
$$;
CREATE OR REPLACE FUNCTION domain.lock_current_administrator() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.municipal_administrator a
  JOIN auth.account_lifecycle l ON l.account_id=a.account_id JOIN auth."user" u ON u.id=a.account_id
  WHERE a.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
   AND a.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())
   AND domain.responsible_account_enabled(a.account_id) FOR SHARE OF a,l,u)
$$;

CREATE OR REPLACE FUNCTION domain.lock_invitation_authority(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item domain.administrator_invitation;
BEGIN
 SELECT * INTO item FROM domain.administrator_invitation
  WHERE tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND id=invitation
   AND account_id=nullif(current_setting('quenda.account_id',true),'');
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=item.account_id AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=item.invited_by AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.grant_source IN ('PLATFORM','RECOVERY') THEN
  IF item.grant_source='PLATFORM' AND NOT domain.municipality_bootstrap_open() THEN RETURN false; END IF;
  IF item.grant_source='RECOVERY' AND EXISTS(SELECT 1 FROM domain.municipal_administrator a
   WHERE a.tenant_id=item.tenant_id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())
    AND domain.responsible_account_enabled(a.account_id)) THEN RETURN false; END IF;
  PERFORM 1 FROM domain.platform_operator WHERE account_id=item.invited_by AND revoked_at IS NULL FOR SHARE;
 ELSE
  PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id=item.tenant_id AND account_id=item.invited_by
   AND invitation_id=item.issuer_invitation_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE;
 END IF;
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION domain.activate_administrator(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item domain.administrator_invitation;
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR NOT domain.lock_invitation_authority(invitation) THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.administrator_invitation
  WHERE tenant_id=tenant AND id=invitation AND account_id=nullif(current_setting('quenda.account_id',true),'')
   AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now())
   AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.role_expires_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a
  WHERE a.tenant_id=tenant AND a.revoked_at IS NULL AND a.expires_at IS NULL
   AND domain.responsible_account_enabled(a.account_id)) THEN
  RAISE EXCEPTION 'HANDOVER_REQUIRED' USING ERRCODE='P0001';
 END IF;
 INSERT INTO domain.municipal_administrator AS existing(tenant_id,account_id,invitation_id,expires_at)
  VALUES(tenant,item.account_id,item.id,item.role_expires_at)
  ON CONFLICT(tenant_id,account_id) DO UPDATE SET revoked_at=NULL,granted_at=now(),invitation_id=item.id,expires_at=item.role_expires_at
   WHERE (existing.revoked_at IS NOT NULL AND item.created_at>existing.revoked_at)
    OR (existing.revoked_at IS NULL AND existing.expires_at<=now() AND item.created_at>existing.expires_at);
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION domain.revoke_administrator(subject text,rationale text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE source uuid;
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_administrator() THEN RETURN NULL; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 SELECT invitation_id INTO source FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant AND a.account_id<>subject
  AND a.revoked_at IS NULL AND a.expires_at IS NULL AND domain.responsible_account_enabled(a.account_id)) THEN
  RAISE EXCEPTION 'HANDOVER_REQUIRED' USING ERRCODE='P0001';
 END IF;
 UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=tenant AND account_id=subject;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND invited_by=subject AND grant_source='MUNICIPAL'
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
 WITH revoked AS (
  UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND invited_by=subject AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
 ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
  SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',rationale FROM revoked;
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  VALUES(tenant,gen_random_uuid(),actor,'REVOKE_ADMINISTRATOR',subject,source,rationale);
 RETURN source;
END $$;

CREATE FUNCTION domain.make_administrator_indefinite(subject text,rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE source uuid;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=subject AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE domain.municipal_administrator SET expires_at=NULL
  WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL AND expires_at>now() RETURNING invitation_id INTO source;
 IF NOT FOUND THEN
  RETURN EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL AND expires_at IS NULL);
 END IF;
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  VALUES(tenant,gen_random_uuid(),actor,'MAKE_ADMINISTRATOR_INDEFINITE',subject,source,rationale);
 RETURN true;
END $$;

-- The exceptional local operation does not touch auth sessions or roles in any
-- other municipality. Its reason and separate audit operation identify security
-- containment, including the deliberate loss of the last usable administrator.
CREATE FUNCTION domain.revoke_municipal_access_for_security(subject text,rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE source uuid;
DECLARE affected boolean:=false;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 UPDATE domain.municipal_administrator SET revoked_at=now() WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL RETURNING invitation_id INTO source;
 IF FOUND THEN
  affected:=true;
  INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
   VALUES(tenant,gen_random_uuid(),actor,'SECURITY_REVOKE_ADMINISTRATOR',subject,source,rationale);
 END IF;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant
   AND (account_id=subject OR (invited_by=subject AND grant_source='MUNICIPAL')) AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
 affected:=affected OR FOUND;
 WITH revoked AS (
  UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=tenant AND account_id=subject AND revoked_at IS NULL RETURNING invitation_id
 ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
  SELECT tenant,gen_random_uuid(),invitation_id,actor,'REVOKE_MANAGER',rationale FROM revoked;
 affected:=affected OR FOUND;
 WITH revoked AS (
  UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND (account_id=subject OR invited_by=subject)
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
 ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
  SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',rationale FROM revoked;
 RETURN affected OR FOUND;
END $$;

CREATE FUNCTION domain.recover_municipal_administrator(subject text,expiry timestamptz,rationale text,verification text,invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_operator() THEN RETURN false; END IF;
 IF expiry IS NULL OR expiry<=now() OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500
  OR verification IS NULL OR length(btrim(verification)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid recovery' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR domain.municipality_bootstrap_open() OR NOT domain.account_enabled(subject) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant AND a.revoked_at IS NULL
  AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(a.account_id)) THEN RETURN false; END IF;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND grant_source='RECOVERY'
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
 INSERT INTO domain.administrator_invitation(tenant_id,id,account_id,invited_by,expires_at,grant_source)
  VALUES(tenant,invitation,subject,actor,expiry,'RECOVERY');
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason,verification_reference)
  VALUES(tenant,gen_random_uuid(),actor,'RECOVER_ADMINISTRATOR',subject,invitation,rationale,verification);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION domain.accept_manager(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE item domain.manager_invitation;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=actor AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation AND account_id=actor;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM domain.municipal_administrator a JOIN auth.account_lifecycle l ON l.account_id=a.account_id JOIN auth."user" u ON u.id=a.account_id
  WHERE a.tenant_id=tenant AND a.account_id=item.invited_by AND a.invitation_id=item.issuer_invitation_id
   AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(a.account_id) FOR SHARE OF a,l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation AND account_id=actor
  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.replaces_invitation_id IS NOT NULL THEN
  PERFORM 1 FROM domain.manager_grant WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id AND account_id=actor AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES(tenant,actor) ON CONFLICT DO NOTHING;
 INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES(tenant,invitation,actor);
 UPDATE domain.manager_invitation SET accepted_at=now() WHERE tenant_id=tenant AND id=invitation;
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation) VALUES(tenant,gen_random_uuid(),invitation,actor,'ACCEPT_MANAGER');
 IF item.replaces_invitation_id IS NOT NULL THEN
  UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id;
  INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,previous_invitation_id)
   VALUES(tenant,gen_random_uuid(),invitation,actor,'REPLACE_MANAGER',item.replaces_invitation_id);
 END IF;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION domain.lock_permission(action text,resource uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF action IS NULL OR action NOT IN ('CATALOG_CREATE','CATALOG_MANAGE','RESERVATION_READ','RESERVATION_MANAGE','UNIT_BLOCK','REPORT_READ','DATA_EXPORT') THEN RETURN false; END IF;
 IF domain.lock_current_administrator() THEN RETURN true; END IF;
 PERFORM 1 FROM domain.manager_grant g JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(g.tenant_id,g.invitation_id)
  JOIN domain.manager_permission p ON (p.tenant_id,p.invitation_id)=(g.tenant_id,g.invitation_id)
  JOIN auth.account_lifecycle l ON l.account_id=g.account_id JOIN auth."user" u ON u.id=g.account_id
  WHERE g.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND g.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND g.revoked_at IS NULL AND domain.responsible_account_enabled(g.account_id)
   AND (i.role_expires_at IS NULL OR i.role_expires_at>now()) AND p.operation=action
   AND (p.unit_id IS NULL OR p.unit_id=resource) ORDER BY g.invitation_id LIMIT 1 FOR SHARE OF g,l,u;
 RETURN FOUND;
END $$;

-- A tenant-scoped projection avoids exposing arbitrary identities' lifecycle.
CREATE FUNCTION domain.municipal_administrator_is_enabled(subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.current_is_administrator() AND EXISTS(SELECT 1 FROM domain.municipal_administrator a
  WHERE a.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND a.account_id=subject
   AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(a.account_id))
$$;
REVOKE ALL ON FUNCTION domain.make_administrator_indefinite(text,text),domain.revoke_municipal_access_for_security(text,text),
 domain.recover_municipal_administrator(text,timestamptz,text,text,uuid),domain.municipal_administrator_is_enabled(text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.make_administrator_indefinite(text,text),domain.revoke_municipal_access_for_security(text,text),
 domain.recover_municipal_administrator(text,timestamptz,text,text,uuid),domain.municipal_administrator_is_enabled(text) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.own_manager_invitations(after_id uuid)
RETURNS TABLE(id uuid,tenant_id uuid,municipality text,expires_at timestamptz,role_expires_at timestamptz,status text,permissions jsonb,replaces_invitation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.id,i.tenant_id,m.name,i.expires_at,i.role_expires_at,
   CASE WHEN i.revoked_at IS NOT NULL OR g.revoked_at IS NOT NULL THEN 'REVOKED'
     WHEN i.role_expires_at <= now() THEN 'EXPIRED'
     WHEN g.invitation_id IS NOT NULL AND NOT domain.responsible_account_enabled(i.account_id) THEN 'INVALIDATED'
     WHEN g.invitation_id IS NOT NULL THEN 'ACTIVE'
     WHEN i.expires_at <= now() THEN 'EXPIRED'
     WHEN i.replaces_invitation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.manager_grant old WHERE old.tenant_id=i.tenant_id AND old.invitation_id=i.replaces_invitation_id AND old.revoked_at IS NULL) THEN 'INVALIDATED'
     WHEN NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=i.tenant_id AND a.account_id=i.invited_by
       AND domain.responsible_account_enabled(a.account_id) AND a.invitation_id=i.issuer_invitation_id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())) THEN 'INVALIDATED'
     ELSE 'PENDING' END,
   (SELECT jsonb_agg(jsonb_build_object('operation',p.operation,'unitId',p.unit_id) ORDER BY p.operation,p.unit_id)
     FROM domain.manager_permission p WHERE p.tenant_id=i.tenant_id AND p.invitation_id=i.id),i.replaces_invitation_id
 FROM domain.manager_invitation i JOIN domain.municipality m ON m.id=i.tenant_id
 LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id)
 WHERE i.account_id=nullif(current_setting('quenda.account_id',true),'') AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;

CREATE OR REPLACE FUNCTION domain.own_administrator_invitations(after_id uuid)
RETURNS TABLE(id uuid,tenant_id uuid,municipality text,expires_at timestamptz,status text,role_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.id,i.tenant_id,m.name,i.expires_at,
  CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
   WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
   WHEN i.expires_at<=now() OR i.role_expires_at<=now() THEN 'EXPIRED'
   WHEN NOT domain.responsible_account_enabled(i.invited_by) THEN 'INVALIDATED'
   WHEN i.grant_source='MUNICIPAL' AND NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a
    WHERE a.tenant_id=i.tenant_id AND a.account_id=i.invited_by AND a.invitation_id=i.issuer_invitation_id
     AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())) THEN 'INVALIDATED'
   WHEN i.grant_source IN ('PLATFORM','RECOVERY') AND NOT EXISTS(SELECT 1 FROM domain.platform_operator p
    WHERE p.account_id=i.invited_by AND p.revoked_at IS NULL) THEN 'INVALIDATED'
   WHEN i.grant_source='PLATFORM' AND EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=i.tenant_id) THEN 'INVALIDATED'
   WHEN i.grant_source='RECOVERY' AND EXISTS(SELECT 1 FROM domain.municipal_administrator a
    WHERE a.tenant_id=i.tenant_id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())
     AND domain.responsible_account_enabled(a.account_id)) THEN 'INVALIDATED'
   ELSE 'PENDING' END,i.role_expires_at
 FROM domain.administrator_invitation i JOIN domain.municipality m ON m.id=i.tenant_id
 WHERE i.account_id=nullif(current_setting('quenda.account_id',true),'') AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;
