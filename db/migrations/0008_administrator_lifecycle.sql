ALTER TABLE domain.municipal_administrator ADD COLUMN invitation_id uuid;
UPDATE domain.municipal_administrator a SET invitation_id = (
  SELECT i.id FROM domain.administrator_invitation i WHERE i.tenant_id = a.tenant_id AND i.account_id = a.account_id
    AND i.accepted_at IS NOT NULL ORDER BY i.accepted_at DESC, i.id LIMIT 1
);
ALTER TABLE domain.municipal_administrator ALTER COLUMN invitation_id SET NOT NULL;
ALTER TABLE domain.municipal_administrator ADD FOREIGN KEY (tenant_id, invitation_id)
  REFERENCES domain.administrator_invitation(tenant_id, id);
ALTER TABLE domain.identity_event ADD COLUMN reason text;
ALTER TABLE domain.identity_event DROP CONSTRAINT identity_event_operation_check;
ALTER TABLE domain.identity_event ADD CHECK (operation IN ('CREATE_MUNICIPALITY', 'INVITE_ADMINISTRATOR', 'ACCEPT_ADMINISTRATOR', 'REVOKE_INVITATION', 'REVOKE_ADMINISTRATOR'));
ALTER TABLE domain.identity_event ADD CHECK (operation <> 'REVOKE_ADMINISTRATOR' OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500));

-- A role can only be activated from the authenticated recipient's live invite.
-- Restoring it requires an invitation issued after its last revocation.
CREATE FUNCTION domain.activate_administrator(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE item domain.administrator_invitation;
BEGIN
  IF NOT domain.lock_invitation_authority(invitation) THEN RETURN false; END IF;
  SELECT * INTO item FROM domain.administrator_invitation
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND id = invitation
      AND account_id = nullif(current_setting('quenda.account_id', true), '')
      AND expires_at > now() AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO domain.municipal_administrator AS existing (tenant_id,account_id,invitation_id)
    VALUES (item.tenant_id,item.account_id,item.id)
    ON CONFLICT (tenant_id,account_id) DO UPDATE SET revoked_at = NULL, granted_at = now(), invitation_id = item.id
      WHERE existing.revoked_at IS NOT NULL AND item.created_at > existing.revoked_at;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION domain.activate_administrator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.activate_administrator(uuid) TO quenda_domain;
-- Prevent direct grants from avoiding the source-invitation lifecycle.
REVOKE INSERT ON domain.municipal_administrator FROM quenda_domain;

CREATE FUNCTION domain.revoke_administrator(subject text, rationale text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE source uuid;
DECLARE tenant uuid := nullif(current_setting('quenda.tenant_id', true), '')::uuid;
DECLARE actor text := nullif(current_setting('quenda.account_id', true), '');
BEGIN
  IF NOT domain.lock_current_administrator() THEN RETURN NULL; END IF;
  IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid revocation reason' USING ERRCODE = '22023';
  END IF;
  UPDATE domain.municipal_administrator SET revoked_at = now()
    WHERE tenant_id = tenant AND account_id = subject AND revoked_at IS NULL RETURNING invitation_id INTO source;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH revoked AS (
    UPDATE domain.administrator_invitation SET revoked_at = now()
      WHERE tenant_id = tenant AND invited_by = subject AND grant_source = 'MUNICIPAL'
        AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id, account_id
  ) INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
    SELECT tenant, gen_random_uuid(), actor, 'REVOKE_INVITATION', account_id, id, rationale FROM revoked;
  INSERT INTO domain.identity_event (tenant_id,id,actor_id,operation,subject_id,invitation_id,reason)
    VALUES (tenant,gen_random_uuid(),actor,'REVOKE_ADMINISTRATOR',subject,source,rationale);
  RETURN source;
END
$$;
REVOKE ALL ON FUNCTION domain.revoke_administrator(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.revoke_administrator(text,text) TO quenda_domain;
