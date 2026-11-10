-- Results are recoverable only inside their window. Expired rows are removed
-- in bounded batches by the worker instead of accumulating indefinitely.
CREATE FUNCTION domain.purge_expired_idempotent_commands(batch integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
 IF batch IS NULL OR batch NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid batch' USING ERRCODE='22023'; END IF;
 WITH expired AS (
  SELECT c.tenant_id,c.actor_id,c.operation,c.key FROM domain.idempotent_command c
  WHERE c.expires_at<=clock_timestamp() ORDER BY c.expires_at LIMIT batch FOR UPDATE SKIP LOCKED
 ) DELETE FROM domain.idempotent_command c USING expired e
  WHERE (c.tenant_id,c.actor_id,c.operation,c.key)=(e.tenant_id,e.actor_id,e.operation,e.key);
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION domain.purge_expired_idempotent_commands(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain.purge_expired_idempotent_commands(integer) TO quenda_worker;
