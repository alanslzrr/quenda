CREATE TABLE domain.manager_invitation (
 tenant_id uuid NOT NULL REFERENCES domain.municipality(id), id uuid NOT NULL,
 account_id text NOT NULL REFERENCES auth."user"(id), invited_by text NOT NULL REFERENCES auth."user"(id),
 issuer_invitation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL CHECK(expires_at > created_at),
 role_expires_at timestamptz CHECK(role_expires_at IS NULL OR role_expires_at > created_at),
 accepted_at timestamptz, revoked_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,issuer_invitation_id) REFERENCES domain.administrator_invitation(tenant_id,id),
 CHECK(accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX manager_invitation_recipient ON domain.manager_invitation(account_id,tenant_id);
CREATE TABLE domain.manager_permission (
 tenant_id uuid NOT NULL, invitation_id uuid NOT NULL, operation text NOT NULL,
 unit_id uuid,
 FOREIGN KEY(tenant_id,invitation_id) REFERENCES domain.manager_invitation(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 UNIQUE NULLS NOT DISTINCT(tenant_id,invitation_id,operation,unit_id),
 CHECK(operation IN ('CATALOG_CREATE','CATALOG_MANAGE','RESERVATION_READ','RESERVATION_MANAGE','UNIT_BLOCK','REPORT_READ','DATA_EXPORT')),
 CHECK(operation <> 'CATALOG_CREATE' OR unit_id IS NULL)
);
CREATE TABLE domain.manager_grant (
 tenant_id uuid NOT NULL, invitation_id uuid NOT NULL, account_id text NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 PRIMARY KEY(tenant_id,invitation_id),
 FOREIGN KEY(tenant_id,invitation_id) REFERENCES domain.manager_invitation(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES domain.municipal_profile(tenant_id,account_id)
);
CREATE INDEX manager_account ON domain.manager_grant(tenant_id,account_id);
CREATE TABLE domain.manager_event (
 tenant_id uuid NOT NULL, id uuid NOT NULL, invitation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(operation IN ('INVITE_MANAGER','ACCEPT_MANAGER','REVOKE_MANAGER','REVOKE_MANAGER_INVITATION')),
 reason text, occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,invitation_id) REFERENCES domain.manager_invitation(tenant_id,id)
);
ALTER TABLE domain.manager_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_permission FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.manager_event FORCE ROW LEVEL SECURITY;
CREATE POLICY manager_invitation_maintenance ON domain.manager_invitation TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY manager_permission_maintenance ON domain.manager_permission TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY manager_grant_maintenance ON domain.manager_grant TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY manager_event_maintenance ON domain.manager_event TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY manager_invitation_read ON domain.manager_invitation FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND (account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.current_is_administrator()));
CREATE POLICY manager_permission_read ON domain.manager_permission FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM domain.manager_invitation i WHERE i.tenant_id=manager_permission.tenant_id AND i.id=manager_permission.invitation_id));
CREATE POLICY manager_grant_read ON domain.manager_grant FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND (account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.current_is_administrator()));
CREATE POLICY manager_event_read ON domain.manager_event FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.current_is_administrator());
GRANT SELECT ON domain.manager_invitation,domain.manager_permission,domain.manager_grant,domain.manager_event TO quenda_domain;

CREATE FUNCTION domain.invite_manager(invitation uuid, subject text, expiry timestamptz, role_expiry timestamptz, permissions jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE issuer uuid;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF permissions IS NULL OR jsonb_typeof(permissions)<>'array' OR jsonb_array_length(permissions) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid scope' USING ERRCODE='22023'; END IF;
 SELECT invitation_id INTO issuer FROM domain.municipal_administrator WHERE tenant_id=tenant AND account_id=actor;
 INSERT INTO domain.manager_invitation(tenant_id,id,account_id,invited_by,issuer_invitation_id,expires_at,role_expires_at)
 VALUES(tenant,invitation,subject,actor,issuer,expiry,role_expiry);
 INSERT INTO domain.manager_permission(tenant_id,invitation_id,operation,unit_id)
 SELECT tenant,invitation,p.operation,p."unitId" FROM jsonb_to_recordset(permissions) AS p(operation text,"unitId" uuid);
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation) VALUES(tenant,gen_random_uuid(),invitation,actor,'INVITE_MANAGER');
 RETURN true;
END $$;
CREATE FUNCTION domain.accept_manager(invitation uuid) RETURNS boolean
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
 INSERT INTO domain.municipal_profile(tenant_id,account_id) VALUES(tenant,actor) ON CONFLICT DO NOTHING;
 INSERT INTO domain.manager_grant(tenant_id,invitation_id,account_id) VALUES(tenant,invitation,actor);
 UPDATE domain.manager_invitation SET accepted_at=now() WHERE tenant_id=tenant AND id=invitation;
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation) VALUES(tenant,gen_random_uuid(),invitation,actor,'ACCEPT_MANAGER');
 RETURN true;
END $$;
CREATE FUNCTION domain.revoke_manager(invitation uuid, rationale text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
DECLARE actor text:=nullif(current_setting('quenda.account_id',true),'');
DECLARE action text;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RETURN false; END IF;
 IF rationale IS NULL OR length(btrim(rationale)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid reason' USING ERRCODE='22023'; END IF;
 UPDATE domain.manager_grant SET revoked_at=now() WHERE tenant_id=tenant AND invitation_id=invitation AND revoked_at IS NULL;
 IF FOUND THEN action:='REVOKE_MANAGER'; ELSE
   UPDATE domain.manager_invitation SET revoked_at=now() WHERE tenant_id=tenant AND id=invitation AND accepted_at IS NULL AND revoked_at IS NULL;
   IF NOT FOUND THEN RETURN false; END IF;
   action:='REVOKE_MANAGER_INVITATION';
 END IF;
 INSERT INTO domain.manager_event(tenant_id,id,invitation_id,actor_id,operation,reason) VALUES(tenant,gen_random_uuid(),invitation,actor,action,rationale);
 RETURN true;
END $$;
CREATE FUNCTION domain.lock_permission(action text, resource uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF action IS NULL OR action NOT IN ('CATALOG_CREATE','CATALOG_MANAGE','RESERVATION_READ','RESERVATION_MANAGE','UNIT_BLOCK','REPORT_READ','DATA_EXPORT') THEN RETURN false; END IF;
 IF domain.lock_current_administrator() THEN RETURN true; END IF;
 PERFORM 1 FROM domain.manager_grant g JOIN domain.manager_invitation i ON (i.tenant_id,i.id)=(g.tenant_id,g.invitation_id)
 JOIN domain.manager_permission p ON (p.tenant_id,p.invitation_id)=(g.tenant_id,g.invitation_id)
 WHERE g.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND g.account_id=nullif(current_setting('quenda.account_id',true),'')
   AND g.revoked_at IS NULL AND (i.role_expires_at IS NULL OR i.role_expires_at>now()) AND p.operation=action
   AND (p.unit_id IS NULL OR p.unit_id=resource) ORDER BY g.invitation_id LIMIT 1 FOR SHARE OF g;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb),domain.accept_manager(uuid),domain.revoke_manager(uuid,text),domain.lock_permission(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.invite_manager(uuid,text,timestamptz,timestamptz,jsonb),domain.accept_manager(uuid),domain.revoke_manager(uuid,text),domain.lock_permission(text,uuid) TO quenda_domain;
ALTER POLICY facility_create ON domain.facility WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_CREATE',NULL));
ALTER POLICY unit_create ON domain.reservable_unit WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_CREATE',NULL));
ALTER POLICY facility_read ON domain.facility USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_CREATE',NULL));
ALTER POLICY unit_read ON domain.reservable_unit USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND (domain.lock_permission('CATALOG_CREATE',NULL) OR domain.lock_permission('CATALOG_MANAGE',id)));
ALTER POLICY catalog_event_append ON domain.catalog_event WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),'') AND domain.lock_permission('CATALOG_CREATE',NULL));
