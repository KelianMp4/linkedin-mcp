// Test d'intégration léger de la surface de démo : porte de login + CSRF +
// session cookie. Boot un express minimal avec le router, pas de LinkedIn réel.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { demoRouter } from "../src/demo.mjs";

process.env.DEMO_USER = "reviewer";
process.env.DEMO_PASS = "test-pass-123";

function boot() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(demoRouter());
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

test("GET /demo rend la page de login avec un champ CSRF", async () => {
  const { srv, port } = await boot();
  try {
    const res = await fetch(`http://localhost:${port}/demo`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Sign in/);
    assert.match(html, /name="csrf"/);
    assert.match(html, /name="user"/);
  } finally {
    srv.close();
  }
});

test("POST /demo/login sans CSRF valide -> 403", async () => {
  const { srv, port } = await boot();
  try {
    const res = await fetch(`http://localhost:${port}/demo/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user: "reviewer", pass: "test-pass-123", csrf: "bidon" }),
      redirect: "manual",
    });
    assert.equal(res.status, 403);
  } finally {
    srv.close();
  }
});

test("login complet : cookie + CSRF + bons identifiants -> redirection /demo/app", async () => {
  const { srv, port } = await boot();
  try {
    // 1. GET /demo pour récupérer le cookie de session + le csrf.
    const g = await fetch(`http://localhost:${port}/demo`);
    const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
    const csrf = /name="csrf" value="([^"]+)"/.exec(await g.text())?.[1];
    assert.ok(cookie && csrf);

    // 2. POST login avec le même cookie + csrf + bons identifiants.
    const res = await fetch(`http://localhost:${port}/demo/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ user: "reviewer", pass: "test-pass-123", csrf }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/demo/app");
  } finally {
    srv.close();
  }
});

test("mauvais mot de passe -> 401", async () => {
  const { srv, port } = await boot();
  try {
    const g = await fetch(`http://localhost:${port}/demo`);
    const cookie = (g.headers.get("set-cookie") || "").split(";")[0];
    const csrf = /name="csrf" value="([^"]+)"/.exec(await g.text())?.[1];
    const res = await fetch(`http://localhost:${port}/demo/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ user: "reviewer", pass: "MAUVAIS", csrf }),
      redirect: "manual",
    });
    assert.equal(res.status, 401);
  } finally {
    srv.close();
  }
});
