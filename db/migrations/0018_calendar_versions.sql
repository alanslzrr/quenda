CREATE TABLE domain.unit_calendar_version (
 tenant_id uuid NOT NULL,
 unit_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 minimum_minutes integer NOT NULL CHECK(minimum_minutes>0),
 maximum_minutes integer NOT NULL CHECK(maximum_minutes>0),
 step_minutes integer NOT NULL CHECK(step_minutes>0),
 advance_days integer CHECK(advance_days>=0),
 weekly jsonb NOT NULL CHECK(jsonb_typeof(weekly)='array'),
 exceptions jsonb NOT NULL CHECK(jsonb_typeof(exceptions)='array'),
 actor_id text NOT NULL REFERENCES auth."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,unit_id,version),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 CHECK(minimum_minutes<=maximum_minutes),
 CHECK(minimum_minutes%step_minutes=0 AND maximum_minutes%step_minutes=0)
);
ALTER TABLE domain.unit_calendar_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.unit_calendar_version FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_maintenance ON domain.unit_calendar_version TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY calendar_read ON domain.unit_calendar_version FOR SELECT TO quenda_domain
 USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',unit_id));
CREATE POLICY calendar_append ON domain.unit_calendar_version FOR INSERT TO quenda_domain
 WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND actor_id=nullif(current_setting('quenda.account_id',true),'') AND domain.lock_permission('CATALOG_MANAGE',unit_id));
GRANT SELECT,INSERT ON domain.unit_calendar_version TO quenda_domain;
-- Immutable version rows are also the audit evidence for configuration changes.
ALTER TABLE domain.reservable_unit ADD COLUMN calendar_version integer;
ALTER TABLE domain.reservable_unit ADD FOREIGN KEY(tenant_id,id,calendar_version)
 REFERENCES domain.unit_calendar_version(tenant_id,unit_id,version);
GRANT UPDATE(calendar_version) ON domain.reservable_unit TO quenda_domain;
