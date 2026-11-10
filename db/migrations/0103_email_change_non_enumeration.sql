CREATE OR REPLACE FUNCTION auth.issue_email_change(subject text,session_key text,credential_hash text,target_email text,token_digest text,expected_generation bigint)
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
 -- Both proof steps are identical regardless of destination occupancy. Only
 -- completion, after proving control of both mailboxes, checks uniqueness.
 DELETE FROM auth.email_change_challenge WHERE id IN(SELECT id FROM auth.email_change_challenge WHERE expires_at<instant-interval '1 day' ORDER BY expires_at LIMIT 100);
 UPDATE auth.email_change_challenge SET revoked_at=instant WHERE account_id=subject AND consumed_at IS NULL AND revoked_at IS NULL;
 INSERT INTO auth.email_change_challenge(account_id,session_id,old_email,new_email,generation,password_fingerprint,source,approval_digest,expires_at)
 SELECT subject,session_key,identity_row.email,target_email,l.email_change_generation,encode(sha256(convert_to(credential_hash,'UTF8')),'hex'),'SELF_SERVICE',token_digest,instant+interval '10 minutes'
 FROM auth.account_lifecycle l WHERE l.account_id=subject RETURNING id INTO created;
 RETURN QUERY SELECT 'REQUESTED'::text,created,identity_row.email;
END $$;
