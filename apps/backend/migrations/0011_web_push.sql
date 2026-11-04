-- PWA: browser push (Web Push) subscriptions are stored as device push tokens.
SET LOCAL search_path = app, pg_catalog;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_push_provider_check;
ALTER TABLE devices ADD CONSTRAINT devices_push_provider_check CHECK (push_provider IN ('expo','fcm','webpush'));
