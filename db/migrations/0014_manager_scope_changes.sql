ALTER TABLE domain.manager_invitation ADD COLUMN replaces_invitation_id uuid;
ALTER TABLE domain.manager_invitation ADD FOREIGN KEY(tenant_id,replaces_invitation_id) REFERENCES domain.manager_grant(tenant_id,invitation_id);
ALTER TABLE domain.manager_event ADD COLUMN previous_invitation_id uuid;
ALTER TABLE domain.manager_event ADD FOREIGN KEY(tenant_id,previous_invitation_id) REFERENCES domain.manager_invitation(tenant_id,id);
ALTER TABLE domain.manager_event DROP CONSTRAINT manager_event_operation_check;
ALTER TABLE domain.manager_event ADD CHECK(operation IN ('INVITE_MANAGER','ACCEPT_MANAGER','REVOKE_MANAGER','REVOKE_MANAGER_INVITATION','REPLACE_MANAGER'));
DROP FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb);
CREATE FUNCTION domain.invite_manager(invitation uuid, subject text, expiry timestamptz, role_expiry timestamptz, permissions jsonb, replaces uuid DEFAULT NULL, rationale text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE issuer uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF permissions IS NULL OR jsonb_typeof(permissions)<>'array' OR jsonb_array_length(permissions) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid scope' USING ERRCODE='22023'; END IF;
 IF replaces IS NOT NULL THEN
   IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
   PERFORM 1 FROM domain.manager_grant WHERE tenant_id=tenant AND invitation_id=replaces AND account_id=subject AND revoked_at IS NULL FOR SHARE;
   IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 SELECT invitation_id INTO issuer FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=actor;
 INSERT INTO domain.manager_invitation(tenant_id,id,account_id,invited_by,issuer_invitation_id,expires_at,role_expires_at,replaces_invitation_id)
 VALUES(tenant,invitation,subject,actor,issuer,expiry,role_expiry,replaces);
 INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id)
 SELECT tenant,invitation,p.operation,p."unitId" FROM jsonb_to_recordset(permissions) AS p(operation text,"unitId" uuid);
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason,previous_invitation_id) VALUES(tenant,gen_random_uuid(),invitation,actor,'INVITE_MANAGER',rationale,replaces);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION domain.accept_manager(invitation uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE item domain.manager_invitation;
BEGIN
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation AND account_id=actor;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=item.invited_by
   AND invitation_id=item.issuer_invitation_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO item FROM domain.manager_invitation WHERE tenant_id=tenant AND id=invitation AND account_id=actor
   AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role_expires_at IS NULL OR role_expires_at>now()) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF item.replaces_invitation_id IS NOT NULL THEN
   PERFORM 1 FROM domain.manager_grant WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id AND account_id=actor AND revoked_at IS NULL FOR UPDATE;
   IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES(tenant,actor) ON CONFLICT DO NOTHING;
 INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES(tenant,invitation,actor);
 UPDATE domain.manager_invitation SET accepted_at=now() WHERE tenant_id=tenant AND id=invitation;
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation) VALUES(tenant,gen_random_uuid(),invitation,actor,'ACCEPT_MANAGER');
 IF item.replaces_invitation_id IS NOT NULL THEN
   UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=tenant AND invitation_id=item.replaces_invitation_id;
   INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,previous_invitation_id)
     VALUES(tenant,gen_random_uuid(),invitation,actor,'REPLACE_MANAGER',item.replaces_invitation_id);
 END IF;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb,uuid,text) TO quenda_domain;
CREATE INDEX manager_own_cursor ON domain.manager_invitation(account_id,id);
CREATE FUNCTION domain.own_manager_invitations(after_id uuid)
RETURNS TABLE(id uuid,tenant_id uuid,municipality text,expires_at timestamptz,role_expires_at timestamptz,status text,permissions jsonb,replaces_invitation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT i.id,i.tenant_id,m.name,i.expires_at,i.role_expires_at,
   CASE WHEN i.revoked_at IS NOT NULL OR g.revoked_at IS NOT NULL THEN 'REVOKED'
     WHEN i.role_expires_at <= now() THEN 'EXPIRED'
     WHEN g.invitation_id IS NOT NULL THEN 'ACTIVE'
     WHEN i.expires_at <= now() THEN 'EXPIRED'
     WHEN i.replaces_invitation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.manager_grant old WHERE old.tenant_id=i.tenant_id AND old.invitation_id=i.replaces_invitation_id AND old.revoked_at IS NULL) THEN 'INVALIDATED'
     WHEN NOT EXISTS(SELECT 1 FROM domain.municipal_administrator a WHERE a.tenant_id=i.tenant_id AND a.account_id=i.invited_by
       AND a.invitation_id=i.issuer_invitation_id AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>now())) THEN 'INVALIDATED'
     ELSE 'PENDING' END,
   (SELECT jsonb_agg(jsonb_build_object('operation',p.operation,'unitId',p.unit_id) ORDER BY p.operation,p.unit_id)
     FROM domain.manager_permission p WHERE p.tenant_id=i.tenant_id AND p.invitation_id=i.id),i.replaces_invitation_id
 FROM domain.manager_invitation i JOIN domain.municipality m ON m.id=i.tenant_id
 LEFT JOIN domain.manager_grant g ON (g.tenant_id,g.invitation_id)=(i.tenant_id,i.id)
 WHERE i.account_id=nullif(current_setting('quenda.account_id',true),'') AND (after_id IS NULL OR i.id>after_id)
 ORDER BY i.id LIMIT 21
$$;
REVOKE ALL ON FUNCTION domain.own_manager_invitations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.own_manager_invitations(uuid) TO quenda_domain;
