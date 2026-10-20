-- Database facts, not inferred login outcomes or an asserted initiating actor.
CREATE TABLE auth.session_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('SESSION_CREATED','SESSION_REMOVED','SESSION_MFA_PROOF_CHANGED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX session_event_subject_time ON auth.session_event(subject_id,occurred_at,id);
ALTER TABLE auth.session_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.session_event FORCE ROW LEVEL SECURITY;
CREATE POLICY session_event_maintenance ON auth.session_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.session_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;

CREATE FUNCTION auth.record_session_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO auth.session_event(subject_id,operation) VALUES(NEW."userId",'SESSION_CREATED');
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO auth.session_event(subject_id,operation) VALUES(OLD."userId",'SESSION_REMOVED');
 ELSIF NEW."mfaVerifiedAt" IS DISTINCT FROM OLD."mfaVerifiedAt" THEN
  INSERT INTO auth.session_event(subject_id,operation) VALUES(NEW."userId",'SESSION_MFA_PROOF_CHANGED');
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION auth.record_session_event() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER session_event_record AFTER INSERT OR DELETE OR UPDATE OF "mfaVerifiedAt" ON auth.session
 FOR EACH ROW EXECUTE FUNCTION auth.record_session_event();
