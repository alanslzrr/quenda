CREATE TABLE domain.reservation (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 account_id text NOT NULL,
 unit_id uuid NOT NULL,
 calendar_version integer NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'CONFIRMADA' CHECK(status IN ('CONFIRMADA','CANCELADA')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 cancellation_minutes integer NOT NULL CHECK(cancellation_minutes>=0),
 timezone text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES domain.municipal_profile(tenant_id,account_id),
 FOREIGN KEY(tenant_id,unit_id,calendar_version) REFERENCES domain.unit_calendar_version(tenant_id,unit_id,version),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at)
);
CREATE INDEX reservation_owner_history ON domain.reservation(account_id,starts_at,id);
CREATE INDEX reservation_unit_time ON domain.reservation(tenant_id,unit_id,starts_at);
CREATE TABLE domain.schedule_block (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 unit_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 actor_id text NOT NULL REFERENCES auth."user"(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 released_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at)
);
CREATE TABLE domain.occupancy (
 tenant_id uuid NOT NULL,
 id uuid NOT NULL,
 unit_id uuid NOT NULL,
 reservation_id uuid,
 block_id uuid,
 period tstzrange NOT NULL,
 released_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES domain.reservable_unit(tenant_id,id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES domain.reservation(tenant_id,id),
 FOREIGN KEY(tenant_id,block_id) REFERENCES domain.schedule_block(tenant_id,id),
 CHECK((reservation_id IS NOT NULL)::integer+(block_id IS NOT NULL)::integer=1),
 CHECK(NOT isempty(period) AND NOT lower_inf(period) AND NOT upper_inf(period)
   AND isfinite(lower(period)) AND isfinite(upper(period)) AND lower_inc(period) AND NOT upper_inc(period)),
 EXCLUDE USING gist(tenant_id extensions.gist_uuid_ops WITH =,unit_id extensions.gist_uuid_ops WITH =,period WITH &&) WHERE(released_at IS NULL)
);
CREATE UNIQUE INDEX reservation_one_active_occupancy ON domain.occupancy(tenant_id,reservation_id) WHERE released_at IS NULL AND reservation_id IS NOT NULL;
CREATE UNIQUE INDEX block_one_active_occupancy ON domain.occupancy(tenant_id,block_id) WHERE released_at IS NULL AND block_id IS NOT NULL;

ALTER TABLE domain.reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.schedule_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.schedule_block FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.occupancy ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.occupancy FORCE ROW LEVEL SECURITY;
CREATE POLICY reservation_maintenance ON domain.reservation TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY block_maintenance ON domain.schedule_block TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY occupancy_maintenance ON domain.occupancy TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY reservation_read ON domain.reservation FOR SELECT TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND
 (account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_READ',unit_id) OR domain.lock_permission('RESERVATION_MANAGE',unit_id)));
CREATE POLICY reservation_create ON domain.reservation FOR INSERT TO quenda_domain WITH CHECK(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND account_id=nullif(current_setting('quenda.account_id',true),''));
CREATE POLICY reservation_change ON domain.reservation FOR UPDATE TO quenda_domain USING(
 tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND (account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_MANAGE',unit_id)))
 WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND (account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_MANAGE',unit_id)));
CREATE POLICY block_read ON domain.schedule_block FOR SELECT TO quenda_domain USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('UNIT_BLOCK',unit_id));
CREATE POLICY block_create ON domain.schedule_block FOR INSERT TO quenda_domain WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND actor_id=nullif(current_setting('quenda.account_id',true),'') AND domain.lock_permission('UNIT_BLOCK',unit_id));
CREATE POLICY block_change ON domain.schedule_block FOR UPDATE TO quenda_domain USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('UNIT_BLOCK',unit_id)) WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND domain.lock_permission('UNIT_BLOCK',unit_id));
CREATE POLICY occupancy_read ON domain.occupancy FOR SELECT TO quenda_domain USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND
 ((reservation_id IS NOT NULL AND EXISTS(SELECT 1 FROM domain.reservation r WHERE (r.tenant_id,r.id)=(occupancy.tenant_id,occupancy.reservation_id))) OR domain.lock_permission('UNIT_BLOCK',unit_id)));
CREATE POLICY occupancy_create ON domain.occupancy FOR INSERT TO quenda_domain WITH CHECK(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND
 ((reservation_id IS NOT NULL AND EXISTS(SELECT 1 FROM domain.reservation r WHERE (r.tenant_id,r.id)=(occupancy.tenant_id,occupancy.reservation_id) AND (r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)))) OR (block_id IS NOT NULL AND domain.lock_permission('UNIT_BLOCK',unit_id))));
CREATE POLICY occupancy_release ON domain.occupancy FOR UPDATE TO quenda_domain USING(tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid AND
 ((reservation_id IS NOT NULL AND EXISTS(SELECT 1 FROM domain.reservation r WHERE (r.tenant_id,r.id)=(occupancy.tenant_id,occupancy.reservation_id) AND (r.account_id=nullif(current_setting('quenda.account_id',true),'') OR domain.lock_permission('RESERVATION_MANAGE',r.unit_id)))) OR (block_id IS NOT NULL AND domain.lock_permission('UNIT_BLOCK',unit_id))));
GRANT SELECT,INSERT ON domain.reservation,domain.schedule_block,domain.occupancy TO quenda_domain;
GRANT UPDATE(unit_id,calendar_version,starts_at,ends_at,status,revision,cancellation_minutes,timezone) ON domain.reservation TO quenda_domain;
GRANT UPDATE(released_at) ON domain.schedule_block,domain.occupancy TO quenda_domain;

CREATE FUNCTION domain.assert_occupancy_origin(tenant uuid,reservation uuid,block uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE origin_unit uuid; expected_period tstzrange; needs_active boolean; active_count bigint; matching_count bigint;
BEGIN
 IF reservation IS NOT NULL THEN
   SELECT r.unit_id,tstzrange(r.starts_at,r.ends_at,'[)'),r.status='CONFIRMADA' INTO origin_unit,expected_period,needs_active FROM domain.reservation r WHERE r.tenant_id=tenant AND r.id=reservation;
 ELSE
   SELECT b.unit_id,tstzrange(b.starts_at,b.ends_at,'[)'),b.released_at IS NULL INTO origin_unit,expected_period,needs_active FROM domain.schedule_block b WHERE b.tenant_id=tenant AND b.id=block;
 END IF;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT count(*),count(*) FILTER(WHERE o.unit_id=origin_unit AND o.period=expected_period) INTO active_count,matching_count
 FROM domain.occupancy o WHERE o.tenant_id=tenant AND o.released_at IS NULL AND ((reservation IS NOT NULL AND o.reservation_id=reservation) OR (block IS NOT NULL AND o.block_id=block));
 IF (needs_active AND (active_count<>1 OR matching_count<>1)) OR (NOT needs_active AND active_count<>0) THEN
   RAISE EXCEPTION 'Inconsistent occupancy' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION domain.check_occupancy_coherence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='reservation' THEN
   PERFORM domain.assert_occupancy_origin(NEW.tenant_id,NEW.id,NULL);
 ELSIF TG_TABLE_NAME='schedule_block' THEN
   PERFORM domain.assert_occupancy_origin(NEW.tenant_id,NULL,NEW.id);
 ELSE
   IF TG_OP<>'INSERT' THEN PERFORM domain.assert_occupancy_origin(OLD.tenant_id,OLD.reservation_id,OLD.block_id); END IF;
   IF TG_OP<>'DELETE' THEN PERFORM domain.assert_occupancy_origin(NEW.tenant_id,NEW.reservation_id,NEW.block_id); END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.assert_occupancy_origin(uuid,uuid,uuid),domain.check_occupancy_coherence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER reservation_coherence AFTER INSERT OR UPDATE ON domain.reservation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_occupancy_coherence();
CREATE CONSTRAINT TRIGGER block_coherence AFTER INSERT OR UPDATE ON domain.schedule_block DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_occupancy_coherence();
CREATE CONSTRAINT TRIGGER occupancy_coherence AFTER INSERT OR UPDATE OR DELETE ON domain.occupancy DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_occupancy_coherence();
