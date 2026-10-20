-- Email control and current credentials authorize one exact global identity change.
ALTER TABLE auth.account_lifecycle ADD COLUMN email_change_generation bigint NOT NULL DEFAULT 0;
CREATE TABLE auth.email_change_challenge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id text NOT NULL REFERENCES auth."user"(id),
 session_id text,
 old_email text NOT NULL,
 new_email text NOT NULL CHECK(new_email=lower(new_email) AND length(new_email) BETWEEN 3 AND 320),
 generation bigint NOT NULL,
 password_fingerprint text NOT NULL,
 source text NOT NULL CHECK(source IN ('SELF_SERVICE','ASSISTED')),
 approval_digest text UNIQUE CHECK(approval_digest ~ '^[a-f0-9]{64}$'),
 verification_digest text UNIQUE CHECK(verification_digest ~ '^[a-f0-9]{64}$'),
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 revoked_at timestamptz,
 performed_by text,
 identity_reference text,
 reason text,
 CHECK(expires_at>created_at),
 CHECK(old_email<>new_email),
 CHECK((source='SELF_SERVICE' AND session_id IS NOT NULL AND approval_digest IS NOT NULL AND performed_by IS NULL AND identity_reference IS NULL AND reason IS NULL)
 OR (source='ASSISTED' AND session_id IS NULL AND approval_digest IS NULL AND approved_at IS NOT NULL AND performed_by IS NOT NULL AND identity_reference IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX email_change_challenge_account ON auth.email_change_challenge(account_id);
CREATE INDEX email_change_challenge_expiry ON auth.email_change_challenge(expires_at);
ALTER TABLE auth.email_change_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.email_change_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY email_change_maintenance ON auth.email_change_challenge TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY email_change_authentication ON auth.email_change_challenge TO quenda_auth USING(true);
GRANT SELECT ON auth.email_change_challenge TO quenda_auth;
REVOKE ALL ON auth.email_change_challenge FROM PUBLIC,quenda_domain,quenda_worker;

CREATE TABLE auth.email_change_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(operation IN ('ISSUE_ASSISTED','CHANGE_EMAIL')),
 source text NOT NULL CHECK(source IN ('SELF_SERVICE','ASSISTED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL UNIQUE,
 performed_by text,identity_reference text,reason text,
 revoked_sessions integer NOT NULL DEFAULT 0 CHECK(revoked_sessions>=0)
);
ALTER TABLE auth.email_change_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.email_change_event FORCE ROW LEVEL SECURITY;
CREATE POLICY email_change_event_maintenance ON auth.email_change_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.email_change_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.invalidate_email_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text;
BEGIN
 IF TG_TABLE_NAME='account_lifecycle' THEN subject:=NEW.account_id;
 ELSIF TG_TABLE_NAME='user' THEN subject:=NEW.id;
 ELSE subject:=coalesce(NEW."userId",OLD."userId"); END IF;
 UPDATE auth.account_lifecycle SET email_change_generation=email_change_generation+1 WHERE account_id=subject;
 UPDATE auth.email_change_challenge SET revoked_at=clock_timestamp()
 WHERE account_id=subject AND consumed_at IS NULL AND revoked_at IS NULL;
 RETURN coalesce(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION auth.invalidate_email_changes() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER email_change_lifecycle AFTER UPDATE OF deactivated_at,suspended_at ON auth.account_lifecycle
 FOR EACH ROW WHEN(OLD.deactivated_at IS DISTINCT FROM NEW.deactivated_at OR OLD.suspended_at IS DISTINCT FROM NEW.suspended_at)
 EXECUTE FUNCTION auth.invalidate_email_changes();
CREATE TRIGGER email_change_identity AFTER UPDATE OF email,"emailVerified","twoFactorEnabled" ON auth."user"
 FOR EACH ROW WHEN(OLD.email IS DISTINCT FROM NEW.email OR OLD."emailVerified" IS DISTINCT FROM NEW."emailVerified" OR OLD."twoFactorEnabled" IS DISTINCT FROM NEW."twoFactorEnabled")
 EXECUTE FUNCTION auth.invalidate_email_changes();
CREATE TRIGGER email_change_password AFTER UPDATE OF password ON auth.account
 FOR EACH ROW WHEN(OLD.password IS DISTINCT FROM NEW.password) EXECUTE FUNCTION auth.invalidate_email_changes();
CREATE TRIGGER email_change_factor_creation AFTER INSERT OR DELETE ON auth."twoFactor"
 FOR EACH ROW EXECUTE FUNCTION auth.invalidate_email_changes();
CREATE TRIGGER email_change_factor_material AFTER UPDATE OF secret,"backupCodes",verified ON auth."twoFactor"
 FOR EACH ROW WHEN(OLD.secret IS DISTINCT FROM NEW.secret OR OLD."backupCodes" IS DISTINCT FROM NEW."backupCodes" OR OLD.verified IS DISTINCT FROM NEW.verified)
 EXECUTE FUNCTION auth.invalidate_email_changes();

CREATE FUNCTION auth.lock_email_change_account(subject text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN RAISE EXCEPTION 'Serializable email change required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM auth.account_lifecycle WHERE account_id=subject AND deactivated_at IS NULL AND suspended_at IS NULL FOR UPDATE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION auth.lock_email_change_account(text) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.lock_email_change_account(text) TO quenda_auth;

CREATE FUNCTION auth.issue_email_change(subject text,session_key text,credential_hash text,target_email text,token_digest text,expected_generation bigint)
RETURNS TABLE(outcome text,challenge_id uuid,old_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE identity_row auth."user"; instant timestamptz; created uuid;
BEGIN
 IF NOT auth.lock_email_change_account(subject) THEN RETURN QUERY SELECT 'INACTIVE'::text,NULL::uuid,NULL::text; RETURN; END IF;
 instant:=clock_timestamp();
 SELECT * INTO identity_row FROM auth."user" WHERE id=subject AND "emailVerified";
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM auth.account_lifecycle WHERE account_id=subject AND email_change_generation=expected_generation)
 OR NOT EXISTS(SELECT 1 FROM auth.account WHERE "userId"=subject AND "providerId"='credential' AND password=credential_hash)
 OR NOT EXISTS(SELECT 1 FROM auth.session WHERE id=session_key AND "userId"=subject AND "expiresAt">instant)
 THEN RETURN QUERY SELECT 'PROOF_REQUIRED'::text,NULL::uuid,NULL::text; RETURN; END IF;
 IF identity_row."twoFactorEnabled" AND NOT EXISTS(SELECT 1 FROM auth.session WHERE id=session_key AND "mfaVerifiedAt">instant-interval '5 minutes' AND "mfaVerifiedAt"<=instant)
 THEN RETURN QUERY SELECT 'MFA_REQUIRED'::text,NULL::uuid,NULL::text; RETURN; END IF;
 IF target_email=identity_row.email THEN RETURN QUERY SELECT 'INVALID'::text,NULL::uuid,NULL::text; RETURN; END IF;
 -- Do not disclose whether another account owns the requested mailbox.
 IF EXISTS(SELECT 1 FROM auth."user" WHERE email=target_email) THEN RETURN QUERY SELECT 'REQUESTED'::text,NULL::uuid,NULL::text; RETURN; END IF;
 DELETE FROM auth.email_change_challenge WHERE id IN(SELECT id FROM auth.email_change_challenge WHERE expires_at<instant-interval '1 day' ORDER BY expires_at LIMIT 100);
 UPDATE auth.email_change_challenge SET revoked_at=instant WHERE account_id=subject AND consumed_at IS NULL AND revoked_at IS NULL;
 INSERT INTO auth.email_change_challenge(account_id,session_id,old_email,new_email,generation,password_fingerprint,source,approval_digest,expires_at)
 SELECT subject,session_key,identity_row.email,target_email,l.email_change_generation,encode(sha256(convert_to(credential_hash,'UTF8')),'hex'),'SELF_SERVICE',token_digest,instant+interval '10 minutes'
 FROM auth.account_lifecycle l WHERE l.account_id=subject RETURNING id INTO created;
 RETURN QUERY SELECT 'REQUESTED'::text,created,identity_row.email;
END $$;
REVOKE ALL ON FUNCTION auth.issue_email_change(text,text,text,text,text,bigint) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.issue_email_change(text,text,text,text,text,bigint) TO quenda_auth;

CREATE FUNCTION auth.email_change_is_current(item auth.email_change_challenge,session_key text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT item.revoked_at IS NULL AND item.consumed_at IS NULL AND item.expires_at>clock_timestamp()
 AND EXISTS(SELECT 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=item.account_id AND l.deactivated_at IS NULL AND l.suspended_at IS NULL
  AND l.email_change_generation=item.generation AND u.email=item.old_email AND u."emailVerified")
 AND EXISTS(SELECT 1 FROM auth.account a WHERE a."userId"=item.account_id AND a."providerId"='credential'
  AND encode(sha256(convert_to(a.password,'UTF8')),'hex')=item.password_fingerprint)
 AND EXISTS(SELECT 1 FROM auth.session s WHERE s.id=session_key AND s."userId"=item.account_id AND s."expiresAt">clock_timestamp())
 AND (item.source='ASSISTED' OR item.session_id=session_key)
$$;
REVOKE ALL ON FUNCTION auth.email_change_is_current(auth.email_change_challenge,text) FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.approve_email_change(subject text,session_key text,old_digest text,new_digest text)
RETURNS TABLE(challenge_id uuid,new_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item auth.email_change_challenge;
BEGIN
 IF NOT auth.lock_email_change_account(subject) THEN RETURN; END IF;
 SELECT * INTO item FROM auth.email_change_challenge WHERE account_id=subject AND approval_digest=old_digest FOR UPDATE;
 IF NOT FOUND OR item.source<>'SELF_SERVICE' OR item.approved_at IS NOT NULL OR NOT auth.email_change_is_current(item,session_key) THEN RETURN; END IF;
 UPDATE auth.email_change_challenge SET approved_at=clock_timestamp(),verification_digest=new_digest WHERE id=item.id;
 RETURN QUERY SELECT item.id,item.new_email;
END $$;
REVOKE ALL ON FUNCTION auth.approve_email_change(text,text,text,text) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.approve_email_change(text,text,text,text) TO quenda_auth;

CREATE FUNCTION auth.revoke_email_change(challenge uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE auth.email_change_challenge SET revoked_at=clock_timestamp() WHERE id=challenge AND consumed_at IS NULL AND revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION auth.revoke_email_change(uuid) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.revoke_email_change(uuid) TO quenda_auth;

CREATE FUNCTION auth.complete_email_change(subject text,session_key text,digest text,credential_hash text,correlation uuid)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item auth.email_change_challenge; instant timestamptz; removed integer;
BEGIN
 IF correlation IS NULL OR NOT auth.lock_email_change_account(subject) THEN RETURN NULL; END IF;
 SELECT * INTO item FROM auth.email_change_challenge WHERE account_id=subject AND verification_digest=digest FOR UPDATE;
 IF NOT FOUND OR item.approved_at IS NULL OR NOT auth.email_change_is_current(item,session_key) THEN RETURN NULL; END IF;
 instant:=clock_timestamp();
 IF item.source='ASSISTED' THEN
  IF credential_hash IS NULL OR encode(sha256(convert_to(credential_hash,'UTF8')),'hex')<>item.password_fingerprint THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM auth."user" WHERE id=subject AND "twoFactorEnabled")
  AND NOT EXISTS(SELECT 1 FROM auth.session WHERE id=session_key AND "mfaVerifiedAt">instant-interval '5 minutes' AND "mfaVerifiedAt"<=instant)
  THEN RAISE EXCEPTION 'MFA_REQUIRED' USING ERRCODE='P0001'; END IF;
 END IF;
 -- Unique email constraint also handles competing confirmations atomically.
 UPDATE auth.email_change_challenge SET consumed_at=instant WHERE id=item.id;
 UPDATE auth."user" SET email=item.new_email,"emailVerified"=true,"updatedAt"=instant WHERE id=subject;
 DELETE FROM auth.session WHERE "userId"=subject;
 GET DIAGNOSTICS removed=ROW_COUNT;
 DELETE FROM auth.verification WHERE value=subject;
 DELETE FROM auth.account_reactivation_challenge WHERE account_id=subject;
 DELETE FROM auth.account_deactivation_proof WHERE account_id=subject;
 INSERT INTO auth.email_change_event(account_id,operation,source,occurred_at,correlation_id,performed_by,identity_reference,reason,revoked_sessions)
 VALUES(subject,'CHANGE_EMAIL',item.source,instant,correlation,item.performed_by,item.identity_reference,item.reason,removed);
 RETURN instant;
END $$;
REVOKE ALL ON FUNCTION auth.complete_email_change(text,text,text,text,uuid) FROM PUBLIC,quenda_domain,quenda_worker;
GRANT EXECUTE ON FUNCTION auth.complete_email_change(text,text,text,text,uuid) TO quenda_auth;

CREATE FUNCTION auth.issue_assisted_email_change(subject text,target_email text,digest text,performer text,identity_ref text,rationale text,correlation uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item uuid; instant timestamptz:=clock_timestamp();
BEGIN
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[performer,identity_ref,rationale]) v WHERE v IS NULL OR length(btrim(v)) NOT BETWEEN 1 AND 500)
 OR correlation IS NULL THEN RAISE EXCEPTION 'Verified identity evidence required' USING ERRCODE='22023'; END IF;
 IF NOT auth.lock_email_change_account(subject) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM auth."user" WHERE email=target_email) THEN RAISE EXCEPTION 'Email unavailable' USING ERRCODE='23505'; END IF;
 UPDATE auth.email_change_challenge SET revoked_at=instant WHERE account_id=subject AND consumed_at IS NULL AND revoked_at IS NULL;
 INSERT INTO auth.email_change_challenge(account_id,old_email,new_email,generation,password_fingerprint,source,verification_digest,approved_at,expires_at,performed_by,identity_reference,reason)
 SELECT subject,u.email,target_email,l.email_change_generation,encode(sha256(convert_to(a.password,'UTF8')),'hex'),'ASSISTED',digest,instant,instant+interval '10 minutes',btrim(performer),btrim(identity_ref),btrim(rationale)
 FROM auth."user" u JOIN auth.account_lifecycle l ON l.account_id=u.id JOIN auth.account a ON a."userId"=u.id AND a."providerId"='credential'
 WHERE u.id=subject AND u."emailVerified" AND a.password IS NOT NULL RETURNING id INTO item;
 IF item IS NULL THEN RETURN NULL; END IF;
 INSERT INTO auth.email_change_event(account_id,operation,source,occurred_at,correlation_id,performed_by,identity_reference,reason)
 VALUES(subject,'ISSUE_ASSISTED','ASSISTED',instant,correlation,btrim(performer),btrim(identity_ref),btrim(rationale));
 RETURN item;
END $$;
REVOKE ALL ON FUNCTION auth.issue_assisted_email_change(text,text,text,text,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
