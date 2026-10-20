CREATE TABLE auth.credential_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 subject_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('PASSWORD_CREATED','PASSWORD_CHANGED','PASSWORD_REMOVED','MFA_ENABLED','MFA_DISABLED','MFA_MATERIAL_CREATED','MFA_MATERIAL_CHANGED','MFA_MATERIAL_REMOVED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX credential_event_subject_time ON auth.credential_event(subject_id,occurred_at,id);
ALTER TABLE auth.credential_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.credential_event FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_event_maintenance ON auth.credential_event TO quenda_migrator USING(true) WITH CHECK(true);
REVOKE ALL ON auth.credential_event FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE FUNCTION auth.record_credential_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject text; action text;
BEGIN
 IF TG_TABLE_NAME='account' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.password IS NOT NULL THEN subject:=NEW."userId"; action:='PASSWORD_CREATED'; END IF;
  ELSIF TG_OP='DELETE' THEN
   IF OLD.password IS NOT NULL THEN subject:=OLD."userId"; action:='PASSWORD_REMOVED'; END IF;
  ELSIF NEW.password IS DISTINCT FROM OLD.password THEN
   subject:=NEW."userId";
   action:=CASE WHEN NEW.password IS NULL THEN 'PASSWORD_REMOVED' WHEN OLD.password IS NULL THEN 'PASSWORD_CREATED' ELSE 'PASSWORD_CHANGED' END;
  END IF;
 ELSIF TG_TABLE_NAME='user' THEN
  IF coalesce(NEW."twoFactorEnabled",false) IS DISTINCT FROM coalesce(OLD."twoFactorEnabled",false) THEN
   subject:=NEW.id; action:=CASE WHEN NEW."twoFactorEnabled" THEN 'MFA_ENABLED' ELSE 'MFA_DISABLED' END;
  END IF;
 ELSE
  IF TG_OP='INSERT' THEN subject:=NEW."userId"; action:='MFA_MATERIAL_CREATED';
  ELSIF TG_OP='DELETE' THEN subject:=OLD."userId"; action:='MFA_MATERIAL_REMOVED';
  ELSIF NEW.secret IS DISTINCT FROM OLD.secret OR NEW."backupCodes" IS DISTINCT FROM OLD."backupCodes" THEN
   subject:=NEW."userId"; action:='MFA_MATERIAL_CHANGED';
  END IF;
 END IF;
 IF action IS NOT NULL THEN INSERT INTO auth.credential_event(subject_id,operation) VALUES(subject,action); END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION auth.record_credential_event() FROM PUBLIC,quenda_auth,quenda_domain,quenda_worker;
CREATE TRIGGER password_event_record AFTER INSERT OR DELETE OR UPDATE OF password ON auth.account
 FOR EACH ROW EXECUTE FUNCTION auth.record_credential_event();
CREATE TRIGGER mfa_configuration_event_record AFTER UPDATE OF "twoFactorEnabled" ON auth."user"
 FOR EACH ROW EXECUTE FUNCTION auth.record_credential_event();
CREATE TRIGGER mfa_material_event_record AFTER INSERT OR DELETE OR UPDATE OF secret,"backupCodes" ON auth."twoFactor"
 FOR EACH ROW EXECUTE FUNCTION auth.record_credential_event();
