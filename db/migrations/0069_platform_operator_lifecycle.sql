-- Global authority remains separate from municipal roles and citizen access.
CREATE TABLE domain.platform_operator_invitation (
 id uuid PRIMARY KEY,
 account_id text NOT NULL REFERENCES auth."user"(id),
 invited_by text NOT NULL REFERENCES domain.platform_operator(account_id),
 issuer_granted_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 revoked_at timestamptz,
 CHECK(account_id<>invited_by),
 CHECK(expires_at>created_at),
 CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX platform_operator_pending_invitation ON domain.platform_operator_invitation(account_id)
 WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX platform_operator_invitation_issuer ON domain.platform_operator_invitation(invited_by)
 WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE domain.platform_operator_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.platform_operator_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_invitation_maintenance ON domain.platform_operator_invitation TO quenda_migrator USING(true) WITH CHECK(true);

CREATE TABLE domain.platform_operator_event (
 id uuid PRIMARY KEY,
 actor_id text REFERENCES auth."user"(id),
 operational_actor text,
 operation text NOT NULL CHECK(operation IN ('INVITE_OPERATOR','ACCEPT_OPERATOR','REVOKE_OPERATOR_INVITATION','REVOKE_OPERATOR','RECOVER_OPERATOR')),
 subject_id text NOT NULL REFERENCES auth."user"(id),
 invitation_id uuid REFERENCES domain.platform_operator_invitation(id),
 reason text,
 authority_reference text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((actor_id IS NOT NULL)<>(operational_actor IS NOT NULL)),
 CHECK(operation<>'RECOVER_OPERATOR' OR (operational_actor IS NOT NULL AND nullif(btrim(authority_reference),'') IS NOT NULL AND nullif(btrim(reason),'') IS NOT NULL)),
 CHECK(operation NOT IN ('REVOKE_OPERATOR','REVOKE_OPERATOR_INVITATION') OR nullif(btrim(reason),'') IS NOT NULL)
);
CREATE INDEX platform_operator_event_subject ON domain.platform_operator_event(subject_id,occurred_at);
ALTER TABLE domain.platform_operator_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.platform_operator_event FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_event_maintenance ON domain.platform_operator_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.platform_operator_invitation,domain.platform_operator_event FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE OR REPLACE FUNCTION domain.lock_current_operator() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.platform_operator p
  JOIN auth."user" u ON u.id=p.account_id
  JOIN auth.account_lifecycle l ON l.account_id=p.account_id
  WHERE p.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND p.revoked_at IS NULL AND domain.responsible_account_enabled(p.account_id) FOR SHARE OF p,u,l)
$$;

-- The mutex serializes admission and withdrawal; SERIALIZABLE retries refresh
-- snapshots after concurrent handovers. No direct role DML is granted to HTTP.
CREATE FUNCTION domain.lock_operator_management() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'serializable'
    OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable global account context required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(7100182601);
 RETURN domain.lock_current_operator();
END $$;
REVOKE ALL ON FUNCTION domain.lock_operator_management() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE FUNCTION domain.invite_operator(target text,expiration timestamptz,invitation uuid,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); granted timestamptz;
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF target=actor OR expiration IS NULL OR expiration<=clock_timestamp() OR invitation IS NULL OR event_id IS NULL THEN RETURN 'INVALID_INPUT'; END IF;
 -- Lock the destination account against simultaneous closure/suspension.
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=target FOR SHARE OF l,u;
 IF NOT domain.account_enabled(target) THEN RETURN 'INVALID_INPUT'; END IF;
 IF EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=target AND revoked_at IS NULL) THEN RETURN 'CONFLICT'; END IF;
 UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp()
  WHERE account_id=target AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp();
 IF EXISTS(SELECT 1 FROM domain.platform_operator_invitation WHERE account_id=target AND accepted_at IS NULL AND revoked_at IS NULL) THEN RETURN 'CONFLICT'; END IF;
 SELECT created_at INTO granted FROM domain.platform_operator WHERE account_id=actor;
 INSERT INTO domain.platform_operator_invitation(id,account_id,invited_by,issuer_granted_at,expires_at)
  VALUES(invitation,target,actor,granted,expiration);
 INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,invitation_id)
  VALUES(event_id,actor,'INVITE_OPERATOR',target,invitation);
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.accept_operator_invitation(invitation uuid,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); invitation_row domain.platform_operator_invitation; issuer domain.platform_operator;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable global account context required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(7100182601);
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=actor FOR SHARE OF l,u;
 IF actor IS NULL OR event_id IS NULL OR NOT domain.responsible_account_enabled(actor) THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO invitation_row FROM domain.platform_operator_invitation WHERE id=invitation AND account_id=actor FOR UPDATE;
 IF NOT FOUND OR invitation_row.revoked_at IS NOT NULL OR invitation_row.expires_at<=clock_timestamp() THEN RETURN 'NOT_FOUND'; END IF;
 SELECT p.* INTO issuer FROM domain.platform_operator p JOIN auth."user" u ON u.id=p.account_id JOIN auth.account_lifecycle l ON l.account_id=p.account_id WHERE p.account_id=invitation_row.invited_by AND p.revoked_at IS NULL FOR SHARE OF p,u,l;
 IF NOT FOUND OR issuer.created_at<>invitation_row.issuer_granted_at OR NOT domain.responsible_account_enabled(issuer.account_id) THEN RETURN 'NOT_FOUND'; END IF;
 IF invitation_row.accepted_at IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=actor AND revoked_at IS NULL AND created_at=invitation_row.accepted_at) THEN RETURN 'OK'; END IF;
  RETURN 'NOT_FOUND';
 END IF;
 IF EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=actor AND revoked_at IS NULL) THEN RETURN 'CONFLICT'; END IF;
 invitation_row.accepted_at:=clock_timestamp();
 INSERT INTO domain.platform_operator(account_id,created_at) VALUES(actor,invitation_row.accepted_at)
  ON CONFLICT(account_id) DO UPDATE SET created_at=EXCLUDED.created_at,revoked_at=NULL;
 UPDATE domain.platform_operator_invitation SET accepted_at=invitation_row.accepted_at WHERE id=invitation;
 INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,invitation_id)
  VALUES(event_id,actor,'ACCEPT_OPERATOR',actor,invitation);
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.revoke_operator_invitation(invitation uuid,rationale text,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); target text;
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF nullif(btrim(rationale),'') IS NULL OR length(rationale)>500 OR event_id IS NULL THEN RETURN 'INVALID_INPUT'; END IF;
 SELECT account_id INTO target FROM domain.platform_operator_invitation WHERE id=invitation AND accepted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp() WHERE id=invitation AND revoked_at IS NULL;
 IF FOUND THEN
  INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,invitation_id,reason)
   VALUES(event_id,actor,'REVOKE_OPERATOR_INVITATION',target,invitation,btrim(rationale));
 END IF;
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.revoke_operator(target text,rationale text,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF nullif(btrim(rationale),'') IS NULL OR length(rationale)>500 OR event_id IS NULL THEN RETURN 'INVALID_INPUT'; END IF;
 PERFORM 1 FROM domain.platform_operator WHERE account_id=target AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.platform_operator p WHERE p.account_id<>target AND p.revoked_at IS NULL AND domain.responsible_account_enabled(p.account_id)) THEN RETURN 'HANDOVER_REQUIRED'; END IF;
 UPDATE domain.platform_operator SET revoked_at=clock_timestamp() WHERE account_id=target;
 UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp()
  WHERE invited_by=target AND accepted_at IS NULL AND revoked_at IS NULL;
 WITH withdrawn AS (
  UPDATE domain.administrator_invitation SET revoked_at=clock_timestamp()
   WHERE invited_by=target AND grant_source IN ('PLATFORM','RECOVERY') AND accepted_at IS NULL AND revoked_at IS NULL
   RETURNING tenant_id,id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant_id,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,btrim(rationale) FROM withdrawn;
 INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,reason)
  VALUES(event_id,actor,'REVOKE_OPERATOR',target,btrim(rationale));
 RETURN 'OK';
END $$;

CREATE FUNCTION domain.own_operator_invitations(after_id uuid)
RETURNS TABLE(id uuid,expires_at timestamptz,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.id,i.expires_at,CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
  WHEN i.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'REVOKED'
  WHEN i.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING' END
 FROM domain.platform_operator_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE i.account_id=nullif(current_setting('quenda.account_id',true),'') AND domain.account_enabled(i.account_id)
  AND nullif(current_setting('quenda.tenant_id',true),'') IS NULL AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;

CREATE FUNCTION domain.list_operator_invitations(after_id uuid)
RETURNS TABLE(id uuid,account_id text,invited_by text,expires_at timestamptz,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT i.id,i.account_id,i.invited_by,i.expires_at,CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
  WHEN i.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'REVOKED'
  WHEN i.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING' END
 FROM domain.platform_operator_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE after_id IS NULL OR i.id>after_id ORDER BY i.id LIMIT 21;
END $$;

CREATE FUNCTION domain.list_platform_operators(after_account text)
RETURNS TABLE(account_id text,granted_at timestamptz,revoked_at timestamptz,active boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT p.account_id,p.created_at,p.revoked_at,p.revoked_at IS NULL AND domain.responsible_account_enabled(p.account_id)
 FROM domain.platform_operator p WHERE after_account IS NULL OR p.account_id>after_account ORDER BY p.account_id LIMIT 21;
END $$;

REVOKE ALL ON FUNCTION domain.invite_operator(text,timestamptz,uuid,uuid),domain.accept_operator_invitation(uuid,uuid),domain.revoke_operator_invitation(uuid,text,uuid),domain.revoke_operator(text,text,uuid),domain.own_operator_invitations(uuid),domain.list_operator_invitations(uuid),domain.list_platform_operators(text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.invite_operator(text,timestamptz,uuid,uuid),domain.accept_operator_invitation(uuid,uuid),domain.revoke_operator_invitation(uuid,text,uuid),domain.revoke_operator(text,text,uuid),domain.own_operator_invitations(uuid),domain.list_operator_invitations(uuid),domain.list_platform_operators(text) TO quenda_domain;

-- Withdrawal of global access invalidates unaccepted delegation in either
-- direction; subsequent identity recovery does not resurrect these invitations.
CREATE FUNCTION domain.invalidate_operator_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL)
    OR (NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL) THEN
  UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp()
   WHERE (account_id=NEW.account_id OR invited_by=NEW.account_id) AND accepted_at IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.invalidate_operator_invitations() FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE TRIGGER operator_invitations_account_withdrawal AFTER UPDATE ON auth.account_lifecycle
 FOR EACH ROW EXECUTE FUNCTION domain.invalidate_operator_invitations();
