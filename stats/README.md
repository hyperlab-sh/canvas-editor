# Stats page

`stats.openflowkit.com`: the owner's private dashboard over the share Worker's D1 (`openflowkit-data`) — people,
retention, activation, feature adoption, sources, share loop, feedback (with "Mark all read"), PMF and pay votes,
GitHub stars, npm downloads, Worker budget. One server-rendered page, no scripts. Range: `?range=7|30|90` (default 30).

The numbers come from `queries.ts`, which `npm run stats` also uses, so the terminal and the page always agree.
The Worker only reads, except `feedback.read_at` ("Mark all read").

## Two locks

1. A Cloudflare Access application on the domain lets in one email.
2. The Worker checks Access's JWT itself (RS256 against the team's keys, audience, issuer, expiry). With either secret
   missing, or any token problem, every request gets a 403 page with no data.

## Owner setup (one time)

1. **Migration:** from `worker/`, `npx wrangler d1 migrations apply openflowkit-data --remote` (adds
   `feedback.read_at`; until then the page says unread feedback is unavailable, everything else works).
2. **Access** (Cloudflare dashboard):
   1. Zero Trust → on first visit, choose a team name (e.g. `openflowkit`; your team domain is
      `openflowkit.cloudflareaccess.com`) and the Free plan.
   2. Access → Applications → Add an application → Self-hosted.
   3. Application domain: `stats.openflowkit.com`.
   4. Add a policy: name `Owner`, action **Allow**, Include → **Emails** → `varun@openflowkit.com`.
   5. Save the application.
   6. Open the application again → Overview (or Basic information) → copy the **Application Audience (AUD) tag**.
3. **Secrets:** from `stats/`, `npx wrangler secret put TEAM_DOMAIN` (`<team>.cloudflareaccess.com`, from Access
   settings) and `npx wrangler secret put POLICY_AUD` (the AUD tag). Neither is a password, but they stay out of the repo.
4. **Deploy:** `cd stats && npx wrangler deploy`. The custom domain is created on first deploy.
5. Open `https://stats.openflowkit.com`: Access asks for the email code, then the page loads.

## Notes

- GitHub stars and npm downloads are fetched server-side and cached an hour (Cache API); a failure shows `—`.
- Feedback text and emails are attacker-controlled: every string is HTML-escaped, and the CSP forbids scripts.
- "Mark all read" marks only feedback the page showed (up to its newest row) and accepts only a POST from this origin.
- Tests: `npx vitest run stats` (real SQLite via `node:sqlite`, both migrations applied).
