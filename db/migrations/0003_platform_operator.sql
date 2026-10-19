CREATE TABLE domain.platform_operator (
  account_id text PRIMARY KEY REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
ALTER TABLE domain.platform_operator ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.platform_operator FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_self ON domain.platform_operator FOR SELECT TO quenda_domain
  USING (account_id = nullif(current_setting('quenda.account_id', true), ''));
CREATE POLICY operator_maintenance ON domain.platform_operator TO quenda_migrator
  USING (true) WITH CHECK (true);
GRANT SELECT ON domain.platform_operator TO quenda_domain;

-- Persistent, single-use initialization evidence. Revocation does not reopen it.
CREATE TABLE domain.operator_initialization (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  account_id text NOT NULL REFERENCES domain.platform_operator(account_id),
  operation text NOT NULL DEFAULT 'INITIALIZE_OPERATOR' CHECK (operation = 'INITIALIZE_OPERATOR'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE domain.operator_initialization ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.operator_initialization FORCE ROW LEVEL SECURITY;
CREATE POLICY initialization_maintenance ON domain.operator_initialization TO quenda_migrator
  USING (true) WITH CHECK (true);

-- Lock without granting UPDATE to the web role. This capability returns only
-- the current account's active status and cannot enumerate other accounts.
CREATE FUNCTION domain.lock_current_operator() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM domain.platform_operator
    WHERE account_id = nullif(current_setting('quenda.account_id', true), '')
      AND revoked_at IS NULL
    FOR SHARE
  )
$$;
REVOKE ALL ON FUNCTION domain.lock_current_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_current_operator() TO quenda_domain;
