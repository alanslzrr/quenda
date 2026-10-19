-- Cross-municipal projection for the authenticated recipient only. This does
-- not broaden the tenant policies or expose a municipal/global user directory.
CREATE FUNCTION domain.own_administrator_invitations(after_id uuid)
RETURNS TABLE (id uuid, tenant_id uuid, municipality text, expires_at timestamptz, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT i.id, i.tenant_id, m.name, i.expires_at,
    CASE WHEN i.accepted_at IS NOT NULL THEN 'ACCEPTED'
      WHEN i.revoked_at IS NOT NULL THEN 'REVOKED'
      WHEN i.expires_at <= now() THEN 'EXPIRED' ELSE 'PENDING' END
  FROM domain.administrator_invitation i JOIN domain.municipality m ON m.id = i.tenant_id
  WHERE i.account_id = nullif(current_setting('quenda.account_id', true), '')
    AND (after_id IS NULL OR i.id > after_id)
  ORDER BY i.id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_administrator_invitations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_administrator_invitations(uuid) TO quenda_domain;
CREATE INDEX invitation_recipient_cursor ON domain.administrator_invitation(account_id,id);
