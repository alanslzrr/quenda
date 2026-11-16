-- A municipality picks one theme from the catalog (both modes), may override its background, text and accent per
-- mode, and chooses typeface and corner shape. Contrast is checked by the application before saving; the database
-- only accepts well-formed values.
CREATE FUNCTION domain.valid_theme_colors(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NOT NULL AND jsonb_typeof(value)='object' AND NOT EXISTS(
  SELECT 1 FROM jsonb_each(value) e
  WHERE e.key NOT IN ('background','foreground','accent')
  OR jsonb_typeof(e.value)<>'string' OR (e.value#>>'{}') !~ '^#[0-9a-f]{6}$')
$$;
ALTER TABLE domain.municipality
 ADD COLUMN theme text NOT NULL DEFAULT 'neutral' CHECK(theme ~ '^[a-z][a-z0-9-]{0,31}$'),
 ADD COLUMN theme_light jsonb NOT NULL DEFAULT '{}' CHECK(domain.valid_theme_colors(theme_light)),
 ADD COLUMN theme_dark jsonb NOT NULL DEFAULT '{}' CHECK(domain.valid_theme_colors(theme_dark)),
 ADD COLUMN theme_font text NOT NULL DEFAULT 'inter' CHECK(theme_font IN ('inter','geist','system','serif')),
 ADD COLUMN theme_corners text NOT NULL DEFAULT 'round' CHECK(theme_corners IN ('round','soft','square'));
-- The light palette becomes the theme; a different dark palette is kept exactly as dark overrides.
UPDATE domain.municipality SET theme=light_palette,
 theme_dark=CASE WHEN dark_palette=light_palette THEN '{}'::jsonb ELSE CASE dark_palette
  WHEN 'neutral' THEN '{"background":"#191919","foreground":"#f5f5f5","accent":"#dddddd"}'::jsonb
  WHEN 'blue' THEN '{"background":"#141d2b","foreground":"#f1f5fc","accent":"#aac9ff"}'::jsonb
  ELSE '{"background":"#15251d","foreground":"#f0f8f3","accent":"#9adab6"}'::jsonb END END;
DROP FUNCTION domain.public_municipal_appearance(uuid);
DROP FUNCTION domain.save_municipal_appearance(integer,text,text,text,uuid);
ALTER TABLE domain.municipality DROP COLUMN light_palette, DROP COLUMN dark_palette;

CREATE FUNCTION domain.public_municipal_appearance(selected uuid)
RETURNS TABLE(version integer,theme text,light jsonb,dark jsonb,font text,corners text,default_theme text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.appearance_version,m.theme,m.theme_light,m.theme_dark,m.theme_font,m.theme_corners,m.default_theme
 FROM domain.municipality m WHERE m.id=selected
$$;
CREATE FUNCTION domain.save_municipal_appearance(expected integer,theme_value text,light_value jsonb,dark_value jsonb,
 font_value text,corners_value text,default_value text,correlation uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('quenda.tenant_id',true),'')::uuid;
 actor text:=nullif(current_setting('quenda.account_id',true),''); previous domain.municipality%ROWTYPE;
BEGIN
 IF tenant IS NULL OR actor IS NULL OR NOT domain.lock_current_administrator()
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected NOT BETWEEN 1 AND 2147483646 OR correlation IS NULL
 OR theme_value IS NULL OR theme_value !~ '^[a-z][a-z0-9-]{0,31}$'
 OR NOT domain.valid_theme_colors(light_value) OR NOT domain.valid_theme_colors(dark_value)
 OR font_value IS NULL OR font_value NOT IN ('inter','geist','system','serif')
 OR corners_value IS NULL OR corners_value NOT IN ('round','soft','square')
 OR default_value IS NULL OR default_value NOT IN ('light','dark')
 THEN RAISE EXCEPTION 'Invalid appearance' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM domain.municipality WHERE id=tenant FOR UPDATE;
 IF NOT FOUND OR previous.appearance_version<>expected THEN RETURN NULL; END IF;
 UPDATE domain.municipality SET appearance_version=expected+1,theme=theme_value,theme_light=light_value,
  theme_dark=dark_value,theme_font=font_value,theme_corners=corners_value,default_theme=default_value WHERE id=tenant;
 INSERT INTO domain.municipal_appearance_event(tenant_id,actor_id,version,previous_state,next_state,correlation_id)
 VALUES(tenant,actor,expected+1,
  jsonb_build_object('theme',previous.theme,'light',previous.theme_light,'dark',previous.theme_dark,
   'font',previous.theme_font,'corners',previous.theme_corners,'defaultTheme',previous.default_theme),
  jsonb_build_object('theme',theme_value,'light',light_value,'dark',dark_value,
   'font',font_value,'corners',corners_value,'defaultTheme',default_value),correlation);
 RETURN expected+1;
END $$;
REVOKE ALL ON FUNCTION domain.valid_theme_colors(jsonb) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.valid_theme_colors(jsonb) TO quenda_domain;
REVOKE ALL ON FUNCTION domain.public_municipal_appearance(uuid),
 domain.save_municipal_appearance(integer,text,jsonb,jsonb,text,text,text,uuid) FROM PUBLIC,quenda_auth,quenda_worker;
GRANT EXECUTE ON FUNCTION domain.public_municipal_appearance(uuid),
 domain.save_municipal_appearance(integer,text,jsonb,jsonb,text,text,text,uuid) TO quenda_domain;
