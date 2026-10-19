CREATE TABLE domain.municipality (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  timezone text NOT NULL,
  advance_days integer NOT NULL DEFAULT 30 CHECK (advance_days >= 0),
  cancellation_minutes integer NOT NULL DEFAULT 0 CHECK (cancellation_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE domain.municipal_profile (
  tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
  account_id text NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);
CREATE TABLE domain.municipal_administrator (
  tenant_id uuid NOT NULL,
  account_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES domain.municipal_profile(tenant_id, account_id),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE TABLE domain.administrator_invitation (
  tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
  id uuid NOT NULL,
  account_id text NOT NULL REFERENCES auth."user"(id),
  invited_by text NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  accepted_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invitation_recipient ON domain.administrator_invitation(account_id, tenant_id);
CREATE TABLE domain.identity_event (
  tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
  id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES auth."user"(id),
  operation text NOT NULL CHECK (operation IN ('CREATE_MUNICIPALITY', 'INVITE_ADMINISTRATOR', 'ACCEPT_ADMINISTRATOR')),
  subject_id text NOT NULL REFERENCES auth."user"(id),
  invitation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, invitation_id) REFERENCES domain.administrator_invitation(tenant_id, id)
);

ALTER TABLE domain.municipality ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipality FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_administrator ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.municipal_administrator FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.administrator_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.administrator_invitation FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.identity_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.identity_event FORCE ROW LEVEL SECURITY;

CREATE POLICY municipality_maintenance ON domain.municipality TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY profile_maintenance ON domain.municipal_profile TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY administrator_maintenance ON domain.municipal_administrator TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY invitation_maintenance ON domain.administrator_invitation TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY identity_event_maintenance ON domain.identity_event TO quenda_migrator USING (true) WITH CHECK (true);

CREATE FUNCTION domain.current_is_administrator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT EXISTS (
  SELECT 1 FROM domain.municipal_administrator
  WHERE tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL
) $$;
REVOKE ALL ON FUNCTION domain.current_is_administrator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.current_is_administrator() TO quenda_domain;

CREATE POLICY municipality_read ON domain.municipality FOR SELECT TO quenda_domain
  USING (id = nullif(current_setting('quenda.tenant_id', true), '')::uuid);
CREATE POLICY municipality_create ON domain.municipality FOR INSERT TO quenda_domain
  WITH CHECK (id = nullif(current_setting('quenda.tenant_id', true), '')::uuid AND domain.lock_current_operator());
CREATE POLICY profile_read ON domain.municipal_profile FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND (account_id = nullif(current_setting('quenda.account_id', true), '') OR domain.current_is_administrator()));
CREATE POLICY profile_self_create ON domain.municipal_profile FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), ''));
CREATE POLICY administrator_read ON domain.municipal_administrator FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND (account_id = nullif(current_setting('quenda.account_id', true), '') OR domain.current_is_administrator()));
CREATE POLICY invitation_read ON domain.administrator_invitation FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND (account_id = nullif(current_setting('quenda.account_id', true), '') OR domain.current_is_administrator()
      OR invited_by = nullif(current_setting('quenda.account_id', true), '')));
CREATE POLICY invitation_create ON domain.administrator_invitation FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND invited_by = nullif(current_setting('quenda.account_id', true), '')
    AND accepted_at IS NULL AND revoked_at IS NULL AND domain.lock_current_operator());
CREATE POLICY invitation_accept ON domain.administrator_invitation FOR UPDATE TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '')
    AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '')
    AND accepted_at IS NOT NULL AND revoked_at IS NULL);
CREATE POLICY administrator_accept ON domain.municipal_administrator FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND account_id = nullif(current_setting('quenda.account_id', true), '') AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM domain.administrator_invitation i
      WHERE i.tenant_id = municipal_administrator.tenant_id AND i.account_id = municipal_administrator.account_id
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()));
CREATE POLICY identity_event_read ON domain.identity_event FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND (actor_id = nullif(current_setting('quenda.account_id', true), '') OR domain.current_is_administrator()));
CREATE POLICY identity_event_append ON domain.identity_event FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id', true), '')::uuid
    AND actor_id = nullif(current_setting('quenda.account_id', true), ''));

GRANT SELECT, INSERT ON domain.municipality, domain.municipal_profile, domain.municipal_administrator, domain.administrator_invitation, domain.identity_event TO quenda_domain;
GRANT UPDATE (accepted_at) ON domain.administrator_invitation TO quenda_domain;
