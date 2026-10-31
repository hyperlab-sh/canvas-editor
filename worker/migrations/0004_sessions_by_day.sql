-- One row per person per day, was one per beacon: a later beacon adds its counts (worker/index.ts INSERT_SESSION),
-- so storage grows with people, not page loads, and a repeat beacon writes one row, no index entries. The day's first
-- beacon keeps source, entry, version and country. `beacons` counts the requests. Also `usage_daily`: the cron
-- (worker/index.ts pruneUsage) folds days past the 100-day window into one row each, then drops their detail rows.
-- Apply BEFORE deploying the Worker: npx wrangler d1 migrations apply openflowkit-data --remote
CREATE TABLE sessions_by_day (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  day TEXT NOT NULL,
  user TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  source TEXT NOT NULL,
  entry TEXT NOT NULL,
  version TEXT NOT NULL,
  "returning" INTEGER NOT NULL,
  country TEXT NOT NULL,
  session INTEGER NOT NULL DEFAULT 0,
  created_draw INTEGER NOT NULL DEFAULT 0,
  created_template INTEGER NOT NULL DEFAULT 0,
  created_code INTEGER NOT NULL DEFAULT 0,
  created_ai INTEGER NOT NULL DEFAULT 0,
  created_import INTEGER NOT NULL DEFAULT 0,
  created_map INTEGER NOT NULL DEFAULT 0,
  repo_map_ok INTEGER NOT NULL DEFAULT 0,
  repo_map_fail INTEGER NOT NULL DEFAULT 0,
  ai_applied INTEGER NOT NULL DEFAULT 0,
  agent_mcp INTEGER NOT NULL DEFAULT 0,
  agent_webmcp INTEGER NOT NULL DEFAULT 0,
  share_view INTEGER NOT NULL DEFAULT 0,
  share_edit INTEGER NOT NULL DEFAULT 0,
  export_image INTEGER NOT NULL DEFAULT 0,
  export_data INTEGER NOT NULL DEFAULT 0,
  export_motion INTEGER NOT NULL DEFAULT 0,
  code_opened INTEGER NOT NULL DEFAULT 0,
  prompt_shown INTEGER NOT NULL DEFAULT 0,
  prompt_answered INTEGER NOT NULL DEFAULT 0,
  shared_copied INTEGER NOT NULL DEFAULT 0,
  app_error INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  pro_opened INTEGER NOT NULL DEFAULT 0,
  beacons INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user, day)
);
-- Folding existing beacon rows: the bare columns come from the MIN(received_at) row (SQLite's single min() rule).
INSERT INTO sessions_by_day (received_at, day, user, first_seen, source, entry, version, "returning", country, "session", "created_draw", "created_template", "created_code", "created_ai", "created_import", "created_map", "repo_map_ok", "repo_map_fail", "ai_applied", "agent_mcp", "agent_webmcp", "share_view", "share_edit", "export_image", "export_data", "export_motion", "code_opened", "prompt_shown", "prompt_answered", "shared_copied", "app_error", "active_seconds", "pro_opened", beacons)
  SELECT MIN(received_at), day, user, first_seen, source, entry, version, "returning", country, SUM("session"), SUM("created_draw"), SUM("created_template"), SUM("created_code"), SUM("created_ai"), SUM("created_import"), SUM("created_map"), SUM("repo_map_ok"), SUM("repo_map_fail"), SUM("ai_applied"), SUM("agent_mcp"), SUM("agent_webmcp"), SUM("share_view"), SUM("share_edit"), SUM("export_image"), SUM("export_data"), SUM("export_motion"), SUM("code_opened"), SUM("prompt_shown"), SUM("prompt_answered"), SUM("shared_copied"), SUM("app_error"), SUM("active_seconds"), SUM("pro_opened"), COUNT(*)
  FROM sessions GROUP BY user, day;
DROP TABLE sessions;
ALTER TABLE sessions_by_day RENAME TO sessions;
CREATE INDEX sessions_day ON sessions (day);
CREATE INDEX sessions_first_seen ON sessions (first_seen);

-- One row per day older than the window: distinct people, people first seen that day, and every event total as JSON.
CREATE TABLE usage_daily (
  day TEXT PRIMARY KEY,
  people INTEGER NOT NULL,
  new_people INTEGER NOT NULL,
  totals TEXT NOT NULL
);
