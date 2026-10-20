-- Applies only to newly created municipalities. Existing municipal policies and
-- accepted reservation conditions are not overwritten by an upgrade.
ALTER TABLE domain.municipality ALTER COLUMN cancellation_minutes SET DEFAULT 1440;
