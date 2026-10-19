CREATE TABLE domain.agreement_subject (
 agreement_id uuid NOT NULL REFERENCES domain.agreement(id),
 id uuid NOT NULL,
 account_id text NOT NULL REFERENCES auth."user"(id),
 PRIMARY KEY(agreement_id,id),
 UNIQUE(agreement_id,account_id)
);
CREATE TABLE domain.agreement_consumption (
 agreement_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 reservation_id uuid NOT NULL,
 subject_id uuid NOT NULL,
 attribution_version integer NOT NULL,
 unit_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 week_start date NOT NULL,
 released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(agreement_id,tenant_id,reservation_id),
 FOREIGN KEY(agreement_id,subject_id) REFERENCES domain.agreement_subject(agreement_id,id),
 FOREIGN KEY(tenant_id,reservation_id) REFERENCES domain.reservation(tenant_id,id),
 FOREIGN KEY(agreement_id,attribution_version,tenant_id,unit_id) REFERENCES domain.agreement_unit(agreement_id,version,tenant_id,unit_id),
 CHECK(isfinite(starts_at) AND isfinite(ends_at) AND starts_at<ends_at),
 CHECK(isfinite(week_start))
);
CREATE UNIQUE INDEX agreement_consumption_one_active ON domain.agreement_consumption(tenant_id,reservation_id) WHERE NOT released;
CREATE INDEX agreement_consumption_quota ON domain.agreement_consumption(agreement_id,subject_id,week_start) WHERE NOT released;
CREATE INDEX agreement_consumption_reservation ON domain.agreement_consumption(tenant_id,reservation_id);
ALTER TABLE domain.agreement_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_subject FORCE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.agreement_consumption FORCE ROW LEVEL SECURITY;
CREATE POLICY agreement_subject_maintenance ON domain.agreement_subject TO quenda_migrator USING(true) WITH CHECK(true);
CREATE POLICY agreement_consumption_maintenance ON domain.agreement_consumption TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.agreement_subject,domain.agreement_consumption FROM PUBLIC,quenda_domain,quenda_auth;

CREATE FUNCTION domain.assert_agreement_consumption(tenant uuid,reservation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM domain.agreement_consumption c
  JOIN domain.reservation r ON (r.tenant_id,r.id)=(c.tenant_id,c.reservation_id)
  JOIN domain.agreement_subject s ON (s.agreement_id,s.id)=(c.agreement_id,c.subject_id)
  JOIN domain.agreement a ON a.id=c.agreement_id
  WHERE c.tenant_id=tenant AND c.reservation_id=reservation AND (
   s.account_id<>r.account_id
   OR c.week_start<>date_trunc('week',c.starts_at AT TIME ZONE a.timezone)::date
   OR (NOT c.released AND (r.status<>'CONFIRMADA' OR
      (c.unit_id,c.starts_at,c.ends_at) IS DISTINCT FROM (r.unit_id,r.starts_at,r.ends_at)))
  )
 ) THEN RAISE EXCEPTION 'Inconsistent agreement consumption' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION domain.check_agreement_consumption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='reservation' THEN
  PERFORM domain.assert_agreement_consumption(NEW.tenant_id,NEW.id);
 ELSE
  IF TG_OP<>'INSERT' THEN PERFORM domain.assert_agreement_consumption(OLD.tenant_id,OLD.reservation_id); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM domain.assert_agreement_consumption(NEW.tenant_id,NEW.reservation_id); END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain.assert_agreement_consumption(uuid,uuid),domain.check_agreement_consumption() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER agreement_consumption_coherence AFTER INSERT OR UPDATE OR DELETE ON domain.agreement_consumption
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_agreement_consumption();
CREATE CONSTRAINT TRIGGER reservation_consumption_coherence AFTER INSERT OR UPDATE ON domain.reservation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION domain.check_agreement_consumption();
