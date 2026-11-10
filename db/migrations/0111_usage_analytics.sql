-- Booking facts behind the usage analysis of a unit, or of every unit when
-- selected_unit is NULL: reservations that overlap the local period, when they
-- were made, who cancelled them and whether an arrival was recorded. Holders are
-- never returned; results leave the API only as aggregates.
CREATE FUNCTION domain.usage_analytics_source(selected_unit uuid,from_date date,to_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 zone text; first_instant timestamptz; last_instant timestamptz; result jsonb;
BEGIN
 IF NOT domain.lock_permission('REPORT_READ',selected_unit) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF from_date IS NULL OR to_date IS NULL OR NOT isfinite(from_date) OR NOT isfinite(to_date) OR to_date-from_date NOT BETWEEN 1 AND 366 THEN
  RAISE EXCEPTION 'Invalid period' USING ERRCODE='23514';
 END IF;
 SELECT m.timezone INTO zone FROM domain.municipality m WHERE m.id=tenant;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 IF selected_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domain.reservable_unit u WHERE u.tenant_id=tenant AND u.id=selected_unit) THEN
  RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';
 END IF;
 first_instant:=from_date::timestamp AT TIME ZONE zone;
 last_instant:=to_date::timestamp AT TIME ZONE zone;
 IF (SELECT count(*) FROM domain.reservation r WHERE r.tenant_id=tenant AND (selected_unit IS NULL OR r.unit_id=selected_unit)
  AND r.starts_at<last_instant AND r.ends_at>first_instant)>20000 THEN
  RAISE EXCEPTION 'Report period too large' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',r.unit_id,'start',r.starts_at,'end',r.ends_at,'status',r.status,
  'createdAt',r.created_at,'arrived',r.arrived_at IS NOT NULL,
  'cancelledByHolder',CASE WHEN r.status='CANCELADA' THEN c.actor_id=r.account_id END)),'[]'::jsonb)
 INTO result
 FROM domain.reservation r
 LEFT JOIN LATERAL (SELECT e.actor_id FROM domain.reservation_event e
  WHERE e.tenant_id=r.tenant_id AND e.reservation_id=r.id AND e.kind='CANCELADA' ORDER BY e.revision DESC LIMIT 1) c ON true
 WHERE r.tenant_id=tenant AND (selected_unit IS NULL OR r.unit_id=selected_unit)
 AND r.starts_at<last_instant AND r.ends_at>first_instant;
 RETURN jsonb_build_object('timeZone',zone,'asOf',statement_timestamp(),'reservations',result,
  'unitNames',(SELECT coalesce(jsonb_object_agg(u.id,u.name),'{}'::jsonb) FROM domain.reservable_unit u
   WHERE u.tenant_id=tenant AND (selected_unit IS NULL OR u.id=selected_unit)));
END $$;
REVOKE ALL ON FUNCTION domain.usage_analytics_source(uuid,date,date) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.usage_analytics_source(uuid,date,date) TO quenda_domain;
