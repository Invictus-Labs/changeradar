-- ChangeRadar schema, part 3: job leases, transactional outbox, encrypted credential values.

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  type text NOT NULL CHECK (type IN ('assess_run')),
  object_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'done', 'dead')),
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_until timestamptz,
  locked_by text,
  next_attempt_at timestamptz NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX jobs_claimable ON jobs (state, next_attempt_at);

-- Versioned envelope (PRD section 6): {schema_version, event_id, source, resource_id, event_type,
-- occurred_at, revision, evidence_ref, correlation_id?}. Inserted in the same transaction as the state
-- change it announces. Delivery is at least once; consumers deduplicate on event_id.
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  envelope jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'delivered')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  delivered_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (state, next_attempt_at);
CREATE INDEX outbox_workspace_seq ON outbox_events (workspace_id, seq);

-- Credential VALUES referenced by a contract check's credential_alias. They are sealed with AES-256-GCM
-- using the operator-managed CHANGERADAR_ENCRYPTION_KEY, which is never stored in the database.
CREATE TABLE credential_secrets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  alias text NOT NULL CHECK (alias ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  secret_enc text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, alias)
);
