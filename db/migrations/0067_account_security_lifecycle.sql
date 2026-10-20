-- Authentication proofs and account authority share one transactional boundary.
ALTER TABLE auth.account_lifecycle ADD COLUMN suspended_at timestamptz;
ALTER TABLE auth.account_lifecycle ADD COLUMN suspended_password_fingerprint text;
ALTER TABLE auth.account_lifecycle ADD COLUMN suspended_mfa_fingerprint text;
ALTER TABLE auth.account_lifecycle ADD COLUMN suspended_backup_fingerprint text;
ALTER TABLE auth.account_deactivation_event DROP CONSTRAINT account_deactivation_event_subject_id_key;
CREATE FUNCTION domain.account_enabled(subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
 WHERE l.account_id=subject AND l.deactivated_at IS NULL AND l.suspended_at IS NULL AND u."emailVerified")
$$;
CREATE FUNCTION domain.responsible_account_enabled(subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain.account_enabled(subject) AND EXISTS(SELECT 1 FROM auth."user" WHERE id=subject AND "twoFactorEnabled")
$$;
REVOKE ALL ON FUNCTION domain.account_enabled(text),domain.responsible_account_enabled(text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
CREATE OR REPLACE FUNCTION domain.lock_active_account() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM auth.account_lifecycle WHERE account_id=nullif(current_setting('quenda.account_id',true),'')
 AND deactivated_at IS NULL AND suspended_at IS NULL FOR SHARE)
$$;

CREATE OR REPLACE FUNCTION auth.guard_active_account_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text;
BEGIN
 IF TG_TABLE_NAME='user' THEN subject:=NEW.id; ELSE subject:=NEW."userId"; END IF;
 -- Only the separate maintenance login can repair credentials of an inactive
 -- identity after external verification; HTTP credentials cannot use this path.
 IF session_user='quenda_migrator' AND TG_TABLE_NAME IN ('account','twoFactor') THEN
  UPDATE auth.account_lifecycle SET session_generation=session_generation+1 WHERE account_id=subject;
  RETURN NEW;
 END IF;
 -- Every authentication mutation advances the lifecycle row. A SERIALIZABLE
 -- consumer with an older password/session/MFA snapshot must retry.
 UPDATE auth.account_lifecycle SET session_generation=session_generation+1
 WHERE account_id=subject AND deactivated_at IS NULL AND suspended_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account inactive' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='user' THEN
 IF OLD."twoFactorEnabled" AND NOT coalesce(NEW."twoFactorEnabled",false)
 AND (EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=subject AND revoked_at IS NULL)
   OR EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE account_id=subject AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()))
   OR EXISTS(SELECT 1 FROM domain.manager_grant g JOIN domain.manager_invitation i ON i.tenant_id=g.tenant_id AND i.id=g.invitation_id
       WHERE g.account_id=subject AND g.revoked_at IS NULL AND (i.role_expires_at IS NULL OR i.role_expires_at>clock_timestamp()))) THEN
  RAISE EXCEPTION 'Administrative authority requires MFA' USING ERRCODE='42501';
 END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION domain.guard_reservation_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.status='CONFIRMADA' AND NEW.ends_at>clock_timestamp() THEN
  -- Security suspension does not cancel reservations or prevent municipal
  -- interventions. Voluntary deactivation cannot coexist with active bookings.
  PERFORM 1 FROM auth.account_lifecycle WHERE account_id=NEW.account_id AND deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation holder inactive' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP INDEX domain.reservation_account_future_confirmed;
CREATE INDEX reservation_account_future_confirmed ON domain.reservation(account_id,ends_at) WHERE status='CONFIRMADA';

CREATE TABLE auth.account_deactivation_proof (
 token_digest text PRIMARY KEY CHECK(length(token_digest)=64),
 account_id text NOT NULL REFERENCES auth."user"(id),
 session_id text NOT NULL,
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE INDEX deactivation_proof_expiry ON auth.account_deactivation_proof(expires_at);
ALTER TABLE auth.account_deactivation_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_deactivation_proof FORCE ROW LEVEL SECURITY;
CREATE POLICY deactivation_proof_maintenance ON auth.account_deactivation_proof TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.account_deactivation_proof FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE FUNCTION auth.issue_deactivation_proof(subject text,session_id text,credential_hash text,digest text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE instant timestamptz:=clock_timestamp();
BEGIN
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject AND deactivated_at IS NULL AND suspended_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.session s WHERE s.id=session_id AND s."userId"=subject AND s."expiresAt">instant)
 OR NOT EXISTS(SELECT 1 FROM auth.account a WHERE a."userId"=subject AND a."providerId"='credential' AND a.password=credential_hash)
 THEN RETURN false; END IF;
 DELETE FROM auth.account_deactivation_proof WHERE token_digest IN (SELECT token_digest FROM auth.account_deactivation_proof WHERE expires_at<=instant ORDER BY expires_at LIMIT 100);
 INSERT INTO auth.account_deactivation_proof(token_digest,account_id,session_id,password_hash,expires_at)
 VALUES(digest,subject,session_id,credential_hash,instant+interval '5 minutes');
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION auth.issue_deactivation_proof(text,text,text,text) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.issue_deactivation_proof(text,text,text,text) TO quenda_auth;

-- Owner-only helper: invalidating the issuer's unaccepted invitations never
-- revokes permissions that another account has already accepted.
CREATE FUNCTION domain.invalidate_account_authority(subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE instant timestamptz:=clock_timestamp();
BEGIN
 UPDATE domain.platform_operator SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.municipal_administrator SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.manager_grant SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.administrator_invitation SET revoked_at=instant WHERE (account_id=subject OR invited_by=subject) AND accepted_at IS NULL AND revoked_at IS NULL;
 UPDATE domain.manager_invitation SET revoked_at=instant WHERE (account_id=subject OR invited_by=subject) AND accepted_at IS NULL AND revoked_at IS NULL;
 DELETE FROM auth.account_deactivation_proof WHERE account_id=subject;
END $$;
REVOKE ALL ON FUNCTION domain.invalidate_account_authority(text) FROM PUBLIC,quenda_domain,quenda_auth,quenda_worker;
DROP FUNCTION domain.deactivate_current_account(uuid);
CREATE FUNCTION domain.deactivate_current_account(correlation uuid,proof_digest text)
RETURNS TABLE(outcome text,deactivated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text:=nullif(current_setting('quenda.account_id',true),'');
 instant timestamptz; removed integer; proof auth.account_deactivation_proof; mfa boolean;
BEGIN
 IF subject IS NULL OR correlation IS NULL OR current_setting('transaction_isolation')<>'serializable'
 OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL THEN
  RAISE EXCEPTION 'Serializable account context required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject AND auth.account_lifecycle.deactivated_at IS NULL AND suspended_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'INACTIVE'::text,NULL::timestamptz; RETURN; END IF;
 instant:=clock_timestamp();
 SELECT * INTO proof FROM auth.account_deactivation_proof WHERE token_digest=proof_digest AND account_id=subject AND consumed_at IS NULL AND expires_at>instant FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.account WHERE "userId"=subject AND "providerId"='credential' AND password=proof.password_hash)
 OR NOT EXISTS(SELECT 1 FROM auth.session WHERE id=proof.session_id AND "userId"=subject AND "expiresAt">instant)
 THEN RETURN QUERY SELECT 'PROOF_REQUIRED'::text,NULL::timestamptz; RETURN; END IF;
 SELECT "twoFactorEnabled" INTO mfa FROM auth."user" WHERE id=subject;
 IF mfa AND NOT EXISTS(SELECT 1 FROM auth.session WHERE id=proof.session_id AND "mfaVerifiedAt">instant-interval '5 minutes' AND "mfaVerifiedAt"<=instant)
 THEN RETURN QUERY SELECT 'MFA_REQUIRED'::text,NULL::timestamptz; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM domain.reservation WHERE account_id=subject AND status='CONFIRMADA' AND ends_at>instant)
 THEN RETURN QUERY SELECT 'FUTURE_RESERVATIONS'::text,NULL::timestamptz; RETURN; END IF;
 IF (EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=subject AND revoked_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id<>subject AND revoked_at IS NULL AND domain.responsible_account_enabled(account_id)))
 OR EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.account_id=subject AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>instant)
 AND NOT EXISTS(SELECT 1 FROM domain.municipal_administrator other WHERE other.tenant_id=a.tenant_id AND other.account_id<>subject
  AND other.revoked_at IS NULL AND other.expires_at IS NULL AND domain.responsible_account_enabled(other.account_id)))
 THEN RETURN QUERY SELECT 'HANDOVER_REQUIRED'::text,NULL::timestamptz; RETURN; END IF;
 UPDATE auth.account_lifecycle SET deactivated_at=instant WHERE account_id=subject;
 PERFORM domain.invalidate_account_authority(subject);
 DELETE FROM auth.session WHERE "userId"=subject;
 GET DIAGNOSTICS removed=ROW_COUNT;
 INSERT INTO auth.account_deactivation_event(subject_id,occurred_at,correlation_id,revoked_sessions) VALUES(subject,instant,correlation,removed);
 RETURN QUERY SELECT 'DEACTIVATED'::text,instant;
END $$;
REVOKE ALL ON FUNCTION domain.deactivate_current_account(uuid,text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.deactivate_current_account(uuid,text) TO quenda_domain;

CREATE TABLE auth.account_security_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject_id text NOT NULL REFERENCES auth."user"(id),
 actor_id text REFERENCES auth."user"(id),operational_actor text,
 operation text NOT NULL CHECK(operation IN ('SUSPEND_ACCOUNT','RECOVER_ACCOUNT')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 identity_reference text,remediation_reference text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),correlation_id uuid NOT NULL,
 revoked_sessions integer NOT NULL DEFAULT 0 CHECK(revoked_sessions>=0),
 CHECK((actor_id IS NOT NULL)<>(operational_actor IS NOT NULL))
);
ALTER TABLE auth.account_security_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.account_security_event FORCE ROW LEVEL SECURITY;
CREATE POLICY security_event_maintenance ON auth.account_security_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.account_security_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE FUNCTION domain.suspend_account(subject text,rationale text,correlation uuid) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE instant timestamptz; previous timestamptz; removed integer;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL OR NOT domain.lock_current_operator()
 THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 OR correlation IS NULL THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 SELECT suspended_at INTO previous FROM auth.account_lifecycle WHERE account_id=subject FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF previous IS NOT NULL THEN RETURN previous; END IF;
 instant:=clock_timestamp();
 UPDATE auth.account_lifecycle SET suspended_at=instant,
 suspended_password_fingerprint=(SELECT encode(sha256(convert_to(password,'UTF8')),'hex') FROM auth.account WHERE "userId"=subject AND "providerId"='credential' LIMIT 1),
 suspended_mfa_fingerprint=(SELECT encode(sha256(convert_to(secret,'UTF8')),'hex') FROM auth."twoFactor" WHERE "userId"=subject LIMIT 1),
 suspended_backup_fingerprint=(SELECT encode(sha256(convert_to("backupCodes",'UTF8')),'hex') FROM auth."twoFactor" WHERE "userId"=subject LIMIT 1)
 WHERE account_id=subject;
 PERFORM domain.invalidate_account_authority(subject);
 DELETE FROM auth.session WHERE "userId"=subject;
 GET DIAGNOSTICS removed=ROW_COUNT;
 INSERT INTO auth.account_security_event(subject_id,actor_id,operation,reason,correlation_id,revoked_sessions)
 VALUES(subject,nullif(current_setting('quenda.account_id',true),''),'SUSPEND_ACCOUNT',btrim(rationale),correlation,removed);
 RETURN instant;
END $$;
REVOKE ALL ON FUNCTION domain.suspend_account(text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.suspend_account(text,text,uuid) TO quenda_domain;

-- The maintenance credential and independent identity/remediation evidence are
-- mandatory. Neither HTTP role can release a suspension or perform this recovery.
CREATE FUNCTION auth.recover_account(subject text,performer text,identity_ref text,remediation_ref text,rationale text,correlation uuid)
RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item auth.account_lifecycle; instant timestamptz:=clock_timestamp();
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION 'Serializable recovery required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[performer,identity_ref,remediation_ref,rationale]) v WHERE v IS NULL OR length(btrim(v)) NOT BETWEEN 1 AND 500)
 OR correlation IS NULL THEN RAISE EXCEPTION 'Verified recovery evidence required' USING ERRCODE='22023'; END IF;
 SELECT * INTO item FROM auth.account_lifecycle WHERE account_id=subject FOR UPDATE;
 IF NOT FOUND OR (item.deactivated_at IS NULL AND item.suspended_at IS NULL) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth."user" WHERE id=subject AND "emailVerified") THEN RAISE EXCEPTION 'Verified identity required' USING ERRCODE='42501'; END IF;
 IF item.suspended_at IS NOT NULL AND (
   NOT EXISTS(SELECT 1 FROM auth.account WHERE "userId"=subject AND "providerId"='credential' AND password IS NOT NULL AND encode(sha256(convert_to(password,'UTF8')),'hex') IS DISTINCT FROM item.suspended_password_fingerprint)
   OR (item.suspended_mfa_fingerprint IS NOT NULL AND NOT EXISTS(SELECT 1 FROM auth."twoFactor" WHERE "userId"=subject AND encode(sha256(convert_to(secret,'UTF8')),'hex') IS DISTINCT FROM item.suspended_mfa_fingerprint AND encode(sha256(convert_to("backupCodes",'UTF8')),'hex') IS DISTINCT FROM item.suspended_backup_fingerprint AND verified)))
 THEN RAISE EXCEPTION 'Replace compromised credentials before recovery' USING ERRCODE='42501'; END IF;
 PERFORM domain.invalidate_account_authority(subject);
 DELETE FROM auth.session WHERE "userId"=subject;
 UPDATE auth.account_lifecycle SET suspended_at=NULL,suspended_password_fingerprint=NULL,suspended_mfa_fingerprint=NULL,suspended_backup_fingerprint=NULL,
 deactivated_at=NULL,session_generation=session_generation+1 WHERE account_id=subject;
 INSERT INTO auth.account_security_event(subject_id,operational_actor,operation,reason,identity_reference,remediation_reference,correlation_id)
 VALUES(subject,btrim(performer),'RECOVER_ACCOUNT',btrim(rationale),btrim(identity_ref),btrim(remediation_ref),correlation);
 RETURN instant;
END $$;
REVOKE ALL ON FUNCTION auth.recover_account(text,text,text,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.account_has_administrative_authority(subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM domain.platform_operator WHERE account_id=subject AND revoked_at IS NULL)
 OR EXISTS(SELECT 1 FROM domain.municipal_administrator WHERE account_id=subject AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()))
 OR EXISTS(SELECT 1 FROM domain.manager_grant g JOIN domain.manager_invitation i ON i.tenant_id=g.tenant_id AND i.id=g.invitation_id
 WHERE g.account_id=subject AND g.revoked_at IS NULL AND (i.role_expires_at IS NULL OR i.role_expires_at>clock_timestamp()))
$$;
REVOKE ALL ON FUNCTION auth.account_has_administrative_authority(text) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.account_has_administrative_authority(text) TO quenda_auth;

-- Accounts deactivated before this migration retained grants as historical
-- rows. Make their withdrawal explicit before enabling any reactivation path.
SELECT domain.invalidate_account_authority(account_id) FROM auth.account_lifecycle WHERE deactivated_at IS NOT NULL;
