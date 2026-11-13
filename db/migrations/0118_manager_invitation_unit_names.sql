-- A person reading their own management invitation sees which space each
-- permission covers by name, not by identifier. unitName is null for
-- municipality-wide permissions.
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
 WHERE i.account_id=nullif(current_setting('quenda.account_id',true),'') AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;
