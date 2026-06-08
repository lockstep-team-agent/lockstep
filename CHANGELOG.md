# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Open-source readiness: README overhaul, CI pipeline, SECURITY.md, CONTRIBUTING.md
- ESLint + Prettier code quality tooling
- GitHub Actions CI workflow (build, typecheck, test, lint)
- Issue and PR templates

## [0.0.2] - 2025-06-01

### Added

- Smart connect: join-by-GitHub-access (no approval needed) or create new project; idempotent
- CLI published as `lockstep-cli` on npm

## [0.0.1] - 2025-05-15

### Added

- All 9 phases built and verified against real PostgreSQL
- 25-table schema with RLS tenant isolation and append-only triggers
- GitHub App authentication with device flow
- CODEOWNERS parser and ownership graph
- CAS-versioned decision ledger with propose/acknowledge workflow
- Per-session MCP server with 12 tools
- `lockstep init` with vendor adapter pattern (idempotent config merge)
- Dependency-graph routing with inbox notifications
- Tier-1 capture: diff, classify, and publish contract changes
- Questions and tasks with cross-agent delegation
- Tier-2 PR-check reconciliation gate (GitHub Action)
- Next.js dashboard with decisions, contracts, dependencies, activity views
- Docker Compose for local development and self-hosting
- Railway deployment configuration

[Unreleased]: https://github.com/naman7474/lockstep/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/naman7474/lockstep/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/naman7474/lockstep/releases/tag/v0.0.1
