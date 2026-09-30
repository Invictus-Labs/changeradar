-- ChangeRadar schema, part 2: immutable snapshots, graph rows, impact runs, findings, contract checks.

CREATE TABLE snapshots (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  revision text NOT NULL,
  -- Graph hash (sha256:<hex> over nodes and edges). This is the value compared with expected_hash.
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Hash of the whole normalized manifest including revision and provenance.
  document_hash text NOT NULL CHECK (document_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Canonical JSON of the normalized manifest. The graph is rebuilt from it on read and re-hashed.
  manifest text NOT NULL,
  node_count integer NOT NULL CHECK (node_count >= 0),
  edge_count integer NOT NULL CHECK (edge_count >= 0),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Value of workspaces.baseline_version assigned by this import.
  baseline_version integer NOT NULL,
  imported_by uuid REFERENCES users(id),
  imported_at timestamptz NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE INDEX snapshots_list ON snapshots (workspace_id, imported_at DESC, id DESC);
CREATE INDEX snapshots_hash ON snapshots (workspace_id, manifest_hash);

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_baseline_fk
  FOREIGN KEY (id, baseline_snapshot_id) REFERENCES snapshots (workspace_id, id);

CREATE TABLE nodes (
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('service', 'job', 'contract', 'credential_alias', 'artifact')),
  owner text,
  version text NOT NULL,
  placeholder boolean NOT NULL DEFAULT false,
  contract jsonb,
  PRIMARY KEY (snapshot_id, id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots (workspace_id, id)
);

CREATE TABLE edges (
  workspace_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  relation text NOT NULL CHECK (relation IN ('consumes', 'requires', 'produces')),
  source_file text NOT NULL,
  source_line integer NOT NULL CHECK (source_line >= 1),
  verified_at timestamptz,
  fields jsonb,
  PRIMARY KEY (snapshot_id, source_id, target_id, relation),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots (workspace_id, id),
  FOREIGN KEY (snapshot_id, source_id) REFERENCES nodes (snapshot_id, id),
  FOREIGN KEY (snapshot_id, target_id) REFERENCES nodes (snapshot_id, id)
);
CREATE INDEX edges_target ON edges (snapshot_id, target_id);

CREATE TRIGGER snapshots_append_only BEFORE UPDATE OR DELETE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();
CREATE TRIGGER nodes_append_only BEFORE UPDATE OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();
CREATE TRIGGER edges_append_only BEFORE UPDATE OR DELETE ON edges
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();

-- Admin-configured, read-only contract check definitions (HTTP GET/HEAD against allowlisted endpoints).
-- Only a credential ALIAS is stored here, never a credential value.
CREATE TABLE contract_checks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  check_key text NOT NULL,
  node_id text NOT NULL,
  url text NOT NULL,
  method text NOT NULL CHECK (method IN ('GET', 'HEAD')),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 120000),
  retries integer NOT NULL CHECK (retries BETWEEN 0 AND 3),
  expect_status integer NOT NULL CHECK (expect_status BETWEEN 100 AND 599),
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  credential_alias text,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, check_key)
);

CREATE TABLE impact_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  snapshot_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  proposed_hash text NOT NULL CHECK (proposed_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_hash text NOT NULL,
  baseline_hash text NOT NULL CHECK (baseline_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Workspace baseline counter observed under lock when the run was accepted.
  baseline_version integer NOT NULL,
  proposed_manifest text NOT NULL,
  run_checks boolean NOT NULL DEFAULT true,
  check_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when the caller explicitly asked to assess against a snapshot that was no longer the baseline.
  allow_superseded boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETE', 'FAILED')),
  -- The verdict. COMPLETE describes computation only; verdict says AFFECTED, NO_KNOWN_IMPACT or INCOMPLETE.
  verdict text CHECK (verdict IN ('AFFECTED', 'NO_KNOWN_IMPACT', 'INCOMPLETE')),
  assessment jsonb,
  unknowns jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  error_detail text,
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots (workspace_id, id),
  CHECK ((status = 'COMPLETE') = (verdict IS NOT NULL))
);
CREATE INDEX impact_runs_list ON impact_runs (workspace_id, created_at DESC, id DESC);
CREATE INDEX impact_runs_status ON impact_runs (workspace_id, status);
CREATE INDEX impact_runs_snapshot ON impact_runs (snapshot_id);

-- Runs are history: never deleted, inputs never edited, terminal states never left.
CREATE FUNCTION changeradar_protect_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('changeradar.purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'changeradar: DELETE on impact_runs is not permitted (append-only)';
  END IF;
  IF OLD.status IN ('COMPLETE', 'FAILED') THEN
    RAISE EXCEPTION 'changeradar: a % run is terminal and cannot be modified', OLD.status;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.snapshot_id <> OLD.snapshot_id
     OR NEW.proposed_hash <> OLD.proposed_hash OR NEW.expected_hash <> OLD.expected_hash
     OR NEW.baseline_hash <> OLD.baseline_hash OR NEW.baseline_version <> OLD.baseline_version
     OR NEW.created_at <> OLD.created_at OR NEW.run_checks <> OLD.run_checks OR NEW.allow_superseded <> OLD.allow_superseded
     OR NEW.check_keys::text <> OLD.check_keys::text OR NEW.proposed_manifest <> OLD.proposed_manifest THEN
    RAISE EXCEPTION 'changeradar: impact run inputs are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER impact_runs_protect BEFORE UPDATE OR DELETE ON impact_runs
  FOR EACH ROW EXECUTE FUNCTION changeradar_protect_run();

CREATE TABLE findings (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  -- Content derived id (fnd_ + 20 hex), identical in every export of the same assessment.
  finding_key text NOT NULL CHECK (finding_key ~ '^fnd_[0-9a-f]{20}$'),
  position integer NOT NULL,
  origin_id text NOT NULL,
  consumer_id text NOT NULL,
  consumer_kind text NOT NULL,
  consumer_owner text,
  severity text NOT NULL CHECK (severity IN ('high', 'medium')),
  direct boolean NOT NULL,
  depth integer NOT NULL CHECK (depth >= 1),
  path jsonb NOT NULL,
  hops jsonb NOT NULL,
  change_ids jsonb NOT NULL,
  reason text NOT NULL,
  UNIQUE (run_id, finding_key),
  FOREIGN KEY (workspace_id, run_id) REFERENCES impact_runs (workspace_id, id)
);
CREATE INDEX findings_run ON findings (run_id, position);
CREATE TRIGGER findings_append_only BEFORE UPDATE OR DELETE ON findings
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();

CREATE TABLE run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id, run_id) REFERENCES impact_runs (workspace_id, id)
);
CREATE INDEX run_events_run ON run_events (run_id, id);
CREATE TRIGGER run_events_append_only BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW EXECUTE FUNCTION changeradar_forbid_change();

-- One row per (run, check). It is inserted as STARTED before any request leaves the process, and updated
-- exactly once to a final state. A STARTED row that is found again after a restart means the external
-- outcome is uncertain; it becomes UNKNOWN and is never silently retried into a pass.
CREATE TABLE check_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  run_id uuid NOT NULL,
  check_key text NOT NULL,
  node_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('STARTED', 'PASSED', 'FAILED', 'TIMED_OUT', 'ERROR', 'UNKNOWN')),
  definition jsonb NOT NULL,
  result jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (run_id, check_key),
  FOREIGN KEY (workspace_id, run_id) REFERENCES impact_runs (workspace_id, id)
);

CREATE FUNCTION changeradar_protect_check_result() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('changeradar.purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'changeradar: DELETE on check_results is not permitted (append-only)';
  END IF;
  IF OLD.state <> 'STARTED' THEN
    RAISE EXCEPTION 'changeradar: a concluded check result cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_results_protect BEFORE UPDATE OR DELETE ON check_results
  FOR EACH ROW EXECUTE FUNCTION changeradar_protect_check_result();
