# Demo

Two parts: the **hero GIF storyboard** (what to record for the README) and a **scripted walkthrough**
that produces exactly that scene, runnable end-to-end with local dev-login.

---

## Hero GIF — the 25-second story

This is the README's lead visual. The point it must land: *one developer's agent makes a decision,
and the other developer's agent is aware of it — ranked by blast radius — before it writes a line.*

**Format:** split screen, ~25s, two Claude Code panes side by side. No narration; let the briefing speak.

```
 LEFT — Dev A (auth-service)                RIGHT — Dev B (web), a moment later
 ───────────────────────────                ──────────────────────────────────
 A is renaming the login route.             B opens a fresh Claude Code session.

 A's agent:                                 ─ Lockstep briefing ─────────────
   "Renaming POST /login → POST /session.   ⚠ [impact 3] auth: POST /login →
    Logging the decision."                     POST /session is now binding
   ↳ [lockstep] decision logged · impact 3  ⚠ [impact 3] change: POST /session
   ↳ [lockstep] change published               (3 services consume this)

                                            B's agent, unprompted:
                                              "Heads up — the auth team renamed
                                               /login to /session. I'll call
                                               /session, not /login."
```

**Beats (for the editor):**
1. `0–8s` — LEFT: A's agent renames the route; the two `[lockstep]` lines flash. Hold on "impact 3".
2. `8–14s` — RIGHT: B runs `claude`; the Lockstep briefing prints, **highest-impact line first**.
3. `14–25s` — RIGHT: B's agent states it will use `/session`. End on that line.

**Recording notes:** use two terminal panes (tmux or two windows) at ≥16pt; record with
`asciinema` → `agg` for a crisp GIF, or a screen recorder at 820px wide. Save to
`docs/assets/demo.gif`, then uncomment the hero block in the README.

---

## Scripted walkthrough (produces the scene above)

Everything runs locally — no GitHub App needed. Two ordering rules matter:
- **Alice invites Bob *before* Bob logs in.** In dev mode (no GitHub token) Bob can't auto-join a repo
  he has no verified access to; the invite is what lands his repo in Alice's project. The invite is
  activated on Bob's next login. *(Without it, Bob lands in his own separate workspace and nothing
  delivers — `lockstep connect` now warns when this happens.)*
- **Bob declares his dependency *before* Alice changes the surface**, so the change routes to him and
  the decision is correctly cross-cutting.

### Setup

```bash
cd lockstep && cp .env.example .env && docker compose up --build
# wait for: lockstep-core listening on :8080
```

### 1. Alice creates the project (auth-service) and invites Bob

```bash
ALICE=$(curl -s -X POST http://localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId":1,"githubLogin":"alice"}' | jq -r .token)

curl -s -X POST http://localhost:8080/connect \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"gitRemote":"https://github.com/acme/auth-service.git","project":"acme"}' | jq .

# Invite Bob to the project (the CLI does this via `lockstep invite bob`).
ORG=$(curl -s http://localhost:8080/me -H "Authorization: Bearer $ALICE" | jq -r '.memberships[0].orgId')
PROJ=$(curl -s http://localhost:8080/orgs/$ORG/overview -H "Authorization: Bearer $ALICE" | jq -r '.projects[0].id')
curl -s -X POST http://localhost:8080/orgs/$ORG/projects/$PROJ/invite \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"githubLogin":"bob"}' | jq .
```

### 2. Bob logs in (activating the invite), connects, and declares what he consumes

```bash
BOB=$(curl -s -X POST http://localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId":2,"githubLogin":"bob"}' | jq -r .token)

curl -s -X POST http://localhost:8080/connect \
  -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
  -d '{"gitRemote":"https://github.com/acme/web.git","project":"acme"}' | jq .

# Sanity check: Bob must be in Alice's org (same orgId) — else the invite didn't take.
curl -s http://localhost:8080/me -H "Authorization: Bearer $BOB" | jq '.memberships[0].orgId'

BOB_SID=$(curl -s -X POST http://localhost:8080/sessions/register \
  -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
  -d '{"gitRemote":"https://github.com/acme/web.git","vendor":"claude-code"}' | jq -r .sessionId)

# Bob's web app consumes the auth surface (this is what lockstep.yaml `consumes:` does)
curl -s -X POST http://localhost:8080/dependencies \
  -H "Authorization: Bearer $BOB" -H "x-lockstep-session: $BOB_SID" \
  -H 'Content-Type: application/json' \
  -d '{"producedSurface":"http:POST /auth/session","source":"manifest"}' | jq .
```

### 3. Alice logs the decision and changes the surface

```bash
ALICE_SID=$(curl -s -X POST http://localhost:8080/sessions/register \
  -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"gitRemote":"https://github.com/acme/auth-service.git","vendor":"claude-code"}' | jq -r .sessionId)

# A durable decision (a rule). Because a consumer exists, impact > 0 → stays `open` until acked.
curl -s -X POST http://localhost:8080/decisions \
  -H "Authorization: Bearer $ALICE" -H "x-lockstep-session: $ALICE_SID" \
  -H 'Content-Type: application/json' \
  -d '{"scopeKind":"surface","scopeRef":"http:POST /auth/session","decisionType":"rule",
       "ruleText":"POST /login is renamed to POST /session across the org","baseVersion":0}' | jq .
#  => { ..., "status": "open", "impact": 1 }

# The change event on the canonical surface — routes to every consumer.
curl -s -X POST http://localhost:8080/changes \
  -H "Authorization: Bearer $ALICE" -H "x-lockstep-session: $ALICE_SID" \
  -H 'Content-Type: application/json' \
  -d '{"summary":"Renamed POST /login to POST /session","surface":"http:POST /auth/session","riskTier":"shared"}' | jq .
#  => { ..., "impact": 1, "delivered": 1 }
```

### 4. Bob's agent is briefed (the magic moment), then acks

```bash
# The change is in Bob's inbox, carrying its impact for ranking.
curl -s http://localhost:8080/inbox \
  -H "Authorization: Bearer $BOB" -H "x-lockstep-session: $BOB_SID" | jq '.changes, .decisions'

# Bob acknowledges the cross-cutting decision → it becomes binding for the project.
DID=$(curl -s http://localhost:8080/decisions \
  -H "Authorization: Bearer $BOB" -H "x-lockstep-session: $BOB_SID" | jq -r '.decisions[0].id')
curl -s -X POST "http://localhost:8080/decisions/$DID/ack" \
  -H "Authorization: Bearer $BOB" -H "x-lockstep-session: $BOB_SID" \
  -H 'Content-Type: application/json' -d '{"version":1,"verdict":"ack"}' | jq .
#  => { "status": "binding" }
```

## What just happened

1. Bob's repo declared it consumes `http:POST /auth/session` — populating the usage graph.
2. Alice's agent logged a **decision** and published a **change** on that canonical surface.
3. Lockstep scored both by **blast radius** (1 consumer → impact 1) and routed the change to Bob.
4. Bob's next session leads with the impact-ranked briefing — his agent knows before it acts.
5. Bob acked the cross-cutting decision, so it's now **binding** for the whole project.

## The real thing (CLI, not curl)

```bash
# Alice
lockstep login --dev --dev-id 1 --dev-login alice
cd ~/auth-service && lockstep init && lockstep connect --project acme
# add lockstep.yaml, open Claude Code — the MCP server + hooks handle the rest

# Bob
lockstep login --dev --dev-id 2 --dev-login bob
cd ~/web && lockstep init && lockstep connect --project acme
# add lockstep.yaml with `consumes: [http:POST /auth/session]`, open Claude Code
```

Open http://localhost:3000 to see decisions, dependencies, and activity in the dashboard.
