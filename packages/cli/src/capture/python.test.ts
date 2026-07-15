import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPythonOutbound, extractPythonSurfaces } from "./python.js";

const surfaces = (content: string): string[] =>
  extractPythonOutbound("src/client.py", content)
    .map((o) => o.surface)
    .filter((s): s is string => Boolean(s))
    .sort();

test("python outbound: requests verb calls with literal and f-string URLs", () => {
  const content = `
import requests
r = requests.get("https://api.acme.com/inventory/42")
requests.post(f"/orders/{order_id}/items", json=payload)
`;
  assert.deepEqual(surfaces(content), ["http:GET /inventory/42", "http:POST /orders/:param/items"]);
});

test("python outbound: requests.request with explicit verb", () => {
  assert.deepEqual(surfaces(`requests.request("PUT", "/users/7")`), ["http:PUT /users/7"]);
});

test("python outbound: httpx module verbs and base_url client instances", () => {
  const content = `
import httpx
httpx.get("/health")
client = httpx.Client(base_url="https://billing.internal/v1")
client.post("/charges")
async_client = httpx.AsyncClient(base_url="/inventory")
resp = await async_client.get(f"/items/{sku}")
`;
  assert.deepEqual(surfaces(content), [
    "http:GET /health",
    "http:GET /inventory/items/:param",
    "http:POST /v1/charges",
  ]);
});

test("python outbound: aiohttp session verbs (no base URL)", () => {
  const content = `
async with aiohttp.ClientSession() as session:
    await session.get("/payments/status")
`;
  assert.deepEqual(surfaces(content), ["http:GET /payments/status"]);
});

test("python outbound: non-python paths and unknown instances yield nothing", () => {
  assert.deepEqual(extractPythonOutbound("src/client.ts", `requests.get("/x")`), []);
  assert.deepEqual(surfaces(`mystery.get("/x")`), [], "instances not bound in this file are ignored");
});

test("python produces: FastAPI app + APIRouter prefix + include_router prefix compose", () => {
  const content = `
from fastapi import FastAPI, APIRouter
app = FastAPI()
router = APIRouter(prefix="/cards")

@app.get("/health")
def health(): ...

@router.post("/{card_id}/activate")
def activate(card_id: int): ...

app.include_router(admin_router, prefix="/admin")
`;
  const out = extractPythonSurfaces("src/main.py", content).sort();
  assert.deepEqual(out, ["http:GET /health", "http:POST /cards/:card_id/activate"]);
});

test("python produces: include_router prefix prepends to a same-file router", () => {
  const content = `
router = APIRouter(prefix="/cards")
app.include_router(router, prefix="/api")

@router.get("/{id}")
def get_card(id: int): ...
`;
  assert.deepEqual(extractPythonSurfaces("src/api.py", content), ["http:GET /api/cards/:id"]);
});

test("python produces: bare 'router' decorators are accepted (common off-screen binding)", () => {
  assert.deepEqual(extractPythonSurfaces("src/routes.py", `@router.delete("/sessions/{sid}")\ndef d(): ...`), [
    "http:DELETE /sessions/:sid",
  ]);
});

test("python produces: Flask routes with methods list, Blueprint url_prefix, and <converter:param>", () => {
  const content = `
from flask import Flask, Blueprint
app = Flask(__name__)
bp = Blueprint("billing", __name__, url_prefix="/billing")

@app.route("/ping")
def ping(): ...

@bp.route("/invoices/<int:invoice_id>", methods=["GET", "POST"])
def invoices(invoice_id): ...
`;
  const out = extractPythonSurfaces("src/app.py", content).sort();
  assert.deepEqual(out, [
    "http:GET /billing/invoices/:invoice_id",
    "http:GET /ping",
    "http:POST /billing/invoices/:invoice_id",
  ]);
});

test("python produces: decorators on unknown owners yield nothing", () => {
  assert.deepEqual(extractPythonSurfaces("src/x.py", `@celery.get("/not-a-route")\ndef t(): ...`), []);
});
