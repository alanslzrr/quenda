ALTER TABLE domain.administrator_invitation ADD COLUMN issuer_invitation_id uuid;
UPDATE domain.administrator_invitation i SET issuer_invitation_id = (
  SELECT origin.id FROM domain.administrator_invitation origin
  WHERE origin.tenant_id = i.tenant_id AND origin.account_id = i.invited_by
    AND origin.accepted_at <= i.created_at ORDER BY origin.accepted_at DESC, origin.id LIMIT 1
) WHERE i.grant_source = 'MUNICIPAL';
ALTER TABLE domain.administrator_invitation ADD FOREIGN KEY (tenant_id,issuer_invitation_id)
  REFERENCES domain.administrator_invitation(tenant_id,id);
ALTER TABLE domain.administrator_invitation ADD CHECK (grant_source <> 'MUNICIPAL' OR issuer_invitation_id IS NOT NULL);

ALTER TABLE domain.administrator_invitation ADD COLUMN role_expires_at timestamptz;
ALTER TABLE domain.administrator_invitation ADD CHECK (role_expires_at IS NULL OR role_expires_at > created_at);
ALTER TABLE domain.municipal_administrator ADD COLUMN expires_at timestamptz;
ALTER TABLE domain.municipal_administrator ADD CHECK (expires_at IS NULL OR expires_at > granted_at);

CREATE OR REPLACE FUNCTION domain.current_is_administrator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT EXISTS (
  SELECT 1 FROM domain.municipal_administrator
  WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
) $$;

CREATE OR REPLACE FUNCTION domain.lock_current_administrator() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM domain.municipal_administrator
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
      AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR SHARE)
$$;

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
      AND account_id = item.invited_by AND invitation_id = item.issuer_invitation_id
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) FOR SHARE;
  END IF;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION domain.activate_administrator(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE item domain.administrator_invitation;
BEGIN
  IF NOT domain.lock_invitation_authority(invitation) THEN RETURN false; END IF;
  SELECT * INTO item FROM domain.administrator_invitation
    WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND id = invitation
      AND account_id = nullif(current_setting('quenda.account_id', true), '')
      AND expires_at > now() AND (role_expires_at IS NULL OR role_expires_at > now()) AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO domain.municipal_administrator AS existing (tenant_id,account_id,invitation_id,expires_at)
    VALUES (item.tenant_id,item.account_id,item.id,item.role_expires_at)
    ON CONFLICT (tenant_id,account_id) DO UPDATE SET revoked_at = NULL, granted_at = now(), invitation_id = item.id, expires_at = item.role_expires_at
      WHERE (existing.revoked_at IS NOT NULL AND item.created_at > existing.revoked_at)
        OR (existing.revoked_at IS NULL AND existing.expires_at <= now() AND item.created_at > existing.expires_at);
  RETURN FOUND;
END
$$;

DROP FUNCTION domain.own_administrator_invitations(uuid);
CREATE FUNCTION domain.own_administrator_invitations(after_id uuid)
RETURNS TABLE (id uuid, tenant_id uuid, municipality text, expires_at timestamptz, status text, role_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT i.id, i.tenant_id, m.name, i.expires_at,
    CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
      WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
      WHEN i.expires_at <= now() OR i.role_expires_at <= now() THEN 'EXPIRED' ELSE 'PENDING' END, i.role_expires_at
  FROM domain.administrator_invitation i JOIN domain.municipality m ON m.id = i.tenant_id
  WHERE i.account_id = nullif(current_setting('quenda.account_id', true), '')
    AND (after_id IS NULL OR i.id > after_id)
  ORDER BY i.id LIMIT 21
$$;

REVOKE ALL ON FUNCTION domain.own_administrator_invitations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_administrator_invitations(uuid) TO quenda_domain;
