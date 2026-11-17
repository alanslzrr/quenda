-- Keep NULL as the municipal default; system explicitly follows the device.
ALTER TABLE domain.account_preferences
 DROP CONSTRAINT account_preferences_theme_check,
 ADD CONSTRAINT account_preferences_theme_check CHECK(theme IN ('light','dark','system'));
