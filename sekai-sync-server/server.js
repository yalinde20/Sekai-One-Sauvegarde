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

app.use(express.json({ limit: "2mb" }));
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

// ── POST /api/save-raw : reçoit les données encodées en base64 depuis l'URL ──
// Utilisé par le bookmarklet iPhone qui ne peut pas faire de fetch cross-origin
app.get("/api/save-raw", requireToken, (req, res) => {
  try {
    const raw = req.query.d;
    if (!raw) return res.status(400).send("Données manquantes");
    const data = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const upsert = db.prepare(`
      INSERT INTO progress (token, key, value, ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(token, key) DO UPDATE SET value=excluded.value, ts=excluded.ts
    `);
    const insert = db.transaction((entries) => {
      for (const [key, value] of entries) upsert.run(req.token, key, String(value), Date.now());
    });
    insert(Object.entries(data));
    // Redirige vers la page de succès
    res.redirect(`/done?ok=1&n=${Object.keys(data).length}&action=save`);
  } catch(e) {
    res.redirect(`/done?ok=0&msg=${encodeURIComponent(e.message)}&action=save`);
  }
});

// ── GET /sync : page de restauration (charge les données et injecte dans sekai.one) ──
app.get("/sync", requireToken, (req, res) => {
  const token = req.query.token;
  const serverUrl = `${req.protocol}://${req.get("host")}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sekai Sync - Restauration</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
.card{background:#13132a;border:1px solid #ffffff18;border-radius:16px;padding:32px 28px;max-width:340px;width:100%}
.icon{font-size:40px;margin-bottom:14px}
h1{font-size:19px;font-weight:600;margin-bottom:6px;color:#e2b96f}
p{font-size:13px;color:#8888bb;margin-bottom:14px;line-height:1.5}
.st{font-size:13px;padding:10px 14px;border-radius:8px;margin-top:10px}
.st.ok{background:#0f2d1f;color:#6be09a;border:1px solid #2a6644}
.st.err{background:#2d0f0f;color:#e06b6b;border:1px solid #662a2a}
.st.loading{background:#1c1c38;color:#8888bb;border:1px solid #333366}
button{width:100%;padding:11px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:10px;background:#7b5ea7;color:#fff}
.bm{background:#1c1c38;border:1px solid #333;border-radius:8px;padding:10px;font-family:monospace;font-size:9px;color:#999;word-break:break-all;margin-top:10px;text-align:left;line-height:1.4;max-height:80px;overflow-y:auto;user-select:all;cursor:pointer}
.hint{font-size:11px;color:#6666aa;margin-top:8px}
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#x26E9;&#xFE0F;</div>
  <h1>Sekai Sync</h1>
  <p>Restauration de ta progression sur Sekai.one</p>
  <div class="st loading" id="st">Chargement depuis le serveur...</div>
  <div id="extra"></div>
  <button id="btn" style="display:none" onclick="window.close()">Fermer</button>
</div>
<script>
var SRV='${serverUrl}',TK='${token}';
var st=document.getElementById('st'),btn=document.getElementById('btn'),extra=document.getElementById('extra');
function done(ok,msg){st.className='st '+(ok?'ok':'err');st.textContent=msg;btn.style.display='block';}

fetch(SRV+'/api/load',{headers:{'X-Token':TK}})
  .then(function(r){
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  })
  .then(function(j){
    var entries=Object.entries(j.data);
    if(entries.length===0){done(true,'Aucune donnee sauvegardee sur le serveur.');return;}
    
    // Encode les données dans un bookmarklet d'injection
    // Ce bookmarklet va s'exécuter sur sekai.one et injecter directement les données
    var pairs=[];
    for(var i=0;i<entries.length;i++){
      var k=entries[i][0],v=entries[i][1].value;
      pairs.push([JSON.stringify(k),JSON.stringify(v)]);
    }
    var lines=pairs.map(function(p){return 'localStorage.setItem('+p[0]+','+p[1]+');'});
    var code='void function(){'+lines.join('')+'alert("Sekai Sync : '+entries.length+' cle(s) restauree(s) !");}();';
    var bm='javascript:'+encodeURIComponent(code);
    
    st.className='st ok';
    st.textContent=''+entries.length+' cle(s) chargee(s) ! Etape suivante :';
    
    extra.innerHTML='<p style="color:#d4d4f0;font-size:12px;margin-top:10px">1. Retourne sur Sekai.one<br>2. Appuie sur le favori <strong>Sekai Restore</strong> ci-dessous</p>'
      +'<div class="bm" id="bm-code" onclick="copyBm()">'+escHtml(bm)+'</div>'
      +'<div class="hint">Appuie pour copier, puis colle dans un favori Safari</div>';
    btn.style.display='block';
    
    // Tente aussi via window.opener si disponible
    if(window.opener && !window.opener.closed){
      try{
        window.opener.postMessage({sekaiSync:'restore',data:j.data},'https://sekai.one');
        st.textContent='Restauration envoyee directement a Sekai.one !';
        extra.innerHTML='';
      }catch(e){}
    }
  })
  .catch(function(e){done(false,'Erreur : '+e.message);});

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function copyBm(){
  var el=document.getElementById('bm-code');
  if(navigator.clipboard){navigator.clipboard.writeText(el.textContent).then(function(){alert('Code copie !');});}
  else{var r=document.createRange();r.selectNode(el);window.getSelection().removeAllRanges();window.getSelection().addRange(r);document.execCommand('copy');alert('Code copie !');}
}
</script>
</body>
</html>`);
});

// ── GET /done : page de confirmation après sauvegarde ──────────────────────
app.get("/done", (req, res) => {
  const ok = req.query.ok === "1";
  const n = req.query.n || "0";
  const msg = req.query.msg || "";
  const action = req.query.action || "save";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sekai Sync</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0d1a;color:#d4d4f0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;text-align:center}
.card{background:#13132a;border:1px solid #ffffff18;border-radius:16px;padding:32px 28px;max-width:340px;width:100%}
.icon{font-size:40px;margin-bottom:14px}
h1{font-size:19px;font-weight:600;margin-bottom:6px;color:#e2b96f}
.st{font-size:14px;padding:12px 16px;border-radius:8px;margin-top:12px}
.st.ok{background:#0f2d1f;color:#6be09a;border:1px solid #2a6644}
.st.err{background:#2d0f0f;color:#e06b6b;border:1px solid #662a2a}
button{width:100%;padding:11px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-top:12px;background:#7b5ea7;color:#fff}
</style>
</head>
<body>
<div class="card">
  <div class="icon">${ok ? "✅" : "❌"}</div>
  <h1>Sekai Sync</h1>
  <div class="st ${ok ? "ok" : "err"}">
    ${ok
      ? (action === "save" ? `Sauvegarde OK — ${n} cle(s) enregistree(s) !` : `Restauration OK !`)
      : `Erreur : ${msg}`}
  </div>
  <button onclick="window.close()">Fermer</button>
</div>
</body>
</html>`);
});

app.get("/", (req, res) => res.json({ status: "Sekai Sync API operationnelle" }));
app.listen(PORT, () => console.log(`Sekai Sync server sur le port ${PORT}`));
