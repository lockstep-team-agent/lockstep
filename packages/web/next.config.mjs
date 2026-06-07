/** @type {import('next').NextConfig} */
// LOCKSTEP_API_URL is read at runtime by server components/actions (app/lib/api.ts),
// so it must NOT be inlined here via the `env` block — set it as a runtime env var
// on the web service instead.
export default {};
