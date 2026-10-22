-- Public discovery exposes only municipality identity; no staff or activity.
CREATE FUNCTION domain.public_municipalities(after_id uuid,selected_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,name text,timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.id,m.name,m.timezone FROM domain.municipality m
 WHERE (after_id IS NULL OR m.id>after_id) AND (selected_id IS NULL OR m.id=selected_id)
 ORDER BY m.id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.public_municipalities(uuid,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_municipalities(uuid,uuid) TO quenda_domain;

-- This projection is navigation data, never an authorization grant. Every
-- command still checks its own object, scope, MFA and transactional locks.
CREATE FUNCTION domain.own_municipal_contexts(after_id uuid)
RETURNS TABLE(id uuid,name text,administrator boolean,permissions jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH actor AS (SELECT nullif(current_setting('quenda.account_id',true),'') AS id),
 admins AS (
  SELECT a.tenant_id FROM domain.municipal_administrator a,actor
  WHERE a.account_id=actor.id AND a.revoked_at IS NULL
   AND (a.expires_at IS NULL OR a.expires_at>now()) AND domain.responsible_account_enabled(actor.id)
 ), grants AS (
  SELECT DISTINCT g.tenant_id,p.operation,p.unit_id FROM domain.manager_grant g
  JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(g.tenant_id,g.invitation_id)
  JOIN domain.manager_permission p ON (p.tenant_id,p.invitation_id)=(g.tenant_id,g.invitation_id),actor
  WHERE g.account_id=actor.id AND g.revoked_at IS NULL AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
   AND (i.role_expires_at IS NULL OR i.role_expires_at>now()) AND domain.responsible_account_enabled(actor.id)
 )
 SELECT m.id,m.name,EXISTS(SELECT 1 FROM admins a WHERE a.tenant_id=m.id),
 coalesce((SELECT jsonb_agg(jsonb_build_object('operation',g.operation,'unitId',g.unit_id) ORDER BY g.operation,g.unit_id)
 FROM grants g WHERE g.tenant_id=m.id),'[]'::jsonb)
 FROM domain.municipality m
 WHERE (after_id IS NULL OR m.id>after_id)
 AND (EXISTS(SELECT 1 FROM admins a WHERE a.tenant_id=m.id) OR EXISTS(SELECT 1 FROM grants g WHERE g.tenant_id=m.id))
 ORDER BY m.id LIMIT 21
$$;
CREATE FUNCTION domain.own_platform_context()
RETURNS TABLE(operator boolean,permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH actor AS (SELECT nullif(current_setting('quenda.account_id',true),'') AS id)
 SELECT EXISTS(SELECT 1 FROM domain.platform_operator p,actor WHERE p.account_id=actor.id
 AND p.revoked_at IS NULL AND domain.responsible_account_enabled(actor.id)),
 ARRAY(SELECT DISTINCT unnest(i.permissions) FROM domain.global_privacy_invitation i,actor
 WHERE i.account_id=actor.id AND i.accepted_at IS NOT NULL AND i.revoked_at IS NULL
 AND (i.role_expires_at IS NULL OR i.role_expires_at>now()) AND domain.responsible_account_enabled(actor.id))
$$;
REVOKE ALL ON FUNCTION domain.own_municipal_contexts(uuid),domain.own_platform_context() FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.own_municipal_contexts(uuid),domain.own_platform_context() TO quenda_domain;
