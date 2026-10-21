-- Behavioural checks for db/schema-draft.sql. Run against a scratch database AFTER loading the schema:
--   psql -f db/schema-draft.sql scratch && psql -f db/schema-checks.sql scratch
-- Every "expect FAIL" line must print an ERROR; counts must match the comment.
\set ON_ERROR_STOP 0
SET search_path = app, public;
CREATE ROLE tester LOGIN IN ROLE app_api;
INSERT INTO users (id,email_normalized,email_display,password_hash,status) VALUES
 ('11111111-1111-1111-1111-111111111111','alice@gmail.com','alice@gmail.com','x','pending'),
 ('22222222-2222-2222-2222-222222222222','bob@gmail.com','bob@gmail.com','x','pending');
INSERT INTO users (email_normalized,email_display,password_hash,role) VALUES ('admin@example.org','a','x','admin');
\echo '--- expect FAIL: second admin'
INSERT INTO users (email_normalized,email_display,password_hash,role) VALUES ('admin2@example.org','a','x','admin');
\echo '--- expect FAIL: non-gmail user'
INSERT INTO users (email_normalized,email_display,password_hash) VALUES ('x@yahoo.com','x','x');
\echo '--- expect FAIL: duplicate normalized gmail'
INSERT INTO users (email_normalized,email_display,password_hash) VALUES ('ALICE@gmail.com','x','x');
INSERT INTO mailboxes (id,user_id,email_address,provider) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','sales@a.com','imap_smtp'),
 ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','info@b.com','imap_smtp');
\echo '--- expect FAIL: alice message pointing at bob mailbox (composite FK)'
INSERT INTO messages (user_id,mailbox_id,provider_key,received_at) VALUES
 ('11111111-1111-1111-1111-111111111111','bbbbbbbb-0000-0000-0000-000000000001','k1',now());
INSERT INTO messages (user_id,mailbox_id,provider_key,received_at,subject) VALUES
 ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000001','k1',now(),'bob secret');
SET ROLE tester;
BEGIN; SET LOCAL app.user_id = '11111111-1111-1111-1111-111111111111';
\echo '--- expect 0: alice sees bob messages'
SELECT count(*) FROM messages;
\echo '--- expect 1: alice sees own mailbox only'
SELECT count(*) FROM mailboxes;
\echo '--- expect FAIL: alice inserts row tagged as bob'
INSERT INTO mailboxes (user_id,email_address,provider) VALUES ('22222222-2222-2222-2222-222222222222','evil@b.com','imap_smtp');
ROLLBACK;
BEGIN; SET LOCAL app.user_id = '11111111-1111-1111-1111-111111111111';
\echo '--- expect FAIL: alice promotes herself'
UPDATE users SET role='admin' WHERE id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
BEGIN; SET LOCAL app.user_id = '11111111-1111-1111-1111-111111111111';
\echo '--- expect FAIL: delete audit'
DELETE FROM audit_log;
ROLLBACK;
RESET ROLE;
\echo '--- calendar month: Jan 31 + 1 month in UTC'
SELECT ((timestamptz '2027-01-31 15:00+01' AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
