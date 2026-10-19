CREATE FUNCTION domain.municipality_bootstrap_open() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM domain.municipality WHERE id = nullif(current_setting('quenda.tenant_id', true), '')::uuid)
    AND NOT EXISTS (SELECT 1 FROM domain.municipal_administrator WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid)
$$;
REVOKE ALL ON FUNCTION domain.municipality_bootstrap_open() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.municipality_bootstrap_open() TO quenda_domain;
ALTER POLICY invitation_create ON domain.administrator_invitation
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND invited_by = nullif(current_setting('quenda.account_id', true), '')
    AND accepted_at IS NULL AND revoked_at IS NULL
    AND ((grant_source = 'PLATFORM' AND domain.lock_current_operator() AND domain.municipality_bootstrap_open())
      OR (grant_source = 'MUNICIPAL' AND domain.lock_current_administrator())));

CREATE OR REPLACE FUNCTION domain.lock_invitation_authority(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE item domain.administrator_invitation;
BEGIN
  SELECT * INTO item FROM domain.administrator_invitation
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND id = invitation
      AND account_id = nullif(current_setting('quenda.account_id', true), '');
  IF NOT FOUND THEN RETURN false; END IF;
  IF item.grant_source = 'PLATFORM' THEN
    IF NOT domain.municipality_bootstrap_open() THEN RETURN false; END IF;
    PERFORM 1 FROM domain.platform_operator WHERE account_id = item.invited_by AND revoked_at IS NULL FOR SHARE;
  ELSE
    PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id = item.tenant_id
      AND account_id = item.invited_by AND revoked_at IS NULL FOR SHARE;
  END IF;
  RETURN FOUND;
END
$$;

CREATE FUNCTION domain.replace_initial_invitation(subject text, expiry timestamptz, rationale text, invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE tenant uuid := nullif(current_setting('quenda.tenant_id', true), '')::uuid;
DECLARE actor text := nullif(current_setting('quenda.account_id', true), '');
BEGIN
  IF NOT domain.lock_current_operator() THEN RETURN false; END IF;
  PERFORM 1 FROM domain.municipality WHERE id = tenant FOR UPDATE;
  IF NOT FOUND OR NOT domain.municipality_bootstrap_open() THEN RETURN false; END IF;
  IF expiry IS NULL OR expiry <= now() OR rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid initial invitation' USING ERRCODE = '22023';
  END IF;
  WITH revoked AS (
    UPDATE domain.administrator_invitation SET revoked_at = now()
    WHERE tenant_id = tenant AND grant_source = 'PLATFORM' AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id,account_id
  ) INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
    SELECT tenant,gen_random_uuid(),actor,'REVOKE_INVITATION',account_id,id,rationale FROM revoked;
  INSERT INTO domain.administrator_invitation (tenant_id,id,account_id,invited_by,expires_at,grant_source)
    VALUES (tenant,invitation,subject,actor,expiry,'PLATFORM');
  INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
    VALUES (tenant,gen_random_uuid(),actor,'INVITE_ADMINISTRATOR',subject,invitation,rationale);
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION domain.replace_initial_invitation(text,timestamptz,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.replace_initial_invitation(text,timestamptz,text,uuid) TO quenda_domain;
