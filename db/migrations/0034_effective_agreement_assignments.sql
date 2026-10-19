CREATE TABLE domain.agreement_activation (
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 effective_period tstzrange NOT NULL,
 activated_by text NOT NULL REFERENCES auth."user"(id),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL,
 PRIMARY KEY(agreement_id,version),
 UNIQUE(agreement_id,version,effective_period),
 FOREIGN KEY(agreement_id,version) REFERENCES domain.agreement_version(agreement_id,version),
 CHECK(isempty(effective_period) OR (NOT lower_inf(effective_period) AND NOT upper_inf(effective_period)
  AND isfinite(lower(effective_period)) AND isfinite(upper(effective_period))
  AND lower_inc(effective_period) AND NOT upper_inc(effective_period))),
 EXCLUDE USING gist(agreement_id extensions.gist_uuid_ops WITH =,effective_period WITH &&)
);
CREATE TABLE domain.agreement_assignment (
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 tenant_id uuid NOT NULL,
 unit_id uuid NOT NULL,
 effective_period tstzrange NOT NULL,
 PRIMARY KEY(agreement_id,version,tenant_id,unit_id),
 FOREIGN KEY(agreement_id,version,tenant_id,unit_id) REFERENCES domain.agreement_unit(agreement_id,version,tenant_id,unit_id),
 FOREIGN KEY(agreement_id,version,effective_period) REFERENCES domain.agreement_activation(agreement_id,version,effective_period) ON UPDATE CASCADE,
 EXCLUDE USING gist(tenant_id extensions.gist_uuid_ops WITH =,unit_id extensions.gist_uuid_ops WITH =,effective_period WITH &&)
);
-- Existence prevents automatic public fallback; the effective assignment is selected separately.
CREATE TABLE domain.unit_agreement_gate (
 tenant_id uuid NOT NULL,
 unit_id uuid NOT NULL,
 agreement_id uuid NOT NULL,
 version integer NOT NULL,
 PRIMARY KEY(tenant_id,unit_id),
 FOREIGN KEY(agreement_id,version,tenant_id,unit_id) REFERENCES domain.agreement_assignment(agreement_id,version,tenant_id,unit_id)
);
ALTER TABLE domain.agreement_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_activation FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.unit_agreement_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.unit_agreement_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_activation_maintenance ON domain.agreement_activation TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_assignment_maintenance ON domain.agreement_assignment TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY unit_agreement_gate_maintenance ON domain.unit_agreement_gate TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.agreement_activation,domain.agreement_assignment,domain.unit_agreement_gate FROM PUBLIC,quenda_domain,quenda_auth;

CREATE FUNCTION domain.check_activation_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 -- Closing a scheduled activation before it starts preserves evidence with an empty interval.
 IF TG_OP='INSERT' AND isempty(NEW.effective_period) THEN
  RAISE EXCEPTION 'Activation requires an effective interval' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_version v
   WHERE v.agreement_id=NEW.agreement_id AND v.version=NEW.version
   AND NEW.effective_period <@ tstzrange(v.starts_at,v.ends_at,'[)')) THEN
  RAISE EXCEPTION 'Effective period exceeds approved configuration' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION domain.check_activation_period() FROM PUBLIC;
CREATE TRIGGER activation_period BEFORE INSERT OR UPDATE ON domain.agreement_activation
 FOR EACH ROW EXECUTE FUNCTION domain.check_activation_period();
