-- Withdrawals of invitations addressed to an email that nobody accepted.
--
-- * A security withdrawal of an account (0125) and the suspension or
--   deactivation of a global account (0126) also revoke pending invitations
--   sent to the account's verified address. Those revocations named the
--   account (identity_event.subject_id, global_privacy_permission_event
--   .actor_id) although it never accepted the invitation. No retention set
--   covers such a row: the account's AUTHORITY set only follows invitations
--   bound to it, and address:<kind>:<id> only clears the address. The row kept
--   an address-to-account link indefinitely.
--   The revocation is now recorded on the invitation, with actor and reason,
--   without naming the account behind the address, as a withdrawal by address
--   (0127) already does. Existing rows lose that account reference. Withdrawals
--   that touch the account's own grants and invitations still name it.
-- * Withdrawal by address revoked invitations whose acceptance deadline, or
--   role, had already passed: the answer was 200 instead of 404 and the
--   revocation moved the address retention anchor later. Only invitations that
--   could still be accepted are revoked now, here and in the address branch of
--   the account withdrawal.
-- * Invitations issued by a platform operator (initial administrator, its
--   replacement and recovery substitutes) count against the platform notice
--   allowance instead of the municipality's, so municipal staff cannot spend
--   the allowance a recovery relies on.

ALTER TABLE domain.global_privacy_permission_event ALTER COLUMN actor_id DROP NOT NULL,
 ADD CONSTRAINT global_privacy_permission_event_actor CHECK(actor_id IS NOT NULL OR operation='ACCOUNT_WITHDRAWAL');

UPDATE domain.identity_event e SET subject_id=NULL
 FROM domain.administrator_invitation i
 WHERE e.operation='REVOKE_INVITATION' AND e.subject_id IS NOT NULL
  AND (i.tenant_id,i.id)=(e.tenant_id,e.invitation_id) AND i.account_id IS NULL;
UPDATE domain.global_privacy_permission_event e SET actor_id=NULL
 FROM domain.global_privacy_invitation i
 WHERE e.operation='ACCOUNT_WITHDRAWAL' AND e.actor_id IS NOT NULL AND i.id=e.invitation_id
  AND i.account_id IS NULL AND e.actor_id<>i.invited_by;

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
 -- The account never accepted these invitations: the event stays on the
 -- invitation and does not record which account used the address.
 IF address IS NOT NULL THEN
  WITH revoked AS (
   UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
  ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
   SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',NULL,id,rationale FROM revoked;
  affected:=affected OR FOUND;
  WITH revoked AS (
   UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
  ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
   SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',rationale FROM revoked;
  affected:=affected OR FOUND;
 END IF;
 RETURN affected;
END $$;

CREATE OR REPLACE FUNCTION domain.revoke_address_invitations_for_security(recipient text,rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE address text:=lower(btrim(recipient));
DECLARE affected boolean:=false;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF address IS NULL OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
   AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',NULL,id,btrim(rationale) FROM revoked;
 affected:=FOUND;
 WITH revoked AS (
  UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
   AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) RETURNING id
 ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
  SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',btrim(rationale) FROM revoked;
 RETURN affected OR FOUND;
END $$;

-- The withdrawn account remains the actor of withdrawals of invitations bound
-- to it or issued by it. An invitation only addressed to its email records the
-- withdrawal without an actor.
CREATE OR REPLACE FUNCTION domain.invalidate_global_privacy_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE address text;
BEGIN
 IF (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL) OR (NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL) THEN
  address:=(SELECT lower(btrim(email)) FROM auth."user" WHERE id=NEW.account_id AND "emailVerified");
  WITH withdrawn AS (
   UPDATE domain.global_privacy_invitation SET revoked_at=clock_timestamp()
    WHERE revoked_at IS NULL AND (account_id=NEW.account_id OR (invited_by=NEW.account_id AND accepted_at IS NULL)
     OR (account_id IS NULL AND recipient_email=address AND accepted_at IS NULL)) RETURNING id,account_id,invited_by
  ) INSERT INTO domain.global_privacy_permission_event(invitation_id,actor_id,operation)
    SELECT id,CASE WHEN account_id=NEW.account_id OR invited_by=NEW.account_id THEN NEW.account_id END,'ACCOUNT_WITHDRAWAL' FROM withdrawn;
 END IF;
 RETURN NULL;
END $$;

-- The allowance follows the issuing authority: a municipality's own
-- administrators use the municipal one, platform operators the platform one.
CREATE OR REPLACE FUNCTION domain.queue_invitation_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE category text:=TG_ARGV[0];
DECLARE tenant uuid;
DECLARE quota_scope text:='platform';
DECLARE instant timestamptz:=clock_timestamp();
DECLARE queued integer;
BEGIN
 IF NEW.account_id IS NOT NULL OR NEW.recipient_email IS NULL OR NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN RETURN NULL; END IF;
 IF category IN ('ADMINISTRATOR','MANAGER') THEN
  tenant:=(to_jsonb(NEW)->>'tenant_id')::uuid;
  IF category='MANAGER' OR to_jsonb(NEW)->>'grant_source'='MUNICIPAL' THEN quota_scope:=tenant::text; END IF;
 END IF;
 INSERT INTO domain.invitation_email_quota AS q(scope,window_started_at,queued) VALUES(quota_scope,instant,1)
 ON CONFLICT(scope) DO UPDATE SET
  window_started_at=CASE WHEN q.window_started_at+interval '24 hours'<=instant THEN instant ELSE q.window_started_at END,
  queued=CASE WHEN q.window_started_at+interval '24 hours'<=instant THEN 1 ELSE least(q.queued+1,101) END
 RETURNING q.queued INTO queued;
 IF queued>100 THEN RETURN NULL; END IF;
 INSERT INTO domain.invitation_email(kind,tenant_id,invitation_id,recipient_email) VALUES(category,tenant,NEW.id,NEW.recipient_email);
 RETURN NULL;
END $$;
