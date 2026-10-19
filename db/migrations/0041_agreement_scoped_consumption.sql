-- Retiring a unit preserves its attributed quota. A later agreement reconciles
-- those same confirmed reservations without deleting the former consumption.
-- The primary key still enforces one consumption per agreement and reservation;
-- assignment exclusion separately prevents simultaneous effective agreements.
DROP INDEX domain.agreement_consumption_one_active;
