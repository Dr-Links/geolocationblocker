-- Milestone 5: saved searches and indexes for conversation views.
SET LOCAL search_path = app, pg_catalog;

CREATE TABLE saved_searches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX messages_thread_recent_idx ON messages (thread_id, received_at DESC);
CREATE INDEX messages_subject_norm_idx ON threads (user_id, subject_normalized, last_message_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_searches TO {{role_api}};
ALTER TABLE saved_searches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON saved_searches USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
