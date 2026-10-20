CREATE TABLE domain.monthly_assessment (
 agreement_id uuid NOT NULL REFERENCES domain.agreement(id),
 month_start date NOT NULL CHECK(isfinite(month_start) AND extract(day FROM month_start)=1),
 revision integer NOT NULL CHECK(revision>0),
 cutoff timestamptz NOT NULL CHECK(isfinite(cutoff)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 control_version integer NOT NULL CHECK(control_version>0),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 participants uuid[] NOT NULL,
 status text NOT NULL CHECK(status IN ('THRESHOLD_MET','NOT_PUBLISHABLE')),
 reservations integer CHECK(reservations>=0),
 reserved_minutes double precision CHECK(reserved_minutes>=0 AND reserved_minutes<'Infinity'::float8),
 PRIMARY KEY(agreement_id,month_start,revision),
 CHECK((status='NOT_PUBLISHABLE' AND reservations IS NULL AND reserved_minutes IS NULL)
  OR (status='THRESHOLD_MET' AND reservations IS NOT NULL AND reserved_minutes IS NOT NULL))
);
ALTER TABLE domain.monthly_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.monthly_assessment FORCE ROW LEVEL SECURITY;
CREATE POLICY monthly_assessment_maintenance ON domain.monthly_assessment TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON domain.monthly_assessment FROM PUBLIC,quenda_domain,quenda_worker,quenda_auth;
CREATE FUNCTION domain.monthly_assessment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Assessment is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER monthly_assessment_immutable BEFORE UPDATE OR DELETE ON domain.monthly_assessment FOR EACH ROW EXECUTE FUNCTION domain.monthly_assessment_immutable();
REVOKE ALL ON FUNCTION domain.monthly_assessment_immutable() FROM PUBLIC;

CREATE FUNCTION domain.lock_monthly_assessment(agreement uuid,month_date date,expected_revision integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_revision integer; zone text;
BEGIN
 SELECT a.timezone INTO zone FROM domain.agreement a WHERE a.id=agreement FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF month_date IS NULL OR NOT isfinite(month_date) OR extract(day FROM month_date)<>1 OR expected_revision IS NULL OR expected_revision<0
 OR (month_date+interval '1 month') AT TIME ZONE zone > statement_timestamp() THEN RAISE EXCEPTION 'Invalid assessment period' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(s.revision),0) INTO current_revision FROM domain.monthly_assessment s WHERE s.agreement_id=agreement AND s.month_start=month_date;
 IF current_revision<>expected_revision THEN RAISE EXCEPTION 'Stale assessment revision' USING ERRCODE='P0001'; END IF;
END $$;
REVOKE ALL ON FUNCTION domain.lock_monthly_assessment(uuid,date,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.lock_monthly_assessment(uuid,date,integer) TO quenda_worker;

CREATE FUNCTION domain.record_monthly_assessment(agreement uuid,month_date date,expected_revision integer,source jsonb,assessment jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cutoff timestamptz; state text; count_value integer; minutes_value double precision; participants uuid[];
BEGIN
 PERFORM domain.lock_monthly_assessment(agreement,month_date,expected_revision);
 cutoff:=(source->>'asOf')::timestamptz;
 state:=assessment->>'status';
 IF cutoff IS NULL OR NOT isfinite(cutoff) OR cutoff<transaction_timestamp() OR cutoff>clock_timestamp()
 OR source->>'month' IS DISTINCT FROM to_char(month_date,'YYYY-MM')
 OR jsonb_typeof(source->'participants') IS DISTINCT FROM 'array'
 OR state IS NULL OR state NOT IN ('THRESHOLD_MET','NOT_PUBLISHABLE') THEN RAISE EXCEPTION 'Invalid assessment' USING ERRCODE='23514'; END IF;
 IF state='THRESHOLD_MET' THEN
  IF NOT assessment ?& ARRAY['status','reservations','reservedMinutes'] OR (assessment-ARRAY['status','reservations','reservedMinutes'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid assessment' USING ERRCODE='23514'; END IF;
  count_value:=(assessment->>'reservations')::integer;
  minutes_value:=(assessment->>'reservedMinutes')::double precision;
 ELSE
  IF assessment<>jsonb_build_object('status','NOT_PUBLISHABLE') THEN RAISE EXCEPTION 'Suppressed values are forbidden' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT coalesce(array_agg(value::uuid ORDER BY value::uuid),'{}'::uuid[]) INTO participants FROM jsonb_array_elements_text(source->'participants');
 INSERT INTO domain.monthly_assessment(agreement_id,month_start,revision,cutoff,control_version,source_digest,participants,status,reservations,reserved_minutes)
 VALUES(agreement,month_date,expected_revision+1,cutoff,1,encode(sha256(convert_to(source::text,'UTF8')),'hex'),participants,state,count_value,minutes_value);
 RETURN expected_revision+1;
END $$;
REVOKE ALL ON FUNCTION domain.record_monthly_assessment(uuid,date,integer,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.record_monthly_assessment(uuid,date,integer,jsonb,jsonb) TO quenda_worker;
