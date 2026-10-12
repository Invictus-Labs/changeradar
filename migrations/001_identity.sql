-- ChangeRadar schema, part 1: workspaces, identity, sessions, audit, idempotency.
-- All ids are UUIDs and all times are UTC timestamptz. Every workspace-scoped table carries workspace_id
-- NOT NULL and uses composite foreign keys, so a row can never reference an object of another workspace.
-- Migrations are additive (expand only). A later contract step ships in a separate, later migration after
-- every running version has stopped reading the old shape.

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  -- Current baseline pointer. Snapshots are immutable; the pointer moves when a new snapshot is imported.
  baseline_snapshot_id uuid,
  baseline_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (workspace_id, user_id) REFERENCES memberships(workspace_id, user_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL,
  redacted_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_workspace ON audit_events (workspace_id, seq);

-- Scope: workspace + actor + route. Keys are retained at least seven days (pruning refuses anything younger).
CREATE TABLE idempotency_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL,
  route text NOT NULL,
  key text NOT NULL,
  body_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, route, key)
);
CREATE INDEX idempotency_keys_age ON idempotency_keys (created_at);

-- History is append-only. An explicit, operator-approved purge transaction sets changeradar.purge = 'on'
-- (SET LOCAL) to delete rows; nothing else may update or delete protected rows. This guards against
-- accidents and bugs; it is not an access control boundary for someone who holds database credentials.
CREATE FUNCTION changeradar_forbid_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('changeradar.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'changeradar: % on % is not permitted (append-only)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();
