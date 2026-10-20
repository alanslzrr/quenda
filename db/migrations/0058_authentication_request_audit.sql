CREATE TABLE auth.request_event (
 request_id uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('RECEIVED','RETURNED','THREW')),
 operation text NOT NULL CHECK(operation IN ('SIGN_UP','SIGN_IN','SIGN_OUT','VERIFY_EMAIL','SEND_VERIFICATION','REQUEST_RESET','RESET_PASSWORD','CHANGE_PASSWORD','UPDATE_PROFILE','REVOKE_SESSION','REVOKE_SESSIONS','REVOKE_OTHER_SESSIONS','MFA_ENABLE','MFA_DISABLE','MFA_TOTP','MFA_BACKUP','MFA_GENERATE_BACKUP','MFA_GET_URI')),
 actor_id text,
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(request_id,phase),
 CHECK((phase='RETURNED')=(http_status IS NOT NULL))
);
CREATE UNIQUE INDEX request_event_terminal ON auth.request_event(request_id) WHERE phase<>'RECEIVED';
ALTER TABLE auth.request_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.request_event FORCE ROW LEVEL SECURITY;
CREATE POLICY request_event_maintenance ON auth.request_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.request_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE FUNCTION auth.record_request_event(request uuid,stage text,op text,actor text,status integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF stage<>'RECEIVED' AND NOT EXISTS(SELECT 1 FROM auth.request_event e WHERE e.request_id=request AND e.phase='RECEIVED' AND e.operation=op AND e.actor_id IS NOT DISTINCT FROM actor) THEN
  RAISE EXCEPTION 'Missing request receipt' USING ERRCODE='23514';
 END IF;
 INSERT INTO auth.request_event(request_id,phase,operation,actor_id,http_status) VALUES(request,stage,op,actor,status);
END $$;
REVOKE ALL ON FUNCTION auth.record_request_event(uuid,text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.record_request_event(uuid,text,text,text,integer) TO quenda_auth;
