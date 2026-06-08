import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiUrl } from "./config.js";

test("resolveApiUrl defaults to localhost:8080 when no env or config", () => {
  const saved = process.env.LOCKSTEP_API_URL;
  delete process.env.LOCKSTEP_API_URL;
  try {
    const url = resolveApiUrl();
    // It should return either saved config or the default
    assert.ok(url.startsWith("http"));
    assert.ok(!url.endsWith("/"), "trailing slash should be stripped");
  } finally {
    if (saved !== undefined) process.env.LOCKSTEP_API_URL = saved;
  }
});

test("resolveApiUrl uses env var when set", () => {
  const saved = process.env.LOCKSTEP_API_URL;
  process.env.LOCKSTEP_API_URL = "https://my-server.example.com/";
  try {
    const url = resolveApiUrl();
    assert.equal(url, "https://my-server.example.com");
  } finally {
    if (saved !== undefined) process.env.LOCKSTEP_API_URL = saved;
    else delete process.env.LOCKSTEP_API_URL;
  }
});

test("resolveApiUrl strips multiple trailing slashes", () => {
  const saved = process.env.LOCKSTEP_API_URL;
  process.env.LOCKSTEP_API_URL = "http://localhost:8080///";
  try {
    const url = resolveApiUrl();
    assert.equal(url, "http://localhost:8080");
  } finally {
    if (saved !== undefined) process.env.LOCKSTEP_API_URL = saved;
    else delete process.env.LOCKSTEP_API_URL;
  }
});
