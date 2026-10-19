-- Denied targets are untrusted identifiers, not evidence of membership or even
-- existence. Keep them distinct from the authoritative actor and tenant scope.
CREATE TABLE domain.access_denial (
  request_id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  requested_tenant_id uuid,
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 100),
  outcome text NOT NULL CHECK (outcome IN ('FORBIDDEN','UNAUTHENTICATED','REAUTHENTICATION_REQUIRED','NOT_FOUND','RATE_LIMITED','INVALID_INPUT','CONFLICT')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX access_denial_actor_time ON domain.access_denial(actor_id,occurred_at);
ALTER TABLE domain.access_denial ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.access_denial FORCE ROW LEVEL SECURITY;
CREATE POLICY denial_maintenance ON domain.access_denial TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY denial_append ON domain.access_denial FOR INSERT TO quenda_domain
  WITH CHECK (actor_id=nullif(current_setting('quenda.account_id',true),''));
GRANT INSERT ON domain.access_denial TO quenda_domain;
-- No runtime SELECT, UPDATE, DELETE or TRUNCATE privilege; no tenant-visible
-- history of failed requests against other administrations.
