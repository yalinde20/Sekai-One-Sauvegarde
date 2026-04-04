const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireToken(req, res, next) {
  const token = req.headers["x-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Token manquant" });
  const row = db.prepare("SELECT token FROM sessions WHERE token = ?").get(token);
  if (!row) return res.status(401).json({ error: "Token invalide" });
  req.token = token;
  next();
}

app.post("/api/register", (req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, created_at) VALUES (?, ?)").run(token, Date.now());
  res.json({ token });
});

app.post("/api/save", requireToken, (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== "object") return res.status(400).json({ error: "data manquant" });
  const upsert = db.prepare(`
    INSERT INTO progress (token, key, value, ts) VALUES (?, ?, ?, ?)
    ON CONFLICT(token, key) DO UPDATE SET value=excluded.value, ts=excluded.ts
  `);
  const insert = db.transaction((entries) => {
    for (const [key, value] of entries) upsert.run(req.token, key, String(value), Date.now());
  });
  insert(Object.entries(data));
  res.json({ ok: true, saved: Object.keys(data).length });
});

app.get("/api/load", requireToken, (req, res) => {
  const rows = db.prepare("SELECT key, value, ts FROM progress WHERE token = ?").all(req.token);
  const data = {};
  for (const row of rows) data[row.key] = { value: row.value, ts: row.ts };
  res.json({ ok: true, data });
});

app.delete("/api/clear", requireToken, (req, res) => {
  db.prepare("DELETE FROM progress WHERE token = ?").run(req.token);
  res.json({ ok: true });
});

// ── Page /sync ─────────────────────────────────────────────────────────────
// Le bookmarklet ouvre cette page dans un nouvel onglet (window.open).
// Elle communique avec sekai.one via postMessage pour lire/écrire le localStorage
// sans jamais y accéder directement, ce qui contourne la restriction Safari iOS.
app.get("/sync", requireToken, (req, res) => {
  const action = req.query.action || "save";
  const token = req.query.token;
  const serverUrl = `${req.protocol}://${req.get("host")}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sekai Sync</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
.card{background:#13132a;border:1px solid #ffffff18;border-radius:16px;padding:32px 28px;max-width:340px;width:100%}
.icon{font-size:48px;margin-bottom:16px}
h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#e2b96f}
p{font-size:14px;color:#8888bb;line-height:1.6;margin-bottom:16px}
.status{font-size:13px;padding:10px 16px;border-radius:8px;margin-top:12px}
.status.ok{background:#0f2d1f;color:#6be09a;border:1px solid #2a6644}
.status.err{background:#2d0f0f;color:#e06b6b;border:1px solid #662a2a}
.status.loading{background:#1c1c38;color:#8888bb;border:1px solid #333366}
button{width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;background:#7b5ea7;color:#fff}
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#x26E9;&#xFE0F;</div>
  <h1>Sekai Sync</h1>
  <p>${action === "save" ? "Sauvegarde de ta progression..." : "Restauration de ta progression..."}</p>
  <div class="status loading" id="st">Connexion a Sekai.one...</div>
  <button id="btn" style="display:none" onclick="window.close()">Fermer</button>
</div>
<script>
var SRV='${serverUrl}',TK='${token}',ACT='${action}';
var st=document.getElementById('st'),btn=document.getElementById('btn');
function done(ok,msg){st.className='status '+(ok?'ok':'err');st.textContent=msg;btn.style.display='block';}
function save(data){
  fetch(SRV+'/api/save',{method:'POST',headers:{'Content-Type':'application/json','X-Token':TK},body:JSON.stringify({data:data})})
  .then(function(r){return r.json();})
  .then(function(){done(true,'Sauvegarde OK ! '+Object.keys(data).length+' cle(s)');})
  .catch(function(e){done(false,'Erreur : '+e.message);});
}
function load(){
  fetch(SRV+'/api/load',{headers:{'X-Token':TK}})
  .then(function(r){return r.json();})
  .then(function(j){
    if(window.opener){
      window.opener.postMessage({sekaiSync:'restore',data:j.data},'https://sekai.one');
      done(true,'Restauration envoyee a Sekai.one !');
    } else {
      done(false,'Garde Sekai.one ouvert en arriere-plan.');
    }
  })
  .catch(function(e){done(false,'Erreur : '+e.message);});
}
if(ACT==='save'){
  if(window.opener){
    st.textContent='Lecture localStorage...';
    window.addEventListener('message',function h(e){
      if(e.origin!=='https://sekai.one')return;
      if(e.data&&e.data.sekaiSync==='data'){
        window.removeEventListener('message',h);
        st.textContent='Envoi au serveur...';
        save(e.data.payload);
      }
    });
    window.opener.postMessage({sekaiSync:'get'},'https://sekai.one');
    setTimeout(function(){if(st.className.indexOf('loading')>-1){done(false,'Sekai.one ne repond pas. Recharge la page Sekai puis reessaie.');}},5000);
  } else {
    done(false,'Garde Sekai.one ouvert avant de taper sur le favori.');
  }
} else {
  load();
}
</script>
</body>
</html>`);
});

app.get("/", (req, res) => res.json({ status: "Sekai Sync API operationnelle" }));
app.listen(PORT, () => console.log(`Sekai Sync server sur le port ${PORT}`));
