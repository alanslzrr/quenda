ALTER TABLE domain.administrator_invitation ADD COLUMN grant_source text NOT NULL DEFAULT 'PLATFORM'
  CHECK (grant_source IN ('PLATFORM', 'MUNICIPAL'));
ALTER TABLE domain.identity_event DROP CONSTRAINT identity_event_operation_check;
ALTER TABLE domain.identity_event ADD CHECK (operation IN ('CREATE_MUNICIPALITY', 'INVITE_ADMINISTRATOR', 'ACCEPT_ADMINISTRATOR', 'REVOKE_INVITATION'));

CREATE FUNCTION domain.lock_current_administrator() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM domain.municipal_administrator
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
      AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL FOR SHARE)
$$;
REVOKE ALL ON FUNCTION domain.lock_current_administrator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_current_administrator() TO quenda_domain;

DROP POLICY invitation_create ON domain.administrator_invitation;
CREATE POLICY invitation_create ON domain.administrator_invitation FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND invited_by = nullif(current_setting('quenda.account_id', true), '')
    AND accepted_at IS NULL AND revoked_at IS NULL
    AND ((grant_source = 'PLATFORM' AND domain.lock_current_operator())
      OR (grant_source = 'MUNICIPAL' AND domain.lock_current_administrator())));

CREATE FUNCTION domain.lock_invitation_authority(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE item domain.administrator_invitation;
BEGIN
  SELECT * INTO item FROM domain.administrator_invitation
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND id = invitation
      AND account_id = nullif(current_setting('quenda.account_id', true), '');
  IF NOT FOUND THEN RETURN false; END IF;
  IF item.grant_source = 'PLATFORM' THEN
    PERFORM 1 FROM domain.platform_operator WHERE account_id = item.invited_by AND revoked_at IS NULL FOR SHARE;
  ELSE
    PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id = item.tenant_id
      AND account_id = item.invited_by AND revoked_at IS NULL FOR SHARE;
  END IF;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION domain.lock_invitation_authority(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_invitation_authority(uuid) TO quenda_domain;

-- Revocation is a narrow capability, not UPDATE permission on invitation scope,
-- recipient, expiry or grant source. Accepted invitations cannot be rewritten.
CREATE FUNCTION domain.revoke_administrator_invitation(invitation uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE subject text;
BEGIN
  IF NOT domain.lock_current_administrator() THEN RETURN NULL; END IF;
  UPDATE domain.administrator_invitation SET revoked_at = now()
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND id = invitation
      AND accepted_at IS NULL AND revoked_at IS NULL RETURNING account_id INTO subject;
  RETURN subject;
END
$$;
REVOKE ALL ON FUNCTION domain.revoke_administrator_invitation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.revoke_administrator_invitation(uuid) TO quenda_domain;

ALTER POLICY administrator_accept ON domain.municipal_administrator
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM domain.administrator_invitation i
      WHERE i.tenant_id = municipal_administrator.tenant_id AND i.account_id = municipal_administrator.account_id
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
        AND domain.lock_invitation_authority(i.id)));
