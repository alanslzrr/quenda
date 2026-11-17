-- Invitations that grant municipal authority (administrator, manager, the
-- initial administrator of a new municipality and recovery substitutes) are
-- addressed to an email address instead of an account identifier.
--
-- * recipient_email holds the normalised address (trimmed, lower case). A new
--   invitation has no account_id: nothing is looked up when it is created, so
--   the response never depends on whether an account uses that address.
-- * Only the account whose current verified email equals the address can read
--   or accept it. The address is checked again at acceptance, so the
--   invitation follows the address, not the account that held it when it was
--   sent.
-- * Acceptance binds account_id to the accepting account and clears the
--   address: from then on the grant, its history and retention follow the
--   account, as before.
-- * Rows created before this migration keep account_id and no address. They
--   stay valid and are still addressed to that account. A manager scope
--   replacement keeps addressing the current holder of the replaced grant.
-- * An address of an invitation that ended without acceptance is withdrawn by
--   the AUTHORITY retention policy under the key address:<kind>:<invitation>.

ALTER TABLE domain.administrator_invitation ALTER COLUMN account_id DROP NOT NULL,
 ADD COLUMN recipient_email text,
 ADD CONSTRAINT administrator_invitation_recipient_email CHECK(recipient_email IS NULL OR (
  recipient_email=lower(btrim(recipient_email)) AND length(recipient_email) BETWEEN 3 AND 320
  AND recipient_email ~ '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+$')),
 ADD CONSTRAINT administrator_invitation_accepted_account CHECK(accepted_at IS NULL OR account_id IS NOT NULL);
ALTER TABLE domain.manager_invitation ALTER COLUMN account_id DROP NOT NULL,
 ADD COLUMN recipient_email text,
 ADD CONSTRAINT manager_invitation_recipient_email CHECK(recipient_email IS NULL OR (
  recipient_email=lower(btrim(recipient_email)) AND length(recipient_email) BETWEEN 3 AND 320
  AND recipient_email ~ '^[^[:space:]@<>,;]+@[^[:space:]@<>,;]+$')),
 ADD CONSTRAINT manager_invitation_accepted_account CHECK(accepted_at IS NULL OR account_id IS NOT NULL);
CREATE INDEX administrator_invitation_address ON domain.administrator_invitation(recipient_email,id) WHERE account_id IS NULL;
CREATE INDEX manager_invitation_address ON domain.manager_invitation(recipient_email,id) WHERE account_id IS NULL;

-- Inviting, replacing and revoking an address-only invitation has no account
-- subject yet; the invitation row carries the address.
ALTER TABLE domain.identity_event ALTER COLUMN subject_id DROP NOT NULL,
 ADD CONSTRAINT identity_event_invitation_subject CHECK(subject_id IS NOT NULL
  OR operation IN ('CREATE_MUNICIPALITY','INVITE_ADMINISTRATOR','REVOKE_INVITATION','RECOVER_ADMINISTRATOR'));

CREATE FUNCTION domain.current_verified_email() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT lower(btrim(u.email)) FROM auth."user" u
 WHERE u.id=nullif(current_setting('quenda.account_id',true),'') AND u."emailVerified"
$$;
CREATE FUNCTION domain.invitation_addressed_to_current(account text,address text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce(CASE WHEN account IS NOT NULL THEN account=nullif(current_setting('quenda.account_id',true),'')
  ELSE address=domain.current_verified_email() END,false)
$$;
REVOKE ALL ON FUNCTION domain.current_verified_email(),domain.invitation_addressed_to_current(text,text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.current_verified_email(),domain.invitation_addressed_to_current(text,text) TO quenda_domain;

ALTER POLICY invitation_read ON domain.administrator_invitation
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND (domain.invitation_addressed_to_current(account_id,recipient_email) OR domain.current_is_administrator()
   OR invited_by=nullif(current_setting('quenda.account_id',true),'')));
ALTER POLICY invitation_accept ON domain.administrator_invitation
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND domain.invitation_addressed_to_current(account_id,recipient_email)
  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now())
 WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND account_id=nullif(current_setting('quenda.account_id',true),'')
  AND accepted_at IS NOT NULL AND revoked_at IS NULL);
-- New administrator invitations written directly by the domain role are
-- always addressed by email.
ALTER POLICY invitation_create ON domain.administrator_invitation
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND invited_by=nullif(current_setting('quenda.account_id',true),'')
  AND account_id IS NULL AND recipient_email IS NOT NULL
  AND accepted_at IS NULL AND revoked_at IS NULL
  AND ((grant_source='PLATFORM' AND domain.lock_current_operator() AND domain.municipality_bootstrap_open())
   OR (grant_source='MUNICIPAL' AND domain.lock_current_administrator()
    AND domain.administrator_role_within_issuer(role_expires_at))));
ALTER POLICY manager_invitation_read ON domain.manager_invitation
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
  AND (domain.invitation_addressed_to_current(account_id,recipient_email) OR domain.current_is_administrator()));

CREATE OR REPLACE FUNCTION domain.lock_invitation_authority(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE item domain.administrator_invitation;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 -- Lock the accepting identity first: its verified email cannot change while
 -- the address is compared and the grant is written.
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=actor AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.administrator_invitation
  WHERE tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND id=invitation
   AND domain.invitation_addressed_to_current(account_id,recipient_email);
 IF NOT FOUND THEN RETURN false; END IF;
 -- A recovery never restores authority to the operator who issued it, even
 -- if that operator later verifies the invited address.
 IF item.grant_source='RECOVERY' AND item.invited_by=actor THEN RETURN false; END IF;
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
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR NOT domain.lock_invitation_authority(invitation) THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.administrator_invitation
  WHERE tenant_id=tenant AND id=invitation AND domain.invitation_addressed_to_current(account_id,recipient_email)
   AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now())
   AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.role_expires_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a
  WHERE a.tenant_id=tenant AND a.revoked_at IS NULL AND a.expires_at IS NULL
   AND domain.responsible_account_enabled(a.account_id)) THEN
  RAISE EXCEPTION 'HANDOVER_REQUIRED' USING ERRCODE='P0001';
 END IF;
 INSERT INTO domain.municipal_administrator AS existing(tenant_id,account_id,invitation_id,expires_at)
  VALUES(tenant,actor,item.id,item.role_expires_at)
  ON CONFLICT(tenant_id,account_id) DO UPDATE SET revoked_at=NULL,granted_at=now(),invitation_id=item.id,expires_at=item.role_expires_at
   WHERE (existing.revoked_at IS NOT NULL AND item.created_at>existing.revoked_at)
    OR (existing.revoked_at IS NULL AND existing.expires_at<=now() AND item.created_at>existing.expires_at);
 IF NOT FOUND THEN RETURN false; END IF;
 -- The caller records accepted_at under the acceptance policy, which now sees
 -- the invitation bound to the accepting account.
 UPDATE domain.administrator_invitation SET account_id=actor,recipient_email=NULL
  WHERE tenant_id=tenant AND id=invitation AND account_id IS NULL;
 RETURN true;
END $$;

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
   WHEN i.grant_source='RECOVERY' AND i.invited_by=nullif(current_setting('quenda.account_id',true),'') THEN 'INVALIDATED'
   ELSE 'PENDING' END,i.role_expires_at
 FROM domain.administrator_invitation i JOIN domain.municipality m ON m.id=i.tenant_id
 WHERE (i.account_id=nullif(current_setting('quenda.account_id',true),'')
   OR (i.account_id IS NULL AND i.recipient_email=domain.current_verified_email()))
  AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;

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
   (SELECT jsonb_agg(jsonb_build_object('operation',p.operation,'unitId',p.unit_id,'unitName',u.name) ORDER BY p.operation,p.unit_id)
     FROM domain.manager_permission p LEFT JOIN domain.reservable_unit u ON (u.tenant_id,u.id)=(p.tenant_id,p.unit_id)
     WHERE p.tenant_id=i.tenant_id AND p.invitation_id=i.id),i.replaces_invitation_id
 FROM domain.manager_invitation i JOIN domain.municipality m ON m.id=i.tenant_id
 LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id)
 WHERE (i.account_id=nullif(current_setting('quenda.account_id',true),'')
   OR (i.account_id IS NULL AND i.recipient_email=domain.current_verified_email()))
  AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;

-- recipient is the address of a new invitation. A scope replacement has no
-- recipient: it is addressed to the current holder of the replaced grant.
DROP FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb,uuid,text);
CREATE FUNCTION domain.invite_manager(invitation uuid,recipient text,expiry timestamptz,role_expiry timestamptz,permissions jsonb,replaces uuid DEFAULT NULL,rationale text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE issuer uuid;
DECLARE holder text;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF permissions IS NULL OR jsonb_typeof(permissions)<>'array' OR jsonb_array_length(permissions) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid scope' USING ERRCODE='22023'; END IF;
 IF replaces IS NOT NULL THEN
   IF recipient IS NOT NULL THEN RAISE EXCEPTION 'A replacement keeps its holder' USING ERRCODE='22023'; END IF;
   IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
   SELECT account_id INTO holder FROM domain.manager_grant WHERE tenant_id=tenant AND invitation_id=replaces AND revoked_at IS NULL FOR SHARE;
   IF NOT FOUND THEN RETURN false; END IF;
 ELSIF recipient IS NULL THEN
   RAISE EXCEPTION 'Recipient required' USING ERRCODE='22023';
 END IF;
 SELECT invitation_id INTO issuer FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=actor;
 INSERT INTO domain.manager_invitation(tenant_id,id,account_id,recipient_email,invited_by,issuer_invitation_id,expires_at,role_expires_at,replaces_invitation_id)
 VALUES(tenant,invitation,holder,lower(btrim(recipient)),actor,issuer,expiry,role_expiry,replaces);
 INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id)
 SELECT tenant,invitation,p.operation,p."unitId" FROM jsonb_to_recordset(permissions) AS p(operation text,"unitId" uuid);
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason,previous_invitation_id) VALUES(tenant,gen_random_uuid(),invitation,actor,'INVITE_MANAGER',rationale,replaces);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb,uuid,text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb,uuid,text) TO quenda_domain;

CREATE OR REPLACE FUNCTION domain.accept_manager(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE item domain.manager_invitation;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 -- The identity lock also keeps the verified email stable until commit.
 PERFORM 1 FROM auth.account_lifecycle l JOIN auth."user" u ON u.id=l.account_id
  WHERE l.account_id=actor AND domain.responsible_account_enabled(l.account_id) FOR SHARE OF l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation
  AND domain.invitation_addressed_to_current(account_id,recipient_email);
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM domain.municipal_administrator a JOIN auth.account_lifecycle l ON l.account_id=a.account_id JOIN auth."user" u ON u.id=a.account_id
  WHERE a.tenant_id=tenant AND a.account_id=item.invited_by AND a.invitation_id=item.issuer_invitation_id
   AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(a.account_id) FOR SHARE OF a,l,u;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation
  AND domain.invitation_addressed_to_current(account_id,recipient_email)
  AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.replaces_invitation_id IS NOT NULL THEN
  PERFORM 1 FROM domain.manager_grant WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id AND account_id=actor AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES(tenant,actor) ON CONFLICT DO NOTHING;
 INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES(tenant,invitation,actor);
 UPDATE domain.manager_invitation SET accepted_at=now(),account_id=actor,recipient_email=NULL WHERE tenant_id=tenant AND id=invitation;
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation) VALUES(tenant,gen_random_uuid(),invitation,actor,'ACCEPT_MANAGER');
 IF item.replaces_invitation_id IS NOT NULL THEN
  UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id;
  INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,previous_invitation_id)
   VALUES(tenant,gen_random_uuid(),invitation,actor,'REPLACE_MANAGER',item.replaces_invitation_id);
 END IF;
 RETURN true;
END $$;

DROP FUNCTION domain.replace_initial_invitation(text,timestamptz,text,uuid);
CREATE FUNCTION domain.replace_initial_invitation(recipient text,expiry timestamptz,rationale text,invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF NOT domain.lock_current_operator() THEN RETURN false; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR NOT domain.municipality_bootstrap_open() THEN RETURN false; END IF;
 IF recipient IS NULL OR expiry IS NULL OR expiry<=now() OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Invalid initial invitation' USING ERRCODE='22023';
 END IF;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now()
  WHERE tenant_id=tenant AND grant_source='PLATFORM' AND accepted_at IS NULL AND revoked_at IS NULL
  RETURNING id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
 INSERT INTO domain.administrator_invitation(tenant_id,id,recipient_email,invited_by,expires_at,grant_source)
  VALUES(tenant,invitation,lower(btrim(recipient)),actor,expiry,'PLATFORM');
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  VALUES(tenant,gen_random_uuid(),actor,'INVITE_ADMINISTRATOR',NULL,invitation,rationale);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.replace_initial_invitation(text,timestamptz,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.replace_initial_invitation(text,timestamptz,text,uuid) TO quenda_domain;

-- The recipient is not looked up: a disabled or missing account simply cannot
-- accept. The operator's own address is rejected because acceptance by the
-- issuing operator is refused anyway.
DROP FUNCTION domain.recover_municipal_administrator(text,timestamptz,text,text,uuid);
CREATE FUNCTION domain.recover_municipal_administrator(recipient text,expiry timestamptz,rationale text,verification text,invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Serializable administrative command required' USING ERRCODE='42501';
 END IF;
 IF NOT domain.lock_current_operator() THEN RETURN false; END IF;
 IF recipient IS NULL OR EXISTS(SELECT 1 FROM auth."user" WHERE id=actor AND lower(btrim(email))=lower(btrim(recipient))) THEN
  RAISE EXCEPTION 'Different recovery recipient required' USING ERRCODE='22023';
 END IF;
 IF expiry IS NULL OR expiry<=now() OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500
  OR verification IS NULL OR length(btrim(verification)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid recovery' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR domain.municipality_bootstrap_open() THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=tenant AND a.revoked_at IS NULL
  AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(a.account_id)) THEN RETURN false; END IF;
 WITH revoked AS (
  UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND grant_source='RECOVERY'
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id,account_id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
 INSERT INTO domain.administrator_invitation(tenant_id,id,recipient_email,invited_by,expires_at,grant_source)
  VALUES(tenant,invitation,lower(btrim(recipient)),actor,expiry,'RECOVERY');
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason,verification_reference)
  VALUES(tenant,gen_random_uuid(),actor,'RECOVER_ADMINISTRATOR',NULL,invitation,rationale,verification);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.recover_municipal_administrator(text,timestamptz,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.recover_municipal_administrator(text,timestamptz,text,text,uuid) TO quenda_domain;

-- The revocation event is written here because an address-only invitation has
-- no subject for the caller to report.
DROP FUNCTION domain.revoke_administrator_invitation(uuid);
CREATE FUNCTION domain.revoke_administrator_invitation(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE subject text;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 UPDATE domain.administrator_invitation SET revoked_at=now()
  WHERE tenant_id=tenant AND id=invitation AND accepted_at IS NULL AND revoked_at IS NULL RETURNING account_id INTO subject;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id)
  VALUES(tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',subject,invitation);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION domain.revoke_administrator_invitation(uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.revoke_administrator_invitation(uuid) TO quenda_domain;

-- Withdrawing an account for security also withdraws pending invitations sent
-- to its current verified address, so the account cannot accept them later,
-- even when it has no other tie with the municipality.
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
 IF address IS NOT NULL THEN
  WITH revoked AS (
   UPDATE domain.administrator_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
  ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
   SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',subject,id,rationale FROM revoked;
  affected:=affected OR FOUND;
  WITH revoked AS (
   UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
    AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
  ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
   SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',rationale FROM revoked;
  affected:=affected OR FOUND;
 END IF;
 RETURN affected;
END $$;

-- Deactivation and suspension withdraw pending invitations sent to the
-- account's verified address as well as those bound to the account.
CREATE OR REPLACE FUNCTION domain.invalidate_account_authority(subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE instant timestamptz:=clock_timestamp();
DECLARE address text:=(SELECT lower(btrim(email)) FROM auth."user" WHERE id=subject AND "emailVerified");
BEGIN
 UPDATE domain.platform_operator SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.municipal_administrator SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.manager_grant SET revoked_at=instant WHERE account_id=subject AND revoked_at IS NULL;
 UPDATE domain.administrator_invitation SET revoked_at=instant
  WHERE (account_id=subject OR invited_by=subject OR (account_id IS NULL AND recipient_email=address)) AND accepted_at IS NULL AND revoked_at IS NULL;
 UPDATE domain.manager_invitation SET revoked_at=instant
  WHERE (account_id=subject OR invited_by=subject OR (account_id IS NULL AND recipient_email=address)) AND accepted_at IS NULL AND revoked_at IS NULL;
 DELETE FROM auth.account_deactivation_proof WHERE account_id=subject;
END $$;

-- An unaccepted address-only invitation is retained under its own AUTHORITY
-- key, anchored at its revocation or expiry. Withdrawal archives the row and
-- clears the address; the invitation and its events stay as history.
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
  IF scope_tenant IS NULL THEN RETURN NULL; END IF;
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
   UNION SELECT i.account_id FROM domain.platform_operator_invitation i WHERE scope_tenant IS NULL
   UNION SELECT i.account_id FROM domain.global_privacy_invitation i WHERE scope_tenant IS NULL
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
  -- A pending invitation is never due: its anchor is still in the future.
  IF anchor>cutoff OR anchor>=instant THEN RETURN jsonb_build_object('status','CONFLICT','reason','NOT_DUE','subjectId',NULL); END IF;
  IF domain.retention_target_held(scope_tenant,category,target_key,NULL) THEN RETURN jsonb_build_object('status','CONFLICT','reason','LEGAL_HOLD','subjectId',NULL); END IF;
  UPDATE domain.administrator_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=administrator_item.id;
  UPDATE domain.manager_invitation SET recipient_email=NULL WHERE tenant_id=scope_tenant AND id=manager_item.id;
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
   'operatorEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.platform_operator_event e WHERE e.subject_id=subject),'[]'::jsonb),
   'privacyInvitations',coalesce((SELECT jsonb_agg(to_jsonb(i)) FROM domain.global_privacy_invitation i WHERE i.account_id=subject),'[]'::jsonb),
   'privacyEvents',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM domain.global_privacy_permission_event e JOIN domain.global_privacy_invitation i ON i.id=e.invitation_id WHERE i.account_id=subject),'[]'::jsonb)
  ) INTO payload;
  DELETE FROM domain.global_privacy_permission_event e USING domain.global_privacy_invitation i WHERE e.invitation_id=i.id AND i.account_id=subject;
  DELETE FROM domain.global_privacy_invitation WHERE account_id=subject;
  DELETE FROM domain.platform_operator_event WHERE subject_id=subject;
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
