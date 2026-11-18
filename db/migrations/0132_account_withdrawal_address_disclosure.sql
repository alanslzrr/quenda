-- A security withdrawal of an account (0125, 0130) also revoked pending
-- invitations addressed to the account's verified email, and those revocations
-- alone made the withdrawal succeed. An administrator who knew an account
-- identifier but not its email could invite an address and withdraw the
-- account: a success instead of NOT_FOUND, or the invitation showing as
-- revoked, confirmed that the account used that address.
--
-- The address branch now runs only when the withdrawal already revoked a grant
-- or invitation of the account itself in this municipality. Those ties expose
-- the account's email to the municipality's administrators anyway (0089), so
-- the branch discloses nothing new. For any other account, the result and the
-- side effects no longer depend on its email: NOT_FOUND, nothing revoked.
-- Invitations addressed to an email remain revocable through the withdrawal by
-- address (0127), which never looks an account up. As in 0130, the address
-- revocations do not name the account.

CREATE OR REPLACE FUNCTION domain.revoke_municipal_access_for_security(subject text,rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE address text:=(SELECT lower(btrim(email)) FROM auth."user" WHERE id=subject AND "emailVerified");
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
 affected:=affected OR FOUND;
 -- Only an account the municipality already knows, through a grant or
 -- invitation of its own withdrawn above, also loses the invitations sent to
 -- its address; they never change the result. The account never accepted
 -- them: the event stays on the invitation and does not name the account.
 IF affected AND address IS NOT NULL THEN
  WITH revoked AS (
   UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
  ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
   SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',NULL,id,rationale FROM revoked;
  WITH revoked AS (
   UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
  ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
   SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',rationale FROM revoked;
 END IF;
 RETURN affected;
END $$;
