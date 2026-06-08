# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Lockstep, please report it responsibly. **Do not** open a public GitHub issue.

### How to report

Email **naman7474@gmail.com** with:

1. A description of the vulnerability
2. Steps to reproduce it
3. The potential impact
4. Any suggested fix (optional)

### What to expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days with an assessment and estimated fix timeline
- **Credit** in the release notes (unless you prefer to remain anonymous)

### Scope

The following are in scope:

- Authentication and authorization bypasses
- RLS (row-level security) isolation escapes
- Token leakage or session hijacking
- SQL injection or other injection attacks
- Sensitive data exposure (secrets, tokens, source code leaking through the API)
- Denial of service via API abuse

### Out of scope

- Issues in dependencies (report upstream, but let us know so we can track)
- Social engineering attacks
- Attacks requiring physical access to a developer's machine

## Security Design

Lockstep is designed with security as a core principle:

- **Row-Level Security (RLS)**: Every database query is scoped to the authenticated tenant
- **Append-only ledger**: Decisions cannot be modified or deleted — only proposed and acknowledged
- **Encrypted tokens**: Session tokens are hashed before storage
- **No source code stored**: Only decisions, contracts, and metadata flow through the system
- **Dev-login bypass**: Strictly gated — disabled when `NODE_ENV=production`
- **Zod validation**: All API inputs are validated at the boundary

## Supported Versions

| Version | Supported     |
| ------- | ------------- |
| 0.x     | Yes (current) |
