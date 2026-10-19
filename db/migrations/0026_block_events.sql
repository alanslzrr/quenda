CREATE TABLE domain.block_event (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 block_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 operation text NOT NULL CHECK(operation IN ('CREATE','RELEASE')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 correlation_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,block_id,operation),
 FOREIGN KEY(tenant_id,block_id) REFERENCES domain.schedule_block(tenant_id,id)
);
ALTER TABLE domain.block_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.block_event FORCE ROW LEVEL SECURITY;
CREATE POLICY block_event_maintenance ON domain.block_event TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY block_event_read ON domain.block_event FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM domain.schedule_block b WHERE (b.tenant_id,b.id)=(block_event.tenant_id,block_event.block_id)));
CREATE POLICY block_event_create ON domain.block_event FOR INSERT TO quenda_domain WITH CHECK(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),'')
 AND EXISTS(SELECT 1 FROM domain.schedule_block b WHERE (b.tenant_id,b.id)=(block_event.tenant_id,block_event.block_id)
  AND domain.lock_permission('UNIT_BLOCK',b.unit_id)
  AND ((block_event.operation='CREATE' AND b.released_at IS NULL) OR (block_event.operation='RELEASE' AND b.released_at IS NOT NULL))));
GRANT SELECT,INSERT ON domain.block_event TO quenda_domain;
