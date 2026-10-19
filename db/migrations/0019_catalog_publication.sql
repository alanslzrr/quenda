ALTER TABLE domain.facility ADD COLUMN published_at timestamptz;
ALTER TABLE domain.reservable_unit ADD COLUMN published_at timestamptz;
ALTER TABLE domain.reservable_unit ADD CHECK(published_at IS NULL OR calendar_version IS NOT NULL);
GRANT UPDATE(published_at) ON domain.facility,domain.reservable_unit TO quenda_domain;
ALTER TABLE domain.catalog_event ADD COLUMN calendar_version integer;
ALTER TABLE domain.catalog_event ADD COLUMN independence_confirmed boolean;
ALTER TABLE domain.catalog_event ADD FOREIGN KEY(tenant_id,unit_id,calendar_version) REFERENCES domain.unit_calendar_version(tenant_id,unit_id,version);
ALTER TABLE domain.catalog_event DROP CONSTRAINT catalog_event_operation_check;
ALTER TABLE domain.catalog_event ADD CHECK(operation IN ('CREATE_FACILITY','CREATE_UNIT','RENAME_FACILITY','RENAME_UNIT','WITHDRAW_FACILITY','WITHDRAW_UNIT','PUBLISH_FACILITY','PUBLISH_UNIT'));
ALTER TABLE domain.catalog_event ADD CHECK(operation NOT IN ('PUBLISH_FACILITY','PUBLISH_UNIT') OR (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500));
ALTER TABLE domain.catalog_event ADD CHECK(operation<>'PUBLISH_UNIT' OR (calendar_version IS NOT NULL AND independence_confirmed IS TRUE));
ALTER POLICY catalog_event_append ON domain.catalog_event WITH CHECK (
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),'')
 AND ((operation IN ('CREATE_FACILITY','CREATE_UNIT') AND domain.lock_permission('CATALOG_CREATE',NULL))
 OR (operation IN ('RENAME_FACILITY','WITHDRAW_FACILITY','PUBLISH_FACILITY') AND unit_id IS NULL AND domain.lock_permission('CATALOG_MANAGE',NULL))
 OR (operation IN ('RENAME_UNIT','WITHDRAW_UNIT','PUBLISH_UNIT') AND unit_id IS NOT NULL AND domain.lock_permission('CATALOG_MANAGE',unit_id))));
-- Scoped unit managers can verify and lock the parent without obtaining
-- municipality-wide facility access or edit privileges.
CREATE FUNCTION domain.lock_publication_parent(resource uuid) RETURNS TABLE(published_at timestamptz,withdrawn_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT domain.lock_permission('CATALOG_MANAGE',resource) THEN RETURN; END IF;
 RETURN QUERY SELECT f.published_at,f.withdrawn_at FROM domain.facility f
 JOIN domain.reservable_unit u ON (u.tenant_id,u.facility_id)=(f.tenant_id,f.id)
 WHERE u.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND u.id=resource FOR SHARE OF f;
END $$;
REVOKE ALL ON FUNCTION domain.lock_publication_parent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_publication_parent(uuid) TO quenda_domain;
