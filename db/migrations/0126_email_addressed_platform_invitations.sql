-- Operator invitations and global privacy invitations are addressed to an
-- email address, like municipal authority invitations (0125).
--
-- * recipient_email holds the normalised address. A new invitation has no
--   account_id: nothing is looked up when it is created, so the response never
--   depends on whether an account uses that address.
-- * Only the account whose current verified email equals the address can read
--   or accept it, checked again at acceptance.
-- * Acceptance binds account_id to the accepting account and clears the
--   address: the grant, its history and retention follow the account.
-- * Rows created before this migration keep account_id and no address and stay
--   valid for that account.
-- * Suspending or deactivating the account that owns the verified address
--   withdraws pending invitations sent to that address.
-- * The address of an invitation that ended without acceptance is withdrawn by
--   the global AUTHORITY retention policy under address:operator:<id> or
--   address:privacy:<id>.

ALTER TABLE domain.platform_operator_invitation ALTER COLUMN account_id DROP NOT NULL,
 ADD COLUMN recipient_email text,
 ADD CONSTRAINT platform_operator_invitation_recipient_email CHECK(recipient_email IS NULL OR (
  recipient_email=lower(btrim(recipient_email)) AND length(recipient_email) BETWEEN 3 AND 320
  AND recipient_email ~ '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+$')),
 ADD CONSTRAINT platform_operator_invitation_recipient CHECK(account_id IS NOT NULL OR accepted_at IS NULL);
ALTER TABLE domain.global_privacy_invitation ALTER COLUMN account_id DROP NOT NULL,
 ADD COLUMN recipient_email text,
 ADD CONSTRAINT global_privacy_invitation_recipient_email CHECK(recipient_email IS NULL OR (
  recipient_email=lower(btrim(recipient_email)) AND length(recipient_email) BETWEEN 3 AND 320
  AND recipient_email ~ '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+$')),
 ADD CONSTRAINT global_privacy_invitation_recipient CHECK(account_id IS NOT NULL OR accepted_at IS NULL);
-- One pending operator invitation per address, as there is one per account.
CREATE UNIQUE INDEX platform_operator_pending_address ON domain.platform_operator_invitation(recipient_email)
 WHERE account_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX global_privacy_address ON domain.global_privacy_invitation(recipient_email,id) WHERE account_id IS NULL;

-- Inviting and revoking an address-only invitation has no account subject yet.
ALTER TABLE domain.platform_operator_event ALTER COLUMN subject_id DROP NOT NULL,
 ADD CONSTRAINT platform_operator_event_invitation_subject CHECK(subject_id IS NOT NULL
  OR operation IN ('INVITE_OPERATOR','REVOKE_OPERATOR_INVITATION'));
CREATE INDEX platform_operator_event_invitation ON domain.platform_operator_event(invitation_id) WHERE invitation_id IS NOT NULL;

-- recipient is an address. The issuing operator's own address is rejected: an
-- operator cannot accept a second operator grant. Nothing else is looked up.
DROP FUNCTION domain.invite_operator(text,timestamptz,uuid,uuid);
CREATE FUNCTION domain.invite_operator(recipient text,expiration timestamptz,invitation uuid,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); granted timestamptz;
DECLARE address text:=lower(btrim(recipient));
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF address IS NULL OR expiration IS NULL OR expiration<=clock_timestamp() OR invitation IS NULL OR event_id IS NULL
  OR EXISTS(SELECT 1 FROM auth."user" WHERE id=actor AND lower(btrim(email))=address) THEN RETURN 'INVALID_INPUT'; END IF;
 UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp()
  WHERE account_id IS NULL AND recipient_email=address AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp();
 IF EXISTS(SELECT 1 FROM domain.platform_operator_invitation WHERE account_id IS NULL AND recipient_email=address
  AND accepted_at IS NULL AND revoked_at IS NULL) THEN RETURN 'CONFLICT'; END IF;
 SELECT created_at INTO granted FROM domain.platform_operator WHERE account_id=actor;
 INSERT INTO domain.platform_operator_invitation(id,recipient_email,invited_by,issuer_granted_at,expires_at)
  VALUES(invitation,address,actor,granted,expiration);
 INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,invitation_id)
  VALUES(event_id,actor,'INVITE_OPERATOR',NULL,invitation);
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION domain.invite_operator(text,timestamptz,uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.invite_operator(text,timestamptz,uuid,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.accept_operator_invitation(invitation uuid,event_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); invitation_row domain.platform_operator_invitation; issuer domain.platform_operator;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable global account context required' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(7100182601);
 -- The identity lock also keeps the verified email stable until commit.
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=actor FOR SHARE OF l,u;
 IF actor IS NULL OR event_id IS NULL OR NOT domain.responsible_account_enabled(actor) THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO invitation_row FROM domain.platform_operator_invitation WHERE id=invitation
  AND domain.invitation_addressed_to_current(account_id,recipient_email) FOR UPDATE;
 IF NOT FOUND OR invitation_row.revoked_at IS NOT NULL OR invitation_row.expires_at<=clock_timestamp()
  OR invitation_row.invited_by=actor THEN RETURN 'NOT_FOUND'; END IF;
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
 -- Acceptance binds the account and drops the address.
 UPDATE domain.platform_operator_invitation SET accepted_at=invitation_row.accepted_at,account_id=actor,recipient_email=NULL WHERE id=invitation;
 INSERT INTO domain.platform_operator_event(id,actor_id,operation,subject_id,invitation_id)
  VALUES(event_id,actor,'ACCEPT_OPERATOR',actor,invitation);
 RETURN 'OK';
END $$;

-- The revocation event names the account only when the invitation has one.
CREATE OR REPLACE FUNCTION domain.revoke_operator_invitation(invitation uuid,rationale text,event_id uuid) RETURNS text
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

CREATE OR REPLACE FUNCTION domain.own_operator_invitations(after_id uuid)
RETURNS TABLE(id uuid,expires_at timestamptz,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.id,i.expires_at,CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
  WHEN i.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'REVOKED'
  WHEN i.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING' END
 FROM domain.platform_operator_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE (i.account_id=nullif(current_setting('quenda.account_id',true),'')
   OR (i.account_id IS NULL AND i.recipient_email=domain.current_verified_email()))
  AND domain.account_enabled(nullif(current_setting('quenda.account_id',true),''))
  AND nullif(current_setting('quenda.tenant_id',true),'') IS NULL AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;

DROP FUNCTION domain.list_operator_invitations(uuid);
CREATE FUNCTION domain.list_operator_invitations(after_id uuid)
RETURNS TABLE(id uuid,account_id text,recipient_email text,invited_by text,expires_at timestamptz,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT i.id,i.account_id,i.recipient_email,i.invited_by,i.expires_at,CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
  WHEN i.revoked_at IS NOT NULL OR p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'REVOKED'
  WHEN i.expires_at<=now() THEN 'EXPIRED' ELSE 'PENDING' END
 FROM domain.platform_operator_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE after_id IS NULL OR i.id>after_id ORDER BY i.id LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION domain.list_operator_invitations(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.list_operator_invitations(uuid) TO quenda_domain;

DROP FUNCTION domain.invite_global_privacy(text,timestamptz,timestamptz,text[],text,uuid);
CREATE FUNCTION domain.invite_global_privacy(recipient text,expiration timestamptz,role_expiration timestamptz,actions text[],rationale text,invitation uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); granted timestamptz;
BEGIN
 IF NOT domain.lock_operator_management() THEN RETURN 'FORBIDDEN'; END IF;
 IF recipient IS NULL OR expiration IS NULL OR expiration<=clock_timestamp() OR role_expiration<=clock_timestamp() OR invitation IS NULL
  OR actions IS NULL OR cardinality(actions) NOT BETWEEN 1 AND 2 OR NOT actions <@ ARRAY['PRIVACY_READ','PRIVACY_EXECUTE']::text[]
  OR array_position(actions,NULL) IS NOT NULL OR cardinality(actions)<>(SELECT count(DISTINCT p) FROM unnest(actions) p)
  OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RETURN 'INVALID_INPUT'; END IF;
 SELECT created_at INTO granted FROM domain.platform_operator WHERE account_id=actor;
 INSERT INTO domain.global_privacy_invitation(id,recipient_email,invited_by,issuer_granted_at,permissions,reason,expires_at,role_expires_at)
  VALUES(invitation,lower(btrim(recipient)),actor,granted,actions,btrim(rationale),expiration,role_expiration);
 INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation,reason) VALUES(invitation,actor,'INVITE',btrim(rationale));
 RETURN 'OK';
END $$;
REVOKE ALL ON FUNCTION domain.invite_global_privacy(text,timestamptz,timestamptz,text[],text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.invite_global_privacy(text,timestamptz,timestamptz,text[],text,uuid) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.accept_global_privacy(invitation uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),''); item domain.global_privacy_invitation;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable global context required' USING ERRCODE='42501'; END IF;
 -- The identity lock also keeps the verified email stable until commit.
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id WHERE l.account_id=actor FOR SHARE OF l,u;
 IF NOT domain.responsible_account_enabled(actor) THEN RETURN 'FORBIDDEN'; END IF;
 SELECT * INTO item FROM domain.global_privacy_invitation WHERE id=invitation
  AND domain.invitation_addressed_to_current(account_id,recipient_email) FOR UPDATE;
 IF NOT FOUND OR item.revoked_at IS NOT NULL OR item.role_expires_at<=clock_timestamp() THEN RETURN 'NOT_FOUND'; END IF;
 IF item.accepted_at IS NOT NULL THEN RETURN 'OK'; END IF;
 IF item.expires_at<=clock_timestamp() THEN RETURN 'NOT_FOUND'; END IF;
 PERFORM 1 FROM domain.platform_operator p JOIN auth.account_lifecycle l ON l.account_id=p.account_id JOIN auth."user" u ON u.id=p.account_id
  WHERE p.account_id=item.invited_by AND p.revoked_at IS NULL AND p.created_at=item.issuer_granted_at
   AND domain.responsible_account_enabled(p.account_id) FOR SHARE OF p,l,u;
 IF NOT FOUND THEN RETURN 'NOT_FOUND'; END IF;
 UPDATE domain.global_privacy_invitation SET accepted_at=clock_timestamp(),account_id=actor,recipient_email=NULL WHERE id=invitation;
 INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation) VALUES(invitation,actor,'ACCEPT');
 RETURN 'OK';
END $$;

DROP FUNCTION domain.list_global_privacy_invitations(uuid,boolean);
CREATE FUNCTION domain.list_global_privacy_invitations(after_id uuid,own_only boolean)
RETURNS TABLE(id uuid,account_id text,recipient_email text,invited_by text,permissions text[],reason text,expires_at timestamptz,role_expires_at timestamptz,status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE address text:=domain.current_verified_email();
BEGIN
 IF own_only IS NULL OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL OR NOT domain.account_enabled(actor) THEN
  RAISE EXCEPTION 'Global account context required' USING ERRCODE='42501'; END IF;
 IF NOT own_only AND NOT domain.lock_operator_management() THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT i.id,i.account_id,i.recipient_email,i.invited_by,i.permissions,i.reason,i.expires_at,i.role_expires_at,
  CASE WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
   WHEN i.role_expires_at<=clock_timestamp() THEN 'EXPIRED'
   WHEN i.accepted_at IS NOT NULL AND domain.responsible_account_enabled(i.account_id) THEN 'ACTIVE'
   WHEN i.accepted_at IS NOT NULL THEN 'INVALIDATED'
   WHEN i.expires_at<=clock_timestamp() THEN 'EXPIRED'
   WHEN p.revoked_at IS NOT NULL OR p.created_at<>i.issuer_granted_at OR NOT domain.responsible_account_enabled(p.account_id) THEN 'INVALIDATED'
   ELSE 'PENDING' END
 FROM domain.global_privacy_invitation i JOIN domain.platform_operator p ON p.account_id=i.invited_by
 WHERE (NOT own_only OR i.account_id=actor OR (i.account_id IS NULL AND i.recipient_email=address))
  AND (after_id IS NULL OR i.id>after_id) ORDER BY i.id LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION domain.list_global_privacy_invitations(uuid,boolean) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.list_global_privacy_invitations(uuid,boolean) TO quenda_domain;

-- Withdrawal of an account also withdraws pending invitations sent to its
-- verified address, so it cannot accept them after a later recovery.
CREATE OR REPLACE FUNCTION domain.invalidate_operator_invitations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE address text;
BEGIN
 IF (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL)
    OR (NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL) THEN
  address:=(SELECT lower(btrim(email)) FROM auth."user" WHERE id=NEW.account_id AND "emailVerified");
  UPDATE domain.platform_operator_invitation SET revoked_at=clock_timestamp()
   WHERE (account_id=NEW.account_id OR invited_by=NEW.account_id OR (account_id IS NULL AND recipient_email=address))
    AND accepted_at IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION domain.invalidate_global_privacy_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE address text;
BEGIN
 IF (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL) OR (NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL) THEN
  address:=(SELECT lower(btrim(email)) FROM auth."user" WHERE id=NEW.account_id AND "emailVerified");
  WITH withdrawn AS (
   UPDATE domain.global_privacy_invitation SET revoked_at=clock_timestamp()
    WHERE revoked_at IS NULL AND (account_id=NEW.account_id OR (invited_by=NEW.account_id AND accepted_at IS NULL)
     OR (account_id IS NULL AND recipient_email=address AND accepted_at IS NULL)) RETURNING id
  ) INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation)
    SELECT id,NEW.account_id,'ACCOUNT_WITHDRAWAL' FROM withdrawn;
 END IF;
 RETURN NULL;
END $$;

-- Global AUTHORITY retention: an unaccepted address-only invitation has its
-- own key, anchored at its revocation or expiry; withdrawal clears the address
-- and keeps the invitation and its events as history. Account sets also
-- include the operator events of invitations the account accepted, whose
-- invitation event has no subject.
CREATE OR REPLACE FUNCTION domain.retention_municipal_anchor(scope_tenant uuid,requested_category text,target_key text) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result timestamptz;
BEGIN
 IF requested_category='AUTHORITY' AND target_key LIKE 'access:%' THEN
  SELECT occurred_at INTO result FROM domain.personal_data_access_event WHERE id::text=substring(target_key FROM 8) AND scope_tenant_id IS NOT DISTINCT FROM scope_tenant;
  RETURN result;
 ELSIF requested_category='AUTHORITY' AND target_key LIKE 'denial:%' AND scope_tenant IS NULL THEN
  SELECT occurred_at INTO result FROM domain.access_denial WHERE request_id::text=substring(target_key FROM 8);
  RETURN result;
 ELSIF requested_category='AUTHORITY' AND target_key LIKE 'address:%' THEN
  IF scope_tenant IS NULL THEN
   IF target_key LIKE 'address:operator:%' THEN
    SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.platform_operator_invitation
    WHERE id::text=substring(target_key FROM 18) AND account_id IS NULL AND recipient_email IS NOT NULL;
   ELSIF target_key LIKE 'address:privacy:%' THEN
    SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.global_privacy_invitation
    WHERE id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL;
   END IF;
   RETURN result;
  END IF;
  IF target_key LIKE 'address:administrator:%' THEN
   SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.administrator_invitation
   WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 23) AND account_id IS NULL AND recipient_email IS NOT NULL;
  ELSIF target_key LIKE 'address:manager:%' THEN
   SELECT coalesce(revoked_at,expires_at) INTO result FROM domain.manager_invitation
   WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL;
  END IF;
  RETURN result;
 END IF;
 IF requested_category='MUNICIPAL_PROFILE' AND scope_tenant IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=target_key) THEN RETURN NULL; END IF;
  SELECT max(instant) INTO result FROM (
   SELECT created_at AS instant FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT ends_at FROM domain.reservation WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT e.occurred_at FROM domain.reservation_event e JOIN domain.reservation r ON (r.tenant_id,r.id)=(e.tenant_id,e.reservation_id) WHERE r.tenant_id=scope_tenant AND r.account_id=target_key
   UNION ALL SELECT created_at FROM domain.reservation_notice WHERE tenant_id=scope_tenant AND account_id=target_key
   UNION ALL SELECT occurred_at FROM domain.identity_event WHERE tenant_id=scope_tenant AND (subject_id=target_key OR actor_id=target_key)
   UNION ALL SELECT e.occurred_at FROM domain.manager_event e WHERE e.tenant_id=scope_tenant AND (e.actor_id=target_key OR EXISTS(SELECT 1 FROM domain.manager_invitation i WHERE (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) AND i.account_id=target_key))
   UNION ALL SELECT greatest(c.issued_at,coalesce(c.revoked_at,c.ends_at)) FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id) WHERE c.issuer_tenant_id=scope_tenant AND s.account_id=target_key
  ) activity;
 ELSIF requested_category='AUTHORITY' THEN
  IF scope_tenant IS NOT NULL THEN
   SELECT max(instant) INTO result FROM (
    SELECT coalesce(revoked_at,expires_at,granted_at) AS instant FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,role_expires_at,expires_at,created_at) FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=target_key
    UNION ALL SELECT coalesce(g.revoked_at,i.revoked_at,i.role_expires_at,i.expires_at,i.created_at) FROM domain.manager_invitation i LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id) WHERE i.tenant_id=scope_tenant AND i.account_id=target_key
    UNION ALL SELECT occurred_at FROM domain.identity_event WHERE tenant_id=scope_tenant AND subject_id=target_key
    UNION ALL SELECT e.occurred_at FROM domain.manager_event e JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=target_key
   ) history;
  ELSE
   SELECT max(instant) INTO result FROM (
    SELECT coalesce(revoked_at,created_at) AS instant FROM domain.platform_operator WHERE account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,expires_at,created_at) FROM domain.platform_operator_invitation WHERE account_id=target_key
    UNION ALL SELECT coalesce(revoked_at,role_expires_at,expires_at,created_at) FROM domain.global_privacy_invitation WHERE account_id=target_key
    UNION ALL SELECT occurred_at FROM domain.platform_operator_event WHERE subject_id=target_key
     OR invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=target_key)
    UNION ALL SELECT e.occurred_at FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=target_key
   ) history;
  END IF;
 ELSIF requested_category='ACCREDITATIONS' AND scope_tenant IS NOT NULL THEN
  SELECT coalesce(revoked_at,ends_at) INTO result FROM domain.agreement_credential WHERE issuer_tenant_id=scope_tenant AND id::text=target_key;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION domain.retention_municipal_anchor(uuid,text,text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;

CREATE OR REPLACE FUNCTION domain.retention_municipal_candidates(scope_tenant uuid,category text,cutoff timestamptz,batch_limit integer)
RETURNS TABLE(target_key text,subject_id text,anchor_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF cutoff IS NULL OR NOT isfinite(cutoff) OR batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 1000 OR category IS NULL OR category NOT IN ('MUNICIPAL_PROFILE','AUTHORITY','ACCREDITATIONS') THEN
  RAISE EXCEPTION 'Invalid retention selection' USING ERRCODE='22023'; END IF;
 IF category='MUNICIPAL_PROFILE' AND scope_tenant IS NOT NULL THEN
  RETURN QUERY SELECT p.account_id,p.account_id,a.instant FROM domain.municipal_profile p
   CROSS JOIN LATERAL (SELECT domain.retention_municipal_anchor(scope_tenant,category,p.account_id) AS instant) a
   WHERE p.tenant_id=scope_tenant AND a.instant<=cutoff AND domain.retention_candidate_due(scope_tenant,category,p.account_id) ORDER BY a.instant,p.account_id LIMIT batch_limit;
 ELSIF category='AUTHORITY' THEN
  RETURN QUERY WITH subjects AS (
   SELECT a.account_id AS subject FROM domain.municipal_administrator a WHERE a.tenant_id=scope_tenant
   UNION SELECT i.account_id FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id IS NOT NULL
   UNION SELECT i.account_id FROM domain.manager_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id IS NOT NULL
   UNION SELECT p.account_id FROM domain.platform_operator p WHERE scope_tenant IS NULL
   UNION SELECT i.account_id FROM domain.platform_operator_invitation i WHERE scope_tenant IS NULL AND i.account_id IS NOT NULL
   UNION SELECT i.account_id FROM domain.global_privacy_invitation i WHERE scope_tenant IS NULL AND i.account_id IS NOT NULL
  ), candidates AS (
   SELECT s.subject AS key,s.subject AS subject,a.instant AS anchor FROM subjects s CROSS JOIN LATERAL (SELECT domain.retention_municipal_anchor(scope_tenant,category,s.subject) AS instant) a
    WHERE a.instant<=cutoff AND NOT domain.retention_authority_active(scope_tenant,s.subject)
   UNION ALL SELECT 'access:'||e.id,e.subject_id,e.occurred_at FROM domain.personal_data_access_event e WHERE e.scope_tenant_id IS NOT DISTINCT FROM scope_tenant AND e.occurred_at<=cutoff
   UNION ALL SELECT 'denial:'||e.request_id,e.actor_id,e.occurred_at FROM domain.access_denial e WHERE scope_tenant IS NULL AND e.occurred_at<=cutoff
   UNION ALL SELECT 'address:administrator:'||i.id,NULL::text,coalesce(i.revoked_at,i.expires_at) FROM domain.administrator_invitation i
    WHERE i.tenant_id=scope_tenant AND i.account_id IS NULL AND i.recipient_email IS NOT NULL
     AND coalesce(i.revoked_at,i.expires_at)<=least(cutoff,statement_timestamp())
   UNION ALL SELECT 'address:manager:'||i.id,NULL::text,coalesce(i.revoked_at,i.expires_at) FROM domain.manager_invitation i
    WHERE i.tenant_id=scope_tenant AND i.account_id IS NULL AND i.recipient_email IS NOT NULL
     AND coalesce(i.revoked_at,i.expires_at)<=least(cutoff,statement_timestamp())
   UNION ALL SELECT 'address:operator:'||i.id,NULL::text,coalesce(i.revoked_at,i.expires_at) FROM domain.platform_operator_invitation i
    WHERE scope_tenant IS NULL AND i.account_id IS NULL AND i.recipient_email IS NOT NULL
     AND coalesce(i.revoked_at,i.expires_at)<=least(cutoff,statement_timestamp())
   UNION ALL SELECT 'address:privacy:'||i.id,NULL::text,coalesce(i.revoked_at,i.expires_at) FROM domain.global_privacy_invitation i
    WHERE scope_tenant IS NULL AND i.account_id IS NULL AND i.recipient_email IS NOT NULL
     AND coalesce(i.revoked_at,i.expires_at)<=least(cutoff,statement_timestamp())
  ) SELECT c.key,c.subject,c.anchor FROM candidates c WHERE domain.retention_candidate_due(scope_tenant,category,c.key) ORDER BY c.anchor,c.key LIMIT batch_limit;
 ELSIF category='ACCREDITATIONS' AND scope_tenant IS NOT NULL THEN
  RETURN QUERY SELECT c.id::text,s.account_id,coalesce(c.revoked_at,c.ends_at)
   FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
   WHERE c.issuer_tenant_id=scope_tenant AND coalesce(c.revoked_at,c.ends_at)<=cutoff AND domain.retention_candidate_due(scope_tenant,category,c.id::text)
   ORDER BY coalesce(c.revoked_at,c.ends_at),c.id LIMIT batch_limit;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION domain.retention_municipal_action(scope_tenant uuid,category text,target_key text,cutoff timestamptz,requested_action text,block_days integer,verified_replay boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; anchor timestamptz; payload jsonb; item domain.agreement_credential%ROWTYPE;
 instant timestamptz:=clock_timestamp(); access_item domain.personal_data_access_event%ROWTYPE; denial_item domain.access_denial%ROWTYPE;
 administrator_item domain.administrator_invitation%ROWTYPE; manager_item domain.manager_invitation%ROWTYPE;
 operator_item domain.platform_operator_invitation%ROWTYPE; privacy_item domain.global_privacy_invitation%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR category IS NULL OR category NOT IN ('MUNICIPAL_PROFILE','AUTHORITY','ACCREDITATIONS') OR cutoff IS NULL OR NOT isfinite(cutoff) THEN
  RAISE EXCEPTION 'Invalid retention action' USING ERRCODE='22023'; END IF;
 IF category='AUTHORITY' AND target_key LIKE 'access:%' THEN
  SELECT * INTO access_item FROM domain.personal_data_access_event WHERE id::text=substring(target_key FROM 8) AND scope_tenant_id IS NOT DISTINCT FROM scope_tenant FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  IF access_item.occurred_at>cutoff OR access_item.occurred_at>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',access_item.subject_id); END IF;
  IF domain.retention_target_held(scope_tenant,category,target_key,access_item.subject_id) OR domain.retention_target_held(scope_tenant,category,target_key,access_item.actor_id) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',access_item.subject_id); END IF;
  DELETE FROM domain.personal_data_access_event WHERE id=access_item.id;
  RETURN jsonb_build_object('status','APPLIED','subjectId',access_item.subject_id,'payload',jsonb_build_object('personalDataAccessEvent',to_jsonb(access_item)),'anchorAt',access_item.occurred_at);
 ELSIF category='AUTHORITY' AND target_key LIKE 'denial:%' THEN
  IF scope_tenant IS NOT NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','GLOBAL_SECURITY_SCOPE_REQUIRED','subjectId',NULL); END IF;
  SELECT * INTO denial_item FROM domain.access_denial WHERE request_id::text=substring(target_key FROM 8) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  IF denial_item.occurred_at>cutoff OR denial_item.occurred_at>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',denial_item.actor_id); END IF;
  IF domain.retention_target_held(NULL,category,target_key,denial_item.actor_id) THEN RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',denial_item.actor_id); END IF;
  DELETE FROM domain.access_denial WHERE request_id=denial_item.request_id;
  RETURN jsonb_build_object('status','APPLIED','subjectId',denial_item.actor_id,'payload',jsonb_build_object('accessDenial',to_jsonb(denial_item)),'anchorAt',denial_item.occurred_at);
 ELSIF category='AUTHORITY' AND target_key LIKE 'address:%' THEN
  IF target_key LIKE 'address:operator:%' OR target_key LIKE 'address:privacy:%' THEN
   IF scope_tenant IS NOT NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','GLOBAL_SECURITY_SCOPE_REQUIRED','subjectId',NULL); END IF;
   IF target_key LIKE 'address:operator:%' THEN
    SELECT * INTO operator_item FROM domain.platform_operator_invitation
    WHERE id::text=substring(target_key FROM 18) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(operator_item.revoked_at,operator_item.expires_at);
    payload:=jsonb_build_object('operatorInvitation',to_jsonb(operator_item));
   ELSE
    SELECT * INTO privacy_item FROM domain.global_privacy_invitation
    WHERE id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(privacy_item.revoked_at,privacy_item.expires_at);
    payload:=jsonb_build_object('privacyInvitation',to_jsonb(privacy_item));
   END IF;
  ELSE
   IF scope_tenant IS NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','MUNICIPAL_SCOPE_REQUIRED','subjectId',NULL); END IF;
   IF target_key LIKE 'address:administrator:%' THEN
    SELECT * INTO administrator_item FROM domain.administrator_invitation
    WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 23) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(administrator_item.revoked_at,administrator_item.expires_at);
    payload:=jsonb_build_object('administratorInvitation',to_jsonb(administrator_item));
   ELSIF target_key LIKE 'address:manager:%' THEN
    SELECT * INTO manager_item FROM domain.manager_invitation
    WHERE tenant_id=scope_tenant AND id::text=substring(target_key FROM 17) AND account_id IS NULL AND recipient_email IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
    anchor:=coalesce(manager_item.revoked_at,manager_item.expires_at);
    payload:=jsonb_build_object('managerInvitation',to_jsonb(manager_item));
   ELSE RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  END IF;
  -- A pending invitation is never due: its anchor is still in the future.
  IF anchor>cutoff OR anchor>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',NULL); END IF;
  IF domain.retention_target_held(scope_tenant,category,target_key,NULL) THEN RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',NULL); END IF;
  IF scope_tenant IS NULL THEN
   UPDATE domain.platform_operator_invitation SET recipient_email=NULL WHERE id=operator_item.id;
   UPDATE domain.global_privacy_invitation SET recipient_email=NULL WHERE id=privacy_item.id;
  ELSE
   UPDATE domain.administrator_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=administrator_item.id;
   UPDATE domain.manager_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=manager_item.id;
  END IF;
  RETURN jsonb_build_object('status','APPLIED','subjectId',NULL,'payload',payload,'anchorAt',anchor);
 END IF;
 IF category='ACCREDITATIONS' THEN
  SELECT c.* INTO item FROM domain.agreement_credential c WHERE c.issuer_tenant_id=scope_tenant AND c.id::text=target_key;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',NULL); END IF;
  SELECT s.account_id INTO subject FROM domain.agreement_subject s WHERE (s.agreement_id,s.id)=(item.agreement_id,item.subject_id) FOR SHARE;
 ELSE subject:=target_key; END IF;
 -- Lifecycle lock serializes account withdrawal with destructive identity work.
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 IF category='ACCREDITATIONS' THEN
  SELECT c.* INTO item FROM domain.agreement_credential c WHERE c.issuer_tenant_id=scope_tenant AND c.id::text=target_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 END IF;
 IF category='MUNICIPAL_PROFILE' THEN
  PERFORM 1 FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=subject FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 ELSIF category='AUTHORITY' THEN
  IF scope_tenant IS NOT NULL THEN
   PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject FOR UPDATE;
   PERFORM 1 FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject ORDER BY invitation_id FOR UPDATE;
  ELSE
   PERFORM 1 FROM domain.platform_operator WHERE account_id=subject FOR UPDATE;
   PERFORM 1 FROM domain.platform_operator_invitation WHERE account_id=subject ORDER BY id FOR UPDATE;
   PERFORM 1 FROM domain.global_privacy_invitation WHERE account_id=subject ORDER BY id FOR UPDATE;
  END IF;
 END IF;
 IF category='AUTHORITY' AND domain.retention_authority_active(scope_tenant,subject) THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_AUTHORITY','subjectId',subject); END IF;
 anchor:=domain.retention_municipal_anchor(scope_tenant,category,target_key);
 IF anchor IS NULL THEN RETURN jsonb_build_object('status','ABSENT','subjectId',subject); END IF;
 -- An already withdrawn target needs no further mutation. Its blocked archive
 -- may remain under hold while recovery verifies the original ledger.
 IF domain.retention_target_held(scope_tenant,category,target_key,subject) THEN
  RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',subject); END IF;
 IF anchor>cutoff THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',subject); END IF;
 IF category='MUNICIPAL_PROFILE' THEN
  IF scope_tenant IS NULL THEN RETURN jsonb_build_object('status','CONFLICT','reason','MUNICIPAL_SCOPE_REQUIRED','subjectId',subject); END IF;
  -- A profile is an internal service relation, not a membership to cancel. Any
  -- retained booking, permission or accreditation blocks its removal.
  IF EXISTS(SELECT 1 FROM domain.reservation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject)
  OR EXISTS(SELECT 1 FROM domain.agreement_credential c JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id) WHERE c.issuer_tenant_id=scope_tenant AND s.account_id=subject) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','RETAINED_SERVICE_DEPENDENCIES','subjectId',subject); END IF;
  SELECT jsonb_build_object('municipalProfile',to_jsonb(p)) INTO payload FROM domain.municipal_profile p WHERE p.tenant_id=scope_tenant AND p.account_id=subject;
  DELETE FROM domain.municipal_profile WHERE tenant_id=scope_tenant AND account_id=subject;
 ELSIF category='AUTHORITY' AND scope_tenant IS NOT NULL THEN
  SELECT jsonb_build_object(
   'administrators',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM domain.municipal_administrator a WHERE a.tenant_id=scope_tenant AND a.account_id=subject),'[]'::jsonb),
   'administratorInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.administrator_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'identityEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.identity_event e WHERE e.tenant_id=scope_tenant AND e.subject_id=subject),'[]'::jsonb),
   'managerInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.manager_invitation i WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'managerGrants',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM domain.manager_grant g WHERE g.tenant_id=scope_tenant AND g.account_id=subject),'[]'::jsonb),
   'managerPermissions',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM domain.manager_permission p JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(p.tenant_id,p.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb),
   'managerEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.manager_event e JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) WHERE i.tenant_id=scope_tenant AND i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.manager_event e USING domain.manager_invitation i WHERE (e.tenant_id,e.invitation_id)=(i.tenant_id,i.id) AND i.tenant_id=scope_tenant AND i.account_id=subject;
  DELETE FROM domain.manager_permission p USING domain.manager_invitation i WHERE (p.tenant_id,p.invitation_id)=(i.tenant_id,i.id) AND i.tenant_id=scope_tenant AND i.account_id=subject;
  UPDATE domain.manager_invitation SET replaces_invitation_id=NULL WHERE tenant_id=scope_tenant AND account_id=subject AND replaces_invitation_id IS NOT NULL;
  DELETE FROM domain.manager_grant WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.manager_invitation WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.identity_event WHERE tenant_id=scope_tenant AND subject_id=subject;
  DELETE FROM domain.municipal_administrator WHERE tenant_id=scope_tenant AND account_id=subject;
  DELETE FROM domain.administrator_invitation WHERE tenant_id=scope_tenant AND account_id=subject;
 ELSIF category='AUTHORITY' THEN
  SELECT jsonb_build_object(
   'operators',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM domain.platform_operator p WHERE p.account_id=subject),'[]'::jsonb),
   'operatorInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.platform_operator_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'operatorEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.platform_operator_event e WHERE e.subject_id=subject
    OR e.invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=subject)),'[]'::jsonb),
   'privacyInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.global_privacy_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'privacyEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.global_privacy_permission_event e USING domain.global_privacy_invitation i WHERE e.invitation_id=i.id AND i.account_id=subject;
  DELETE FROM domain.global_privacy_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator_event WHERE subject_id=subject
   OR invitation_id IN (SELECT i.id FROM domain.platform_operator_invitation i WHERE i.account_id=subject);
  DELETE FROM domain.platform_operator_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator WHERE account_id=subject;
 ELSE
  IF item.revoked_at IS NULL AND item.ends_at>instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','ACTIVE_ACCREDITATION','subjectId',subject); END IF;
  IF EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=item.agreement_id AND p.tenant_id<>scope_tenant)
   AND NOT domain.shared_retention_allowed(scope_tenant,category,item.id,requested_action,block_days,verified_replay) THEN
   RETURN jsonb_build_object('status','CONFLICT','reason','SHARED_CONTROLLER_REVIEW','subjectId',subject); END IF;
  payload:=jsonb_build_object('agreementCredential',to_jsonb(item));
  IF EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=item.agreement_id AND p.tenant_id<>scope_tenant) THEN
   payload:=payload||jsonb_build_object('sharedControllers',domain.shared_retention_material(scope_tenant,category,item.id)->'controllers');
  END IF;
  DELETE FROM domain.agreement_credential WHERE id=item.id;
 END IF;
 RETURN jsonb_build_object('status','APPLIED','subjectId',subject,'payload',payload,'anchorAt',anchor);
EXCEPTION WHEN foreign_key_violation THEN
 -- The exception block rolls back every earlier statement in this function,
 -- including deletes. A dependent historic record never causes partial erasure.
 RETURN jsonb_build_object('status','CONFLICT','reason','RETAINED_REFERENCE','subjectId',subject);
END $$;
