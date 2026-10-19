-- Positional parameters distinguish agreement version from reservation.revision.
CREATE OR REPLACE FUNCTION domain.project_agreement_reservations(agreement uuid,revision integer)
RETURNS TABLE(reservation_id uuid,account_id text,unit_id uuid,starts_at timestamptz,ends_at timestamptz)
LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT r.id,r.account_id,r.unit_id,r.starts_at,r.ends_at
 FROM domain.reservation r
 JOIN domain.agreement_unit u ON u.tenant_id=r.tenant_id AND u.unit_id=r.unit_id AND u.agreement_id=$1 AND u.version=$2
 JOIN domain.agreement_version v ON v.agreement_id=u.agreement_id AND v.version=u.version
 JOIN domain.agreement_approval p ON p.agreement_id=u.agreement_id AND p.version=u.version AND p.tenant_id=u.tenant_id
 WHERE r.tenant_id=nullif(current_setting('quenda.tenant_id',true),'')::uuid
 AND r.status='CONFIRMADA' AND r.starts_at>=v.starts_at AND r.ends_at<=v.ends_at
 ORDER BY r.id FOR SHARE OF r
$$;
REVOKE ALL ON FUNCTION domain.project_agreement_reservations(uuid,integer) FROM PUBLIC;

ALTER TABLE domain.agreement_lifecycle_event ADD COLUMN previous_period tstzrange;
ALTER TABLE domain.agreement_lifecycle_event ADD COLUMN effective_period tstzrange;
ALTER TABLE domain.agreement_lifecycle_event DROP CONSTRAINT agreement_lifecycle_event_action_check;
ALTER TABLE domain.agreement_lifecycle_event ADD CHECK(action IN ('ACTIVATED','SUSPENDED','REPLACED'));

CREATE OR REPLACE FUNCTION domain.activate_agreement(agreement uuid,revision integer,legal_reference text,report_reference text,correlation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE original_tenant text:=current_setting('quenda.tenant_id',true);
 tenant uuid:=nullif(original_tenant,'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),'');
 rule domain.agreement_version%ROWTYPE; scope uuid; booking record; subject uuid; week date; zone text; period tstzrange; previous record; closed_period tstzrange;
BEGIN
 IF NOT domain.lock_current_administrator() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision AND p.tenant_id=tenant) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 PERFORM 1 FROM domain.agreement a WHERE a.id=agreement FOR UPDATE;
 SELECT v.* INTO rule FROM domain.agreement_version v WHERE v.agreement_id=agreement AND v.version=revision FOR UPDATE;
 IF rule.status<>'APROBADO' OR revision<>(SELECT a.latest_version FROM domain.agreement a WHERE a.id=agreement)
 OR rule.ends_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM domain.agreement_activation a WHERE a.agreement_id=agreement AND a.version=revision) THEN
  RAISE EXCEPTION 'Activation unavailable' USING ERRCODE='23514';
 END IF;
 IF legal_reference IS NULL OR length(btrim(legal_reference)) NOT BETWEEN 1 AND 500
 OR (rule.aggregate_reports AND (report_reference IS NULL OR length(btrim(report_reference)) NOT BETWEEN 1 AND 500)) THEN
  RAISE EXCEPTION 'Review reference required' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM domain.agreement_unit u WHERE u.agreement_id=agreement AND u.version=revision)
 OR (rule.eligibility='acreditacion_vigente' AND NOT EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision AND p.accreditation_issuer))
 OR EXISTS(SELECT 1 FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision
   AND NOT EXISTS(SELECT 1 FROM domain.agreement_approval a WHERE (a.agreement_id,a.version,a.tenant_id)=(p.agreement_id,p.version,p.tenant_id))) THEN
  RAISE EXCEPTION 'Incomplete agreement configuration or approvals' USING ERRCODE='23514';
 END IF;
 period:=tstzrange(greatest(rule.starts_at,clock_timestamp()),rule.ends_at,'[)');
 SELECT a.timezone INTO zone FROM domain.agreement a WHERE a.id=agreement;
 FOR previous IN SELECT a.version,a.effective_period FROM domain.agreement_activation a
  WHERE a.agreement_id=agreement AND NOT isempty(a.effective_period) AND upper(a.effective_period)>lower(period)
  ORDER BY a.version FOR UPDATE LOOP
  closed_period:=CASE WHEN lower(previous.effective_period)>=lower(period) THEN 'empty'::tstzrange
   ELSE tstzrange(lower(previous.effective_period),lower(period),'[)') END;
  UPDATE domain.agreement_activation SET effective_period=closed_period WHERE agreement_id=agreement AND version=previous.version;
  INSERT INTO domain.agreement_lifecycle_event(id,agreement_id,version,action,actor_id,actor_tenant_id,correlation_id,previous_period,effective_period)
  VALUES(gen_random_uuid(),agreement,previous.version,'REPLACED',actor,tenant,correlation,previous.effective_period,closed_period);
 END LOOP;
 INSERT INTO domain.agreement_activation(agreement_id,version,effective_period,activated_by,correlation_id)
 VALUES(agreement,revision,period,actor,correlation);
 INSERT INTO domain.agreement_assignment(agreement_id,version,tenant_id,unit_id,effective_period)
 SELECT u.agreement_id,u.version,u.tenant_id,u.unit_id,period FROM domain.agreement_unit u WHERE u.agreement_id=agreement AND u.version=revision ORDER BY u.tenant_id,u.unit_id;
 INSERT INTO domain.unit_agreement_gate(tenant_id,unit_id,agreement_id,version)
 SELECT u.tenant_id,u.unit_id,u.agreement_id,u.version FROM domain.agreement_unit u WHERE u.agreement_id=agreement AND u.version=revision
 ON CONFLICT(tenant_id,unit_id) DO UPDATE SET agreement_id=EXCLUDED.agreement_id,version=EXCLUDED.version;
 FOR scope IN SELECT p.tenant_id FROM domain.agreement_participant p WHERE p.agreement_id=agreement AND p.version=revision ORDER BY p.tenant_id LOOP
  PERFORM set_config('quenda.tenant_id',scope::text,true);
  FOR booking IN SELECT * FROM domain.project_agreement_reservations(agreement,revision) LOOP
   INSERT INTO domain.agreement_subject(agreement_id,id,account_id) VALUES(agreement,gen_random_uuid(),booking.account_id) ON CONFLICT(agreement_id,account_id) DO NOTHING;
   SELECT s.id INTO subject FROM domain.agreement_subject s WHERE s.agreement_id=agreement AND s.account_id=booking.account_id;
   week:=date_trunc('week',booking.starts_at AT TIME ZONE zone)::date;
   INSERT INTO domain.agreement_consumption(agreement_id,tenant_id,reservation_id,subject_id,attribution_version,unit_id,starts_at,ends_at,week_start)
   VALUES(agreement,scope,booking.reservation_id,subject,revision,booking.unit_id,booking.starts_at,booking.ends_at,week)
   ON CONFLICT(agreement_id,tenant_id,reservation_id) DO UPDATE SET subject_id=EXCLUDED.subject_id,
    attribution_version=EXCLUDED.attribution_version,unit_id=EXCLUDED.unit_id,starts_at=EXCLUDED.starts_at,
    ends_at=EXCLUDED.ends_at,week_start=EXCLUDED.week_start,released=false;
   INSERT INTO domain.agreement_consumption_event(id,agreement_id,subject_id,tenant_id,reservation_id,version,action,week_start,starts_at,ends_at,actor_id,correlation_id)
   VALUES(gen_random_uuid(),agreement,subject,scope,booking.reservation_id,revision,'RECONCILED',week,booking.starts_at,booking.ends_at,actor,correlation);
  END LOOP;
 END LOOP;
 PERFORM set_config('quenda.tenant_id',original_tenant,true);
 UPDATE domain.agreement_version SET status='ACTIVADO',legal_review_reference=btrim(legal_reference),report_review_reference=report_reference WHERE agreement_id=agreement AND version=revision;
 INSERT INTO domain.agreement_lifecycle_event(id,agreement_id,version,action,actor_id,actor_tenant_id,correlation_id,effective_period)
 VALUES(gen_random_uuid(),agreement,revision,'ACTIVATED',actor,tenant,correlation,period);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('quenda.tenant_id',coalesce(original_tenant,''),true);
 RAISE;
END $$;
REVOKE ALL ON FUNCTION domain.activate_agreement(uuid,integer,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.activate_agreement(uuid,integer,text,text,uuid) TO quenda_domain;
