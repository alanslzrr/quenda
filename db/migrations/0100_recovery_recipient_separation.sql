CREATE OR REPLACE FUNCTION domain.recover_municipal_administrator(subject text,expiry timestamptz,rationale text,verification text,invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_operator() THEN RETURN false; END IF;
 IF subject IS NOT DISTINCT FROM actor THEN RAISE EXCEPTION 'Different recovery recipient required' USING ERRCODE='22023'; END IF;
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
