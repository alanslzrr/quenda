-- Internal projection for assessment; it is not a publishable report.
CREATE FUNCTION domain.monthly_report_source(agreement uuid,month_start date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE zone text; first_instant timestamptz; last_instant timestamptz; observed timestamptz:=statement_timestamp();
 participants jsonb; scopes jsonb; bookings jsonb;
BEGIN
 SELECT a.timezone INTO zone FROM domain.agreement a WHERE a.id=agreement FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF month_start IS NULL OR NOT isfinite(month_start) OR extract(day FROM month_start)<>1 THEN
  RAISE EXCEPTION 'Invalid month' USING ERRCODE='23514';
 END IF;
 first_instant:=month_start::timestamp AT TIME ZONE zone;
 last_instant:=(month_start+interval '1 month') AT TIME ZONE zone;
 IF last_instant>observed THEN RAISE EXCEPTION 'Month is not closed' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(p.tenant_id ORDER BY p.tenant_id),'[]'::jsonb) INTO participants FROM (
  SELECT DISTINCT p.tenant_id FROM domain.agreement_participant p
  JOIN domain.agreement_version v ON (v.agreement_id,v.version)=(p.agreement_id,p.version)
  JOIN domain.agreement_activation a ON (a.agreement_id,a.version)=(v.agreement_id,v.version)
  WHERE p.agreement_id=agreement AND v.aggregate_reports AND a.effective_period && tstzrange(first_instant,last_instant,'[)')
 ) p;
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',a.tenant_id,'unitId',a.unit_id,'start',lower(a.effective_period),'end',upper(a.effective_period)) ORDER BY a.version,a.tenant_id,a.unit_id),'[]'::jsonb)
 INTO scopes FROM domain.agreement_assignment a JOIN domain.agreement_version v ON (v.agreement_id,v.version)=(a.agreement_id,a.version)
 WHERE a.agreement_id=agreement AND v.aggregate_reports AND a.effective_period && tstzrange(first_instant,last_instant,'[)');
 SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId',c.tenant_id,'unitId',c.unit_id,'reservationId',c.reservation_id,'subjectId',c.subject_id,'start',c.starts_at,'end',c.ends_at,'released',false) ORDER BY c.tenant_id,c.reservation_id),'[]'::jsonb)
 INTO bookings FROM (
  SELECT c.* FROM domain.agreement_consumption c WHERE c.agreement_id=agreement AND NOT c.released AND c.starts_at<last_instant AND c.ends_at>first_instant
  AND EXISTS(SELECT 1 FROM domain.agreement_assignment a JOIN domain.agreement_version v ON (v.agreement_id,v.version)=(a.agreement_id,a.version)
   WHERE a.agreement_id=agreement AND a.tenant_id=c.tenant_id AND a.unit_id=c.unit_id AND v.aggregate_reports
   AND a.effective_period && (tstzrange(c.starts_at,c.ends_at,'[)') * tstzrange(first_instant,last_instant,'[)')))
  ORDER BY c.tenant_id,c.reservation_id LIMIT 100001
 ) c;
 IF jsonb_array_length(bookings)>100000 THEN RAISE EXCEPTION 'Report exceeds processing limit' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('month',to_char(month_start,'YYYY-MM'),'timeZone',zone,'asOf',observed,'participants',participants,'scopes',scopes,'reservations',bookings);
END $$;
REVOKE ALL ON FUNCTION domain.monthly_report_source(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.monthly_report_source(uuid,date) TO quenda_worker;
