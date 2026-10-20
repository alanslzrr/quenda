-- Privacy operations are explicit capabilities, not implicit administrator rights.
ALTER TABLE domain.manager_permission DROP CONSTRAINT manager_permission_operation_check;
ALTER TABLE domain.manager_permission DROP CONSTRAINT manager_permission_check;
ALTER TABLE domain.manager_permission ADD CHECK(operation IN (
 'CATALOG_CREATE','CATALOG_MANAGE','RESERVATION_READ','RESERVATION_MANAGE','UNIT_BLOCK','REPORT_READ','DATA_EXPORT',
 'PRIVACY_READ','PRIVACY_EXECUTE'));
ALTER TABLE domain.manager_permission ADD CHECK(operation NOT IN ('CATALOG_CREATE','PRIVACY_READ','PRIVACY_EXECUTE') OR unit_id IS NULL);

-- Identity-global authorization never confers access to a municipality. The
-- accepted invitation is the grant; new permissions require a new acceptance.
CREATE TABLE domain.global_privacy_invitation (
 id uuid PRIMARY KEY,
 account_id text NOT NULL REFERENCES auth."user"(id),
 invited_by text NOT NULL REFERENCES domain.platform_operator(account_id),
 issuer_granted_at timestamptz NOT NULL,
 permissions text[] NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 role_expires_at timestamptz,
 accepted_at timestamptz,
 revoked_at timestamptz,
 CHECK(cardinality(permissions) BETWEEN 1 AND 2 AND permissions <@ ARRAY['PRIVACY_READ','PRIVACY_EXECUTE']::text[] AND array_position(permissions,NULL) IS NULL),
 CHECK(expires_at>created_at),
 CHECK(role_expires_at IS NULL OR role_expires_at>created_at)
);
CREATE INDEX global_privacy_recipient ON domain.global_privacy_invitation(account_id,id);
CREATE INDEX global_privacy_pending_issuer ON domain.global_privacy_invitation(invited_by) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE domain.global_privacy_permission_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invitation_id uuid NOT NULL REFERENCES domain.global_privacy_invitation(id),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(operation IN ('INVITE','ACCEPT','REVOKE','ACCOUNT_WITHDRAWAL')),
 reason text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(operation NOT IN ('INVITE','REVOKE') OR length(btrim(reason)) BETWEEN 1 AND 500)
);
ALTER TABLE domain.global_privacy_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.global_privacy_invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.global_privacy_permission_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.global_privacy_permission_event FORCE ROW LEVEL SECURITY;
CREATE POLICY global_privacy_invitation_maintenance ON domain.global_privacy_invitation TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY global_privacy_event_maintenance ON domain.global_privacy_permission_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.global_privacy_invitation,domain.global_privacy_permission_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.lock_privacy_permission(action text,scope_tenant uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
BEGIN
 IF action IS NULL OR action NOT IN ('PRIVACY_READ','PRIVACY_EXECUTE') OR tenant IS DISTINCT FROM scope_tenant THEN RETURN false; END IF;
 IF scope_tenant IS NULL THEN
  PERFORM 1 FROM domain.global_privacy_invitation i
   JOIN auth.account_lifecycle l ON l.account_id=i.account_id JOIN auth."user" u ON u.id=i.account_id
   WHERE i.account_id=actor AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
    AND (i.role_expires_at IS NULL OR i.role_expires_at>clock_timestamp()) AND action=ANY(i.permissions)
    AND domain.responsible_account_enabled(actor) ORDER BY i.id LIMIT 1 FOR SHARE OF i,l,u;
 ELSE
  PERFORM 1 FROM domain.manager_grant g
   JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(g.tenant_id,g.invitation_id)
   JOIN domain.manager_permission p ON (p.tenant_id,p.invitation_id)=(g.tenant_id,g.invitation_id)
   JOIN auth.account_lifecycle l ON l.account_id=g.account_id JOIN auth."user" u ON u.id=g.account_id
   WHERE g.tenant_id=scope_tenant AND g.account_id=actor AND g.revoked_at IS NULL
    AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
    AND (i.role_expires_at IS NULL OR i.role_expires_at>clock_timestamp()) AND p.operation=action AND p.unit_id IS NULL
    AND domain.responsible_account_enabled(actor) ORDER BY g.invitation_id LIMIT 1 FOR SHARE OF g,i,l,u;
 END IF;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION domain.lock_privacy_permission(text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.lock_privacy_permission(text,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.lock_permission(action text,resource uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF action IN ('PRIVACY_READ','PRIVACY_EXECUTE') THEN
  IF resource IS NOT NULL OR nullif(current_setting('quenda.tenant_id',true),'') IS NULL THEN RETURN false; END IF;
  RETURN domain.lock_privacy_permission(action,nullif(current_setting('quenda.tenant_id',true),'')::uuid);
 END IF;
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

CREATE FUNCTION domain.invite_global_privacy(target text,expiration timestamptz,role_expiration timestamptz,actions text[],rationale text,invitation uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); granted timestamptz;
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF expiration IS NULL OR expiration<=clock_timestamp() OR role_expiration<=clock_timestamp() OR invitation IS NULL
  OR actions IS NULL OR cardinality(actions) NOT BETWEEN 1 AND 2 OR NOT actions <@ ARRAY['PRIVACY_READ','PRIVACY_EXECUTE']::text[]
  OR array_position(actions,NULL) IS NOT NULL OR cardinality(actions)<>(SELECT count(DISTINCT p) FROM unnest(actions) p)
  OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RETURN 'INVALID_INPUT'; END IF;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=target FOR SHARE OF l,u;
 IF NOT domain.account_enabled(target) THEN RETURN 'INVALID_INPUT'; END IF;
 SELECT created_at INTO granted FROM domain.platform_operator WHERE account_id=actor;
 INSERT INTO domain.global_privacy_invitation(id,account_id,invited_by,issuer_granted_at,permissions,reason,expires_at,role_expires_at)
  VALUES(invitation,target,actor,granted,actions,btrim(rationale),expiration,role_expiration);
 INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation,reason) VALUES(invitation,actor,'INVITE',btrim(rationale));
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.accept_global_privacy(invitation uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); item domain.global_privacy_invitation;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable global context required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=actor FOR SHARE OF l,u;
 IF NOT domain.responsible_account_enabled(actor) THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO item FROM domain.global_privacy_invitation WHERE id=invitation AND account_id=actor FOR UPDATE;
 IF NOT FOUND OR item.revoked_at IS NOT NULL OR item.role_expires_at<=clock_timestamp() THEN RETURN 'NOT_FOUND'; END IF;
 IF item.accepted_at IS NOT NULL THEN RETURN 'OK'; END IF;
 IF item.expires_at<=clock_timestamp() THEN RETURN 'NOT_FOUND'; END IF;
 PERFORM 1 FROM domain.platform_operator p JOIN auth.account_lifecycle l ON l.account_id=p.account_id JOIN auth."user" u ON u.id=p.account_id
  WHERE p.account_id=item.invited_by AND p.revoked_at IS NULL AND p.created_at=item.issuer_granted_at
   AND domain.responsible_account_enabled(p.account_id) FOR SHARE OF p,l,u;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 UPDATE domain.global_privacy_invitation SET accepted_at=clock_timestamp() WHERE id=invitation;
 INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation) VALUES(invitation,actor,'ACCEPT');
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.revoke_global_privacy(invitation uuid,rationale text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RETURN 'INVALID_INPUT'; END IF;
 PERFORM 1 FROM domain.global_privacy_invitation WHERE id=invitation FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 UPDATE domain.global_privacy_invitation SET revoked_at=clock_timestamp() WHERE id=invitation AND revoked_at IS NULL;
 IF FOUND THEN
  INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation,reason) VALUES(invitation,actor,'REVOKE',btrim(rationale));
 END IF;
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.list_global_privacy_invitations(after_id uuid,own_only boolean)
RETURNS TABLE(id uuid,account_id text,invited_by text,permissions text[],reason text,expires_at timestamptz,role_expires_at timestamptz,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF own_only IS NULL OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL OR NOT domain.account_enabled(actor) THEN
  RAISE EXCEPTION 'Global account context required' USING ERRCODE='42501'; END IF;
 IF NOT own_only AND NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT i.id,i.account_id,i.invited_by,i.permissions,i.reason,i.expires_at,i.role_expires_at,
  CASE WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
   WHEN i.role_expires_at<=clock_timestamp() THEN 'EXPIRED'
   WHEN i.accepted_at IS NOT NULL AND domain.responsible_account_enabled(i.account_id) THEN 'ACTIVE'
   WHEN i.accepted_at IS NOT NULL THEN 'INVALIDATED'
   WHEN i.expires_at<=clock_timestamp() THEN 'EXPIRED'
   WHEN p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'INVALIDATED'
   ELSE 'PENDING' END
 FROM domain.global_privacy_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE (NOT own_only OR i.account_id=actor) AND (after_id IS NULL OR i.id>after_id) ORDER BY i.id LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION domain.invite_global_privacy(text,timestamptz,timestamptz,text[],text,uuid),domain.accept_global_privacy(uuid),domain.revoke_global_privacy(uuid,text),domain.list_global_privacy_invitations(uuid,boolean) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.invite_global_privacy(text,timestamptz,timestamptz,text[],text,uuid),domain.accept_global_privacy(uuid),domain.revoke_global_privacy(uuid,text),domain.list_global_privacy_invitations(uuid,boolean) TO quenda_domain;

CREATE FUNCTION domain.invalidate_global_privacy_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL) OR (NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL) THEN
  WITH withdrawn AS (
   UPDATE domain.global_privacy_invitation SET revoked_at=clock_timestamp()
    WHERE revoked_at IS NULL AND (account_id=NEW.account_id OR (invited_by=NEW.account_id AND accepted_at IS NULL)) RETURNING id
  ) INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation)
    SELECT id,NEW.account_id,'ACCOUNT_WITHDRAWAL' FROM withdrawn;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER global_privacy_account_withdrawal AFTER UPDATE ON auth.account_lifecycle
 FOR EACH ROW EXECUTE FUNCTION domain.invalidate_global_privacy_authority();
CREATE FUNCTION auth.guard_global_privacy_mfa() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD."twoFactorEnabled" AND NOT coalesce(NEW."twoFactorEnabled",false) AND EXISTS(
  SELECT 1 FROM domain.global_privacy_invitation WHERE account_id=NEW.id AND accepted_at IS NOT NULL AND revoked_at IS NULL
   AND (role_expires_at IS NULL OR role_expires_at>clock_timestamp())) THEN
  RAISE EXCEPTION 'Privacy authority requires MFA' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER global_privacy_mfa_guard BEFORE UPDATE OF "twoFactorEnabled" ON auth."user"
 FOR EACH ROW EXECUTE FUNCTION auth.guard_global_privacy_mfa();
REVOKE ALL ON FUNCTION domain.invalidate_global_privacy_authority(),auth.guard_global_privacy_mfa() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
