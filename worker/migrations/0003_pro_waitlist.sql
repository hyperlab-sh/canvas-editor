-- Pro waitlist (the app's home sidebar). Apply: npx wrangler d1 migrations apply openflowkit-data --remote
-- `plan` is a PRO_PLANS entry and `price` whole dollars a month (src/services/usage/usageEvents.ts); both null for other kinds.
ALTER TABLE feedback ADD COLUMN plan TEXT;
ALTER TABLE feedback ADD COLUMN price INTEGER;
ALTER TABLE sessions ADD COLUMN pro_opened INTEGER NOT NULL DEFAULT 0;
