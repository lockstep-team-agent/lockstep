# Contributing to Lockstep

Thanks for your interest in contributing to Lockstep! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js >= 20
- Docker & Docker Compose
- A GitHub account (for auth flows)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/naman7474/lockstep.git
cd lockstep

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Start Postgres + core API + dashboard
docker compose up --build

# Verify everything is running
curl localhost:8080/readyz   # { ok: true, db: "up" }
```

### Dev-Mode Authentication

The `.env.example` already has dev-login enabled (`LOCKSTEP_DEV_LOGIN=1`), so after copying it to `.env`, you can authenticate without a GitHub App:

```bash
npm i -g lockstep-cli
lockstep login --api http://localhost:8080 --dev --dev-id 1 --dev-login dev
```

Or via curl:

```bash
curl -X POST localhost:8080/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"githubUserId": 1, "githubLogin": "dev"}'
```

To sign in to the dashboard at http://localhost:3000, retrieve the token:

```bash
# macOS
security find-generic-password -s lockstep -a session-token -w
# Linux / fallback
cat ~/.lockstep/credentials.json
```

### Project Structure

```
packages/core/   # Fastify API + Postgres (Drizzle ORM), RLS-isolated
packages/cli/    # @lockstep/cli — login, init, mcp, capture
packages/web/    # Next.js dashboard
actions/pr-check # GitHub Action for Tier-2 reconciliation
```

### Common Commands

```bash
npm run build         # Build all workspaces
npm run typecheck     # Type-check all workspaces
npm run test          # Run all tests
npm run lint          # Lint all workspaces
npm run format        # Format all files with Prettier
npm run dev:core      # Start core API in watch mode
npm run db:generate   # Generate Drizzle migrations
npm run db:migrate    # Run database migrations
```

## Making Changes

### Branch Naming

Use descriptive branch names:

- `feat/short-description` for new features
- `fix/short-description` for bug fixes
- `docs/short-description` for documentation

### Commit Messages

Write clear, concise commit messages that explain **why**, not just what:

```
feat: add webhook support for decision notifications

Agents need real-time notification when decisions are proposed
so they can acknowledge without polling.
```

### Pull Request Process

1. Fork the repo and create your branch from `main`
2. Make your changes, ensuring all tests pass
3. Add tests for any new functionality
4. Run the full check suite:
   ```bash
   npm run build && npm run typecheck && npm run test && npm run lint
   ```
5. Open a PR with a clear description of what and why
6. Fill out the PR template checklist

### Code Style

- TypeScript strict mode is enabled across all packages
- Use `node:test` for tests (no external test frameworks)
- Keep functions small and focused
- Prefer explicit types over `any`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Check existing issues before creating a new one
- Use the provided issue templates

## Security

If you discover a security vulnerability, please **do not** open a public issue. See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
