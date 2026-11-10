-- Keyset agenda pages stop after the requested rows instead of sorting and
-- checking permissions across the municipality's entire historical catalogue.
CREATE INDEX reservation_municipal_chronology ON domain.reservation(tenant_id,starts_at,id);
CREATE INDEX schedule_block_municipal_chronology ON domain.schedule_block(tenant_id,starts_at,id);
