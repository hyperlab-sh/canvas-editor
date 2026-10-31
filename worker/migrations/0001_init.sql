-- Usage beacons (POST /e) and feedback (POST /feedback). Apply: npx wrangler d1 migrations apply openflowkit-data --remote
-- One row per beacon. `user` is HMAC(USAGE_SALT, install id): stable across days, never the raw id.
-- Each USAGE_EVENTS entry (src/services/usage/usageEvents.ts) is a column; a new event needs a new migration.
CREATE TABLE sessions (
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
  active_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_day ON sessions (day);
CREATE INDEX sessions_user_day ON sessions (user, day);
CREATE INDEX sessions_first_seen ON sessions (first_seen);

-- `pay` is a comma list of PAY_OPTIONS.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  feature TEXT,
  rating TEXT,
  pmf TEXT,
  pay TEXT,
  text TEXT,
  email TEXT,
  version TEXT NOT NULL,
  country TEXT NOT NULL
);
CREATE INDEX feedback_created_at ON feedback (created_at);
