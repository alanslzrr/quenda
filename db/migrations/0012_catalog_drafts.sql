CREATE TABLE domain.facility (
  tenant_id uuid NOT NULL REFERENCES domain.municipality(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE domain.reservable_unit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  facility_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,facility_id) REFERENCES domain.facility(tenant_id,id)
);
CREATE INDEX unit_facility ON domain.reservable_unit(tenant_id,facility_id);
CREATE TABLE domain.catalog_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES auth."user"(id),
  facility_id uuid NOT NULL,
  unit_id uuid,
  operation text NOT NULL CHECK (operation IN ('CREATE_FACILITY','CREATE_UNIT')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,facility_id) REFERENCES domain.facility(tenant_id,id),
  FOREIGN KEY (tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id)
);
ALTER TABLE domain.facility ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.facility FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.reservable_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservable_unit FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.catalog_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.catalog_event FORCE ROW LEVEL SECURITY;
CREATE POLICY facility_maintenance ON domain.facility TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY unit_maintenance ON domain.reservable_unit TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY catalog_event_maintenance ON domain.catalog_event TO quenda_migrator USING (true) WITH CHECK (true);
CREATE POLICY facility_read ON domain.facility FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.current_is_administrator());
CREATE POLICY facility_create ON domain.facility FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_current_administrator());
CREATE POLICY unit_read ON domain.reservable_unit FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.current_is_administrator());
CREATE POLICY unit_create ON domain.reservable_unit FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_current_administrator());
CREATE POLICY catalog_event_read ON domain.catalog_event FOR SELECT TO quenda_domain
  USING (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.current_is_administrator());
CREATE POLICY catalog_event_append ON domain.catalog_event FOR INSERT TO quenda_domain
  WITH CHECK (tenant_id = nullif(current_setting('quenda.tenant_id',true),'')::uuid
    AND actor_id = nullif(current_setting('quenda.account_id',true),'') AND domain.lock_current_administrator());
GRANT SELECT,INSERT ON domain.facility,domain.reservable_unit,domain.catalog_event TO quenda_domain;
