ALTER TABLE domain.catalog_event ADD COLUMN previous_name text;
ALTER TABLE domain.catalog_event ADD COLUMN new_name text;
ALTER TABLE domain.catalog_event DROP CONSTRAINT catalog_event_operation_check;
ALTER TABLE domain.catalog_event ADD CHECK (operation IN ('CREATE_FACILITY','CREATE_UNIT','RENAME_FACILITY','RENAME_UNIT'));
ALTER TABLE domain.catalog_event ADD CHECK (operation NOT IN ('RENAME_FACILITY','RENAME_UNIT') OR (previous_name IS NOT NULL AND new_name IS NOT NULL));
ALTER POLICY facility_read ON domain.facility USING (
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND (domain.lock_permission('CATALOG_CREATE',NULL) OR domain.lock_permission('CATALOG_MANAGE',NULL)));
CREATE POLICY facility_change ON domain.facility FOR UPDATE TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',NULL))
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',NULL));
CREATE POLICY unit_change ON domain.reservable_unit FOR UPDATE TO quenda_domain
 USING (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',id))
 WITH CHECK (tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_MANAGE',id));
GRANT UPDATE(name) ON domain.facility,domain.reservable_unit TO quenda_domain;
ALTER POLICY catalog_event_append ON domain.catalog_event WITH CHECK (
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND actor_id=nullif(current_setting('quenda.account_id',true),'')
 AND ((operation IN ('CREATE_FACILITY','CREATE_UNIT') AND domain.lock_permission('CATALOG_CREATE',NULL))
   OR (operation='RENAME_FACILITY' AND unit_id IS NULL AND domain.lock_permission('CATALOG_MANAGE',NULL))
   OR (operation='RENAME_UNIT' AND unit_id IS NOT NULL AND domain.lock_permission('CATALOG_MANAGE',unit_id))));
