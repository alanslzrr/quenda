ALTER TABLE domain.facility ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE domain.reservable_unit ADD COLUMN withdrawn_at timestamptz;
GRANT UPDATE(withdrawn_at) ON domain.facility,domain.reservable_unit TO quenda_domain;
ALTER TABLE domain.catalog_event ADD COLUMN reason text;
ALTER TABLE domain.catalog_event DROP CONSTRAINT catalog_event_operation_check;
ALTER TABLE domain.catalog_event ADD CHECK (operation IN ('CREATE_FACILITY','CREATE_UNIT','RENAME_FACILITY','RENAME_UNIT','WITHDRAW_FACILITY','WITHDRAW_UNIT'));
ALTER TABLE domain.catalog_event ADD CHECK (operation NOT IN ('WITHDRAW_FACILITY','WITHDRAW_UNIT') OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500));
-- SELECT FOR SHARE also applies UPDATE RLS policies. A creator must be able
-- to lock its parent without gaining facility-edit authority.
CREATE FUNCTION domain.lock_catalog_parent(parent uuid) RETURNS TABLE(withdrawn_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_permission('CATALOG_CREATE',NULL) THEN RETURN; END IF;
 RETURN QUERY SELECT f.withdrawn_at FROM domain.facility f
 WHERE f.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND f.id=parent FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION domain.lock_catalog_parent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_catalog_parent(uuid) TO quenda_domain;
ALTER POLICY unit_create ON domain.reservable_unit WITH CHECK (
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('CATALOG_CREATE',NULL)
 AND EXISTS (SELECT 1 FROM domain.lock_catalog_parent(facility_id) f WHERE f.withdrawn_at IS NULL));
ALTER POLICY catalog_event_append ON domain.catalog_event WITH CHECK (
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND actor_id=nullif(current_setting('quenda.account_id',true),'')
 AND ((operation IN ('CREATE_FACILITY','CREATE_UNIT') AND domain.lock_permission('CATALOG_CREATE',NULL))
   OR (operation IN ('RENAME_FACILITY','WITHDRAW_FACILITY') AND unit_id IS NULL AND domain.lock_permission('CATALOG_MANAGE',NULL))
   OR (operation IN ('RENAME_UNIT','WITHDRAW_UNIT') AND unit_id IS NOT NULL AND domain.lock_permission('CATALOG_MANAGE',unit_id))));
