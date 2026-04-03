const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Base de données SQLite ─────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "sekai.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS progress (
    token TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    ts    INTEGER NOT NULL,
    PRIMARY KEY (token, key),
    FOREIGN KEY (token) REFERENCES sessions(token)
  );
`);

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireToken(req, res, next) {
  const token = req.headers["x-token"];
  if (!token) return res.status(401).json({ error: "Token manquant" });
  const row = db.prepare("SELECT token FROM sessions WHERE token = ?").get(token);
  if (!row) return res.status(401).json({ error: "Token invalide" });
  req.token = token;
  next();
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Créer un nouveau token (première utilisation)
app.post("/api/register", (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(token, Date.now());
  res.json({ token });
});

// Sauvegarder la progression
app.post("/api/save", requireToken, (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "data manquant" });
  }
  const upsert = db.prepare(`
    INSERT INTO progress (token, key, value, ts) VALUES (?, ?, ?, ?)
    ON CONFLICT(token, key) DO UPDATE SET value=excluded.value, ts=excluded.ts
  `);
  const insert = db.transaction((entries) => {
    for (const [key, value] of entries) {
      upsert.run(req.token, key, String(value), Date.now());
    }
  });
  insert(Object.entries(data));
  res.json({ ok: true, saved: Object.keys(data).length });
});

// Charger la progression
app.get("/api/load", requireToken, (req, res) => {
  const rows = db.prepare("SELECT key, value, ts FROM progress WHERE token = ?").all(req.token);
  const data = {};
  for (const row of rows) data[row.key] = { value: row.value, ts: row.ts };
  res.json({ ok: true, data });
});

// Supprimer toutes les données d'un token
app.delete("/api/clear", requireToken, (req, res) => {
  db.prepare("DELETE FROM progress WHERE token = ?").run(req.token);
  res.json({ ok: true });
});

// Sanity check
app.get("/", (req, res) => res.json({ status: "Sekai Sync API opérationnelle 🎌" }));

app.listen(PORT, () => console.log(`Sekai Sync server démarré sur le port ${PORT}`));
