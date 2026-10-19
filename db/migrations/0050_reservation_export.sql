CREATE FUNCTION domain.reservation_export(from_date date,to_date date,unit uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 zone text; first_instant timestamptz; last_instant timestamptz; observed timestamptz:=statement_timestamp(); items jsonb;
BEGIN
 IF NOT domain.lock_permission('DATA_EXPORT',unit) OR NOT (domain.lock_permission('RESERVATION_READ',unit) OR domain.lock_permission('RESERVATION_MANAGE',unit)) THEN
  RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';
 END IF;
 IF from_date IS NULL OR to_date IS NULL OR NOT isfinite(from_date) OR NOT isfinite(to_date) OR to_date-from_date NOT BETWEEN 1 AND 366 THEN
  RAISE EXCEPTION 'Invalid period' USING ERRCODE='23514';
 END IF;
 SELECT m.timezone INTO zone FROM domain.municipality m WHERE m.id=tenant;
 IF NOT FOUND OR (unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.reservable_unit u WHERE u.tenant_id=tenant AND u.id=unit)) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 first_instant:=from_date::timestamp AT TIME ZONE zone;
 last_instant:=to_date::timestamp AT TIME ZONE zone;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'unitId',r.unit_id,'accountId',r.account_id,
  'startsAt',r.starts_at,'endsAt',r.ends_at,'status',CASE WHEN r.status='CONFIRMADA' AND r.ends_at<=observed THEN 'FINALIZADA' ELSE r.status END,
  'revision',r.revision,'calendarVersion',r.calendar_version,'cancellationMinutes',r.cancellation_minutes,'timeZone',r.timezone) ORDER BY r.id),'[]'::jsonb)
 INTO items FROM (SELECT * FROM domain.reservation r WHERE r.tenant_id=tenant AND (unit IS NULL OR r.unit_id=unit)
  AND r.starts_at<last_instant AND r.ends_at>first_instant ORDER BY r.id LIMIT 10001) r;
 IF jsonb_array_length(items)>10000 THEN RAISE EXCEPTION 'Export period too large' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('format','quenda.reservations','version',1,'tenantId',tenant,'unitId',unit,'generatedAt',observed,
  'period',jsonb_build_object('from',from_date,'to',to_date,'timeZone',zone,'selection','overlap'),
  'entities',jsonb_build_array('reservations'),'reservations',items);
END $$;
REVOKE ALL ON FUNCTION domain.reservation_export(date,date,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.reservation_export(date,date,uuid) TO quenda_domain;
