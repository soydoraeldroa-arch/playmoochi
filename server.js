/**
 * Smooch — Standalone rate-limited invite code validation server.
 *
 * Validates invite codes from a local JSON file with server-side
 * rate limiting to prevent brute-force attacks.
 *
 * POST /api/validate  { code: "ABCDEFGH" }
 *   → { success: true, tier: "invited" }
 *   → { success: false, error: "Code not found" }
 *   → { success: false, error: "Too many attempts..." }  (HTTP 429)
 *
 * GET /api/health → { ok: true }
 *
 * Admin (secret key required):
 *   POST /api/admin/add      { code: "ABCDEFGH", tier: "invited" }
 *   POST /api/admin/remove   { code: "ABCDEFGH" }
 *   GET  /api/admin/list
 *
 * Deploy: node server.js
 * Env: PORT (default 3000), ADMIN_SECRET
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// --- Local code store ---
const CODES_FILE = path.join(__dirname, "codes.json");
let codeStore = JSON.parse(fs.readFileSync(CODES_FILE, "utf8"));

function saveCodes() {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codeStore, null, 2), "utf8");
}

function findCode(raw) {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return codeStore.codes[code] || null;
}

function markCodeConsumed(code) {
  if (codeStore.codes[code]) {
    codeStore.codes[code].consumed = true;
    codeStore.codes[code].consumedAt = new Date().toISOString();
    saveCodes();
  }
}

// --- Rate limiting (in-memory) ---
const MAX_ATTEMPTS_PER_IP = 5;
const MAX_ATTEMPTS_GLOBAL = 50;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const attemptsByIp = new Map();
let globalAttempts = [];

function cleanup() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [ip, attempts] of attemptsByIp) {
    attemptsByIp.set(ip, attempts.filter(a => a.ts > cutoff));
    if (attemptsByIp.get(ip).length === 0) attemptsByIp.delete(ip);
  }
  globalAttempts = globalAttempts.filter(a => a.ts > cutoff);
}

setInterval(cleanup, 10 * 60 * 1000);

function countIpAttempts(ip) {
  return (attemptsByIp.get(ip) || []).length;
}

function countGlobalAttempts() {
  return globalAttempts.length;
}

function recordAttempt(ip, code, success) {
  const entry = { ts: Date.now(), code, success };
  if (!attemptsByIp.has(ip)) attemptsByIp.set(ip, []);
  attemptsByIp.get(ip).push(entry);
  globalAttempts.push(entry);
}

// --- Helpers ---
function isValidFormat(code) {
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code);
}

function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket.remoteAddress
    || "unknown";
}

function authAdmin(req, res) {
  const secret = process.env.ADMIN_SECRET || "";
  if (!secret) {
    res.status(500).json({ error: "Admin not configured (set ADMIN_SECRET)" });
    return false;
  }
  const provided = req.headers["x-admin-secret"] || req.query.secret;
  if (provided !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- Routes ---

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), codes: Object.keys(codeStore.codes).length });
});

app.post("/api/validate", (req, res) => {
  const ip = getIp(req);
  const rawCode = (req.body?.code || "").toString().trim();

  if (!rawCode) {
    return res.status(400).json({ success: false, error: "Code is required" });
  }

  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Reject malformed codes without counting against rate limit
  if (!isValidFormat(code)) {
    return res.status(400).json({ success: false, error: "Invalid code format. Must be 8 characters." });
  }

  // Rate limit: per-IP
  if (countIpAttempts(ip) >= MAX_ATTEMPTS_PER_IP) {
    return res.status(429).json({
      success: false,
      error: "Too many attempts. Please wait an hour before trying again.",
    });
  }

  // Rate limit: global
  if (countGlobalAttempts() >= MAX_ATTEMPTS_GLOBAL) {
    return res.status(429).json({
      success: false,
      error: "Too many attempts from all users. Please try again later.",
    });
  }

  const entry = findCode(code);

  if (!entry) {
    recordAttempt(ip, code, false);
    return res.json({ success: false, error: "Code not found." });
  }

  // Already consumed (unless founding tier)
  if (entry.consumed && entry.tier !== "founding") {
    recordAttempt(ip, code, false);
    return res.json({ success: false, error: "This code has already been used." });
  }

  // Expired
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
    recordAttempt(ip, code, false);
    return res.json({ success: false, error: "This code has expired." });
  }

  // Success — mark consumed
  markCodeConsumed(code);
  recordAttempt(ip, code, true);
  const tier = entry.tier || "invited";

  return res.json({
    success: true,
    tier,
    message: tier === "founding"
      ? "Founding couple — unlimited sharing allowed"
      : `Welcome! You're in as a ${tier}.`,
  });
});

// --- Admin routes ---

app.post("/api/admin/add", (req, res) => {
  if (!authAdmin(req, res)) return;
  const { code, tier, expiresAt } = req.body || {};
  const normalized = code?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized || !isValidFormat(normalized)) {
    return res.status(400).json({ error: "Valid 8-char code required" });
  }
  if (codeStore.codes[normalized]) {
    return res.status(409).json({ error: "Code already exists" });
  }
  codeStore.codes[normalized] = {
    tier: tier || "invited",
    consumed: false,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
  };
  saveCodes();
  res.json({ ok: true, code: normalized, tier: codeStore.codes[normalized].tier });
});

app.post("/api/admin/remove", (req, res) => {
  if (!authAdmin(req, res)) return;
  const { code } = req.body || {};
  const normalized = code?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!normalized) return res.status(400).json({ error: "Code required" });
  if (!codeStore.codes[normalized]) {
    return res.status(404).json({ error: "Code not found" });
  }
  delete codeStore.codes[normalized];
  saveCodes();
  res.json({ ok: true, removed: normalized });
});

app.get("/api/admin/list", (req, res) => {
  if (!authAdmin(req, res)) return;
  const codes = Object.entries(codeStore.codes).map(([code, data]) => ({
    code,
    ...data,
  }));
  res.json({ codes, total: codes.length });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
// In production (Railway/Render), bind to 0.0.0.0. Override with HOST=localhost for local dev.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
app.listen(PORT, HOST, () => {
  console.log(`✅ Smooch validation server running on ${HOST}:${PORT}`);
  console.log(`   Health: http://${HOST}:${PORT}/api/health`);
  console.log(`   Validate: POST http://${HOST}:${PORT}/api/validate`);
  if (process.env.ADMIN_SECRET) {
    console.log(`   Admin: POST http://${HOST}:${PORT}/api/admin/add (with x-admin-secret header)`);
  }
  if (HOST === '127.0.0.1') {
    console.log(`   🔒 Bound to localhost only — not accessible from external networks`);
  } else {
    console.log(`   🌍 Bound to all interfaces — accessible externally`);
  }
});
