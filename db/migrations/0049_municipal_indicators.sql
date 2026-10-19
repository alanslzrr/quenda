CREATE FUNCTION domain.municipal_indicator_source(from_date date,to_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 zone text; units jsonb;
BEGIN
 IF NOT domain.lock_permission('REPORT_READ',NULL) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF from_date IS NULL OR to_date IS NULL OR NOT isfinite(from_date) OR NOT isfinite(to_date) OR to_date-from_date NOT BETWEEN 1 AND 366 THEN
  RAISE EXCEPTION 'Invalid period' USING ERRCODE='23514';
 END IF;
 SELECT m.timezone INTO zone FROM domain.municipality m WHERE m.id=tenant;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',u.id,'source',domain.unit_indicator_source(u.id,from_date,to_date)) ORDER BY u.id),'[]'::jsonb)
 INTO units FROM domain.reservable_unit u WHERE u.tenant_id=tenant;
 RETURN jsonb_build_object('timeZone',zone,'asOf',statement_timestamp(),'units',units);
END $$;
REVOKE ALL ON FUNCTION domain.municipal_indicator_source(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.municipal_indicator_source(date,date) TO quenda_domain;
