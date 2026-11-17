-- Security withdrawal of pending invitations addressed to an email in the
-- current municipality. The administrator names an address that its own
-- invitation history already shows; no account is looked up or returned, so
-- the result only says whether a pending invitation to that address existed.
CREATE FUNCTION domain.revoke_address_invitations_for_security(recipient text,rationale text) RETURNS boolean
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
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
 ) INSERT INTO domain.identity_event(tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
  SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',NULL,id,btrim(rationale) FROM revoked;
 affected:=FOUND;
 WITH revoked AS (
  UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND account_id IS NULL AND recipient_email=address
   AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
 ) INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason)
  SELECT tenant,gen_random_uuid(),id,actor,'REVOKE_MANAGER_INVITATION',btrim(rationale) FROM revoked;
 RETURN affected OR FOUND;
END $$;
REVOKE ALL ON FUNCTION domain.revoke_address_invitations_for_security(text,text) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.revoke_address_invitations_for_security(text,text) TO quenda_domain;

-- An operator may name the compromised account by its email instead of its
-- identifier. The exact match on the normalised address runs only after the
-- operator authority is locked, inside the same audited suspension, and an
-- unknown or ambiguous address returns the same empty result as an unknown
-- identifier. It is not a search: no partial match, listing or name lookup.
CREATE FUNCTION domain.suspend_account_by_email(recipient text,rationale text,correlation uuid)
RETURNS TABLE(account_id text,suspended_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; matches integer; instant timestamptz;
BEGIN
 IF current_setting('transaction_isolation')<>'serializable' OR nullif(current_setting('quenda.tenant_id',true),'') IS NOT NULL OR NOT domain.lock_current_operator()
 THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 OR correlation IS NULL THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 IF recipient IS NULL OR length(btrim(recipient)) NOT BETWEEN 3 AND 320 THEN RETURN; END IF;
 SELECT min(u.id),count(*) INTO subject,matches FROM auth."user" u WHERE lower(btrim(u.email))=lower(btrim(recipient));
 IF matches<>1 THEN RETURN; END IF;
 instant:=domain.suspend_account(subject,rationale,correlation);
 IF instant IS NULL THEN RETURN; END IF;
 account_id:=subject;
 suspended_at:=instant;
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION domain.suspend_account_by_email(text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.suspend_account_by_email(text,text,uuid) TO quenda_domain;
