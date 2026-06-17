const express = require("express");
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Connexion Turso (persistante, ne s'efface jamais) ──────────────────────
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS progress (
      token TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      ts    INTEGER NOT NULL,
      PRIMARY KEY (token, key)
    )
  `);
}

app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function requireToken(req, res, next) {
  const token = req.headers["x-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Token manquant" });
  const result = await db.execute({
    sql: "SELECT token FROM sessions WHERE token = ?",
    args: [token],
  });
  if (result.rows.length === 0) return res.status(401).json({ error: "Token invalide" });
  req.token = token;
  next();
}

app.post("/api/register", async (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  await db.execute({
    sql: "INSERT INTO sessions (token, created_at) VALUES (?, ?)",
    args: [token, Date.now()],
  });
  res.json({ token });
});

app.post("/api/save", requireToken, async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== "object") return res.status(400).json({ error: "data manquant" });
  const entries = Object.entries(data);
  const ts = Date.now();
  const statements = entries.map(([key, value]) => ({
    sql: `INSERT INTO progress (token, key, value, ts) VALUES (?, ?, ?, ?)
          ON CONFLICT(token, key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
    args: [req.token, key, String(value), ts],
  }));
  if (statements.length > 0) await db.batch(statements, "write");
  res.json({ ok: true, saved: entries.length });
});

app.get("/api/load", requireToken, async (req, res) => {
  const result = await db.execute({
    sql: "SELECT key, value, ts FROM progress WHERE token = ?",
    args: [req.token],
  });
  const data = {};
  for (const row of result.rows) data[row.key] = { value: row.value, ts: row.ts };
  res.json({ ok: true, data });
});

app.delete("/api/clear", requireToken, async (req, res) => {
  await db.execute({ sql: "DELETE FROM progress WHERE token = ?", args: [req.token] });
  res.json({ ok: true });
});

// ── GET /api/save-raw : sauvegarde via URL (bookmarklet iPhone) ───────────
app.get("/api/save-raw", requireToken, async (req, res) => {
  try {
    const raw = req.query.d;
    if (!raw) return res.status(400).send("Donnees manquantes");
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    const entries = Object.entries(data);
    const ts = Date.now();
    const statements = entries.map(([key, value]) => ({
      sql: `INSERT INTO progress (token, key, value, ts) VALUES (?, ?, ?, ?)
            ON CONFLICT(token, key) DO UPDATE SET value=excluded.value, ts=excluded.ts`,
      args: [req.token, key, String(value), ts],
    }));
    if (statements.length > 0) await db.batch(statements, "write");
    const progressKeys = Object.keys(data).filter(k => /Time$|Num$|ID$|Duration$|Titre$/.test(k));
    res.redirect(`/done?ok=1&n=${entries.length}&prog=${progressKeys.length}`);
  } catch(e) {
    res.redirect(`/done?ok=0&msg=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /sync : page de restauration iPhone ────────────────────────────────
app.get("/sync", requireToken, async (req, res) => {
  const result = await db.execute({
    sql: "SELECT key, value FROM progress WHERE token = ?",
    args: [req.token],
  });
  const rows = result.rows;

  if (rows.length === 0) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sekai Sync</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
    .card{background:#13132a;border:1px solid #fff2;border-radius:16px;padding:28px;max-width:340px;width:100%}h1{color:#e2b96f;font-size:18px;margin:12px 0 8px}p{color:#8888bb;font-size:13px}
    button{width:100%;padding:11px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:14px;background:#7b5ea7;color:#fff}</style></head>
    <body><div class="card"><div style="font-size:40px">⛩️</div><h1>Sekai Sync</h1>
    <p>Aucune donnée sauvegardée sur le serveur.<br><br>Sauvegarde d'abord depuis un épisode sur PC.</p>
    <button onclick="history.back()">Retour</button></div></body></html>`);
  }

  const cookiePairs = rows.map(r => {
    return `document.cookie=${JSON.stringify(r.key + '=' + encodeURIComponent(r.value) + '; expires=' + new Date(Date.now()+365*864e5).toUTCString() + '; path=/; SameSite=Lax')};`;
  }).join('');

  const bmCode = 'void function(){' + cookiePairs + 'alert("Sekai Sync : ' + rows.length + ' cookies restaures ! La page va se recharger.");location.reload();}();';
  const bmUrl = 'javascript:' + encodeURIComponent(bmCode);

  const progressRows = rows.filter(r => /Time$|Num$|ID$|Duration$|Titre$/.test(r.key));

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sekai Sync - Restaurer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;padding:20px}
h1{color:#e2b96f;font-size:18px;margin:14px 0 6px;text-align:center}
.icon{text-align:center;font-size:36px;margin-top:10px}
.card{background:#13132a;border:1px solid #fff2;border-radius:12px;padding:16px;margin:14px 0}
.label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6666aa;margin-bottom:8px}
.prog-row{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid #ffffff08}
.prog-key{color:#e2b96f}
.prog-val{color:#d4d4f0;font-family:monospace}
.bm-box{background:#0d0d1a;border:1px solid #333;border-radius:8px;padding:10px;font-family:monospace;font-size:9px;color:#888;word-break:break-all;line-height:1.5;max-height:72px;overflow-y:auto;user-select:all;cursor:pointer;margin:10px 0}
.steps{font-size:12px;color:#8888bb;line-height:1.8}
.steps b{color:#d4d4f0}
button{width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
.btn-copy{background:#7b5ea7;color:#fff}
.btn-back{background:#1c1c38;color:#8888bb;margin-top:6px}
.hint{font-size:11px;color:#6666aa;text-align:center;margin-top:6px}
</style>
</head>
<body>
<div class="icon">⛩️</div>
<h1>Sekai Sync</h1>

${progressRows.length > 0 ? `
<div class="card">
  <div class="label">Progression sauvegardée (${progressRows.length} entrées)</div>
  ${progressRows.map(r => `<div class="prog-row"><span class="prog-key">${r.key}</span><span class="prog-val">${String(r.value).substring(0,20)}</span></div>`).join('')}
</div>` : ''}

<div class="card">
  <div class="label">Comment restaurer sur iPhone</div>
  <div class="steps">
    <b>1.</b> Copie le code ci-dessous<br>
    <b>2.</b> Crée un favori Safari avec ce code comme URL<br>
    <b>3.</b> Va sur <b>sekai.one</b><br>
    <b>4.</b> Appuie sur ce favori → la page se rechargera
  </div>
  <div class="bm-box" id="bm" onclick="copyCode()">${bmUrl.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  <div class="hint">Appuie sur le code pour copier</div>
  <button class="btn-copy" onclick="copyCode()">📋 Copier le code de restauration</button>
  <button class="btn-back" onclick="history.back()">← Retour</button>
</div>

<script>
function copyCode(){
  var txt=document.getElementById('bm').textContent;
  if(navigator.clipboard){
    navigator.clipboard.writeText(txt).then(function(){alert('Code copié !');});
  } else {
    var r=document.createRange();r.selectNode(document.getElementById('bm'));
    window.getSelection().removeAllRanges();window.getSelection().addRange(r);
    document.execCommand('copy');alert('Code copié !');
  }
}
</script>
</body>
</html>`);
});

// ── GET /done : confirmation après sauvegarde iPhone ──────────────────────
app.get("/done", (req, res) => {
  const ok = req.query.ok === "1";
  const n = parseInt(req.query.n || "0");
  const prog = parseInt(req.query.prog || "0");
  const msg = req.query.msg || "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sekai Sync</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
.card{background:#13132a;border:1px solid #fff2;border-radius:16px;padding:28px;max-width:340px;width:100%}
.icon{font-size:40px;margin-bottom:12px}h1{color:#e2b96f;font-size:18px;margin-bottom:10px}
.st{font-size:13px;padding:12px;border-radius:8px;margin-top:10px;line-height:1.6}
.ok{background:#0f2d1f;color:#6be09a;border:1px solid #2a6644}
.err{background:#2d0f0f;color:#e06b6b;border:1px solid #662a2a}
button{width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;background:#7b5ea7;color:#fff}</style></head>
<body><div class="card">
<div class="icon">${ok ? "✅" : "❌"}</div>
<h1>Sekai Sync</h1>
<div class="st ${ok ? "ok" : "err"}">
${ok ? `Sauvegarde OK !<br>${n} cookies enregistrés<br>${prog > 0 ? `dont <b>${prog} cookies de progression</b>` : '<span style="color:#e2b96f">⚠️ Aucun cookie de progression détecté<br>Sauvegarde depuis un épisode, pas la page d\'accueil</span>'}` : `Erreur : ${msg}`}
</div>
<button onclick="history.back()">← Retour sur Sekai</button>
</div></body></html>`);
});

app.get("/", (req, res) => res.json({ status: "Sekai Sync API operationnelle (Turso)" }));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Sekai Sync server sur le port ${PORT}`));
  })
  .catch((err) => {
    console.error("Erreur initialisation DB Turso:", err);
    process.exit(1);
  });
