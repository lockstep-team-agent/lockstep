/** @type {import('next').NextConfig} */
export default {
  env: {
    LOCKSTEP_API_URL: process.env.LOCKSTEP_API_URL ?? "http://localhost:8080",
  },
};
