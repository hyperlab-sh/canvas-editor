-- Stats page "Mark all read" (stats.openflowkit.com). Apply: npx wrangler d1 migrations apply openflowkit-data --remote
ALTER TABLE feedback ADD COLUMN read_at TEXT;
