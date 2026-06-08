# Demo: Alice and Bob with Lockstep

This walkthrough simulates two developers (Alice and Bob) using AI coding agents on the same project, coordinated by Lockstep. Everything runs locally — no GitHub App needed.

## Prerequisites

- Docker & Docker Compose
- Node.js >= 20
- `lockstep-cli` installed (`npm i -g lockstep-cli`)

## Setup

Start the Lockstep backend:

```bash
cd lockstep
cp .env.example .env
docker compose up --build
```

Wait for `lockstep-core listening on :8080` in the logs.

## Step 1: Alice logs in and creates a project

```bash
# Alice authenticates (dev mode — no GitHub needed)
curl -s -X POST http://localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId": 1, "githubLogin": "alice"}' | jq .

# Save Alice's token
ALICE_TOKEN=$(curl -s -X POST http://localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId": 1, "githubLogin": "alice"}' | jq -r .token)

echo "Alice's token: $ALICE_TOKEN"
```

## Step 2: Alice connects a repo and creates the project

```bash
# Alice connects her repo to a project called "acme-api"
curl -s -X POST http://localhost:8080/connect \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"gitRemote": "https://github.com/acme/api.git", "project": "acme-api"}' | jq .
```

This creates the org, project, and repo — all in one call.

## Step 3: Bob joins the same project

```bash
# Bob authenticates
BOB_TOKEN=$(curl -s -X POST http://localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId": 2, "githubLogin": "bob"}' | jq -r .token)

# Bob connects his repo to the same project
curl -s -X POST http://localhost:8080/connect \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"gitRemote": "https://github.com/acme/frontend.git", "project": "acme-api"}' | jq .
```

## Step 4: Alice registers a session and proposes a decision

```bash
# Alice's agent starts a session
ALICE_SESSION=$(curl -s -X POST http://localhost:8080/sessions/register \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"gitRemote": "https://github.com/acme/api.git", "vendor": "claude-code"}' | jq -r .sessionId)

echo "Alice's session: $ALICE_SESSION"

# Alice's agent proposes a decision: rename the auth endpoint
curl -s -X POST http://localhost:8080/decisions \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "x-lockstep-session: $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{
    "scopeKind": "api",
    "scopeRef": "POST /auth/login",
    "ruleText": "Rename POST /auth/login to POST /auth/session for consistency",
    "baseVersion": 0
  }' | jq .
```

## Step 5: Alice records a contract change

```bash
# Alice's agent captures a contract-level change
curl -s -X POST http://localhost:8080/changes \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "x-lockstep-session: $ALICE_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{
    "summary": "Renamed POST /auth/login to POST /auth/session",
    "surface": "POST /auth/session",
    "riskTier": "breaking"
  }' | jq .
```

## Step 6: Bob registers a dependency and checks his inbox

```bash
# Bob's frontend depends on the auth API surface
BOB_SESSION=$(curl -s -X POST http://localhost:8080/sessions/register \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"gitRemote": "https://github.com/acme/frontend.git", "vendor": "codex"}' | jq -r .sessionId)

# Register that Bob's repo consumes the auth API
curl -s -X POST http://localhost:8080/dependencies \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "x-lockstep-session: $BOB_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"producedSurface": "POST /auth/session"}' | jq .

# Bob checks his inbox — he should see Alice's change
curl -s http://localhost:8080/inbox \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "x-lockstep-session: $BOB_SESSION" | jq .
```

Bob's agent now knows about Alice's breaking change and can update the frontend accordingly.

## Step 7: Bob acknowledges the decision

```bash
# Get the decision ID from the list
DECISION_ID=$(curl -s http://localhost:8080/decisions \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "x-lockstep-session: $BOB_SESSION" | jq -r '.decisions[0].id')

# Bob's agent acknowledges it
curl -s -X POST "http://localhost:8080/decisions/$DECISION_ID/ack" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "x-lockstep-session: $BOB_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"version": 1, "verdict": "ack"}' | jq .
```

## What just happened?

1. Alice's AI agent proposed a breaking API change
2. The change was recorded in Lockstep's append-only ledger
3. Bob's agent — working on a different repo with a different AI vendor — was notified via the dependency graph
4. Bob's agent acknowledged the decision, and both agents are now in sync

All of this happened without any source code leaving either developer's machine. Only decisions and metadata flowed through Lockstep.

## Using the CLI instead

In real usage, you'd use the CLI instead of raw curl calls:

```bash
# Alice
lockstep login --dev --dev-id 1 --dev-login alice
cd ~/acme-api
lockstep init
lockstep connect --project "acme-api"
# Open Claude Code — the MCP server handles the rest

# Bob
lockstep login --dev --dev-id 2 --dev-login bob
cd ~/acme-frontend
lockstep init
lockstep connect --project "acme-api"
# Open Codex or Gemini CLI — the MCP server handles the rest
```

## View in the Dashboard

Open http://localhost:3000 to see decisions, contracts, dependencies, and activity in the web UI.
