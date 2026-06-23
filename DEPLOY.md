# Deploying Lockstep on Railway

Two services + a database, all from this repo. Railway builds each via its Dockerfile
(monorepo, root build context).

```
Railway project
├─ Postgres            (Railway plugin)
├─ core   → packages/core/Dockerfile   (Fastify API; migrations run on boot)
└─ web    → packages/web/Dockerfile    (Next.js dashboard)
```

> Prefer Vercel for the dashboard? It's the better host for Next.js — deploy `packages/web`
> there with root directory `packages/web` and set `LOCKSTEP_API_URL`. The steps below keep
> everything on Railway for a single-platform setup.

## 1. Create the project + database

- New Railway project → **Add → Database → PostgreSQL**.

## 2. Deploy `core`

- **Add → GitHub Repo → `lockstep-team-agent/lockstep`.** This service uses the root `railway.json`
  (Dockerfile `packages/core/Dockerfile`, healthcheck `/healthz`).
- **Variables:**
  | Key | Value |
  |---|---|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference the PG service) |
  | `TOKEN_SIGNING_SECRET` | a strong secret — `openssl rand -hex 32` |
  | `LOCKSTEP_DEPLOYMENT` | `cloud` |
  | `NODE_ENV` | `production` _(see smoke-test note)_ |
  | `GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` | from your GitHub App |
- Railway injects `PORT`; the server reads it. After deploy, hit `https://<core>/readyz` → `{ ok: true, db: "up" }`.

## 3. Deploy `web`

- **Add → GitHub Repo → same repo.** In the service settings set **Build → Dockerfile Path**
  to `packages/web/Dockerfile`.
- **Variables:** `LOCKSTEP_API_URL = https://<core-public-url>`
- Open the web service URL → sign in with a Lockstep token (`lockstep login` locally prints one).

## 4. Point the CLI at the deployed core

On each developer machine:

```bash
export LOCKSTEP_API_URL=https://<core-public-url>
lockstep login        # GitHub device flow
lockstep init         # wires hooks + MCP into the repo
```

## Smoke-testing before the GitHub App is ready

`NODE_ENV=production` disables the dev-login bypass, so a prod core can't log anyone in
until the **GitHub App** is registered. For a first end-to-end smoke without it, set on `core`:

```
NODE_ENV=development
LOCKSTEP_DEV_LOGIN=1
```

…then `lockstep login --dev --dev-id 1 --dev-login <you>`. Switch back to
`NODE_ENV=production` + real GitHub App keys before any real use.

## Notes

- **Postgres role:** the migration creates a `lockstep_app` role and grants it to the
  connecting role — Railway PG permits this. RLS isolation + append-only enforcement apply.
- **Migrations** run automatically on every `core` boot (the Dockerfile `CMD`).
- **Self-host** is the same images via `docker compose up` against your own infra.
