import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { getWhatsAppState, restartWhatsApp, logoutWhatsApp } from "./whatsapp-bot.js";
import { getConsoleLogs, clearConsoleLogs } from "./live-console.js";
import { listUsers, updateUser, deleteUser, uploadPluginFile, deletePluginFile, isAppwriteEnabled } from "./appwrite-storage.js";

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";
const startedAt = Date.now();
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "./plugins");
const WEB_USERNAME = String(process.env.WA_WEB_USERNAME || "admin").trim();
const WEB_PASSWORD = String(process.env.WA_WEB_PASSWORD || "").trim();
const WEB_SESSION_TTL_MS = Number(process.env.WA_WEB_SESSION_TTL_MS || 86400000);
const webSessions = new Map();
const BODY_LIMIT = Number(process.env.BODY_LIMIT_BYTES || 2 * 1024 * 1024);

function send(res, status, data) {
  const raw = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(raw), "cache-control": "no-store" });
  res.end(raw);
}
function sendHtml(res, html) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); }
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("Payload terlalu besar");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf("="); return i < 0 ? [x, ""] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
}
function webAuthorized(req) {
  const token = parseCookies(req).axynera_session;
  if (!token) return false;
  const session = webSessions.get(token);
  if (!session || session.expiresAt < Date.now()) { webSessions.delete(token); return false; }
  return true;
}
function requireAdmin(req, res, url) {
  if (!WEB_PASSWORD) { send(res, 503, { error: "WA_WEB_PASSWORD belum disetel di environment." }); return false; }
  if (!webAuthorized(req)) { send(res, 401, { error: "Login diperlukan." }); return false; }
  return true;
}
function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera Login</title><style>${css()}body{min-height:100vh;display:grid;place-items:center}.login{width:min(420px,100%);padding:28px;background:#0d1d14;border:1px solid #244b36;border-radius:24px;box-shadow:0 20px 60px #0008}input{width:100%;margin:8px 0 12px}button{width:100%}.logo{font-size:38px;margin-bottom:8px}</style></head><body><main class="login"><div class="logo">🤖</div><h1>Axynera BotWA</h1><p class="muted">Admin Control Center</p><form onsubmit="login(event)"><input id="u" autocomplete="username" placeholder="Username" required><input id="p" type="password" autocomplete="current-password" placeholder="Password" required><button>Login</button></form><div id="m" class="msg"></div></main><script>async function login(e){e.preventDefault();m.textContent='Memeriksa…';const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,password:p.value})});const d=await r.json();if(r.ok)location.href='/wa';else m.textContent=d.error||'Login gagal'}</script></body></html>`;
}
function safePluginName(value) {
  const name = path.basename(String(value || "").trim());
  if (!/^[a-zA-Z0-9._-]+\.(?:js|mjs)$/.test(name)) throw new Error("Nama plugin harus .js/.mjs.");
  return name;
}
function pluginPath(name) {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const safe = safePluginName(name);
  return { safe, target: path.join(PLUGIN_DIR, safe) };
}
function listPlugins() {
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  return fs.readdirSync(PLUGIN_DIR).filter(x => /\.(js|mjs)$/.test(x)).sort().map(name => {
    const stat = fs.statSync(path.join(PLUGIN_DIR, name));
    return { name, size: stat.size, updatedAt: stat.mtimeMs };
  });
}
function healthPayload(index = null) {
  const wa = getWhatsAppState();
  return { ok: true, service: "Axynera WhatsApp Bot", health: index, whatsapp: wa.status, connected: wa.status === "connected", auto_read: wa.autoRead, plugins: wa.pluginCount || 0, about: wa.about || null, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), timestamp: new Date().toISOString() };
}
function uptimePayload(index = null) {
  const wa = getWhatsAppState();
  return { ok: true, service: "Axynera WhatsApp Bot", uptime: index, uptime_seconds: Math.floor((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(), whatsapp: wa.status, connected: wa.status === "connected", timestamp: new Date().toISOString() };
}

function stripCodeFence(text = "") {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:javascript|js|mjs|html)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : raw;
}

async function askNeraForPlugin({ action, prompt, code = "", name = "plugin.js" }) {
  const baseUrl = String(process.env.NERA_AI_BASE_URL || "https://api.axynera.my.id").replace(/\/+$/, "");
  const model = String(process.env.NERA_AI_MODEL || "Nera-Plus.5").trim();
  const apiKey = String(process.env.NERA_AI_API_KEY || "").trim();
  const headers = { "Content-Type": "application/json", "User-Agent": "Axynera-Plugin-Manager/1.0" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let instruction;
  if (action === "render") {
    instruction = `Buat preview dokumentasi HTML untuk plugin WhatsApp Baileys bernama ${name}. Jelaskan fungsi, command, alur, dan contoh pemakaian. Balas HANYA fragmen HTML aman tanpa script.\n\nKode plugin:\n${code}`;
  } else if (action === "edit") {
    instruction = `Perbaiki atau ubah plugin WhatsApp Baileys berikut sesuai permintaan. Balas HANYA kode JavaScript ESM lengkap tanpa markdown/fence. Plugin menerima context { sock, message, media, state, log }. Jangan gunakan dependency baru kecuali sudah bawaan Node atau Baileys.\nPermintaan: ${prompt}\nNama: ${name}\nKode sekarang:\n${code}`;
  } else {
    instruction = `Buat plugin WhatsApp Baileys JavaScript ESM sesuai permintaan. Balas HANYA kode lengkap tanpa markdown/fence. Export default async function plugin({ sock, message, media, state, log }). Jangan gunakan dependency baru kecuali bawaan Node atau Baileys.\nPermintaan: ${prompt}\nNama file: ${name}`;
  }

  const body = { mode: "pintar", stream: false, messages: [{ role: "user", content: instruction }] };
  if (model) body.model = model;
  let response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.NERA_AI_TIMEOUT_MS || 120000)) });
  if (response.status === 403 && body.model) {
    delete body.model;
    response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.NERA_AI_TIMEOUT_MS || 120000)) });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Nera API ${response.status}`);
  const answer = String(data?.choices?.[0]?.message?.content || data?.message || "").trim();
  if (!answer) throw new Error("Nera tidak mengembalikan hasil.");
  return action === "render" ? stripCodeFence(answer) : stripCodeFence(answer);
}

function nav() { return `<nav><a href="/wa">WhatsApp</a><a href="/users">Users</a><a href="/plugins">Plugins</a><a href="/console">Live Console</a></nav>`; }
function css() {
  return `*{box-sizing:border-box}body{margin:0;background:#07110c;color:#edfff4;font:14px system-ui;padding:18px}a{color:#6cf0a0;text-decoration:none}nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px}.wrap{max-width:1200px;margin:auto}.panel{background:#0d1d14;border:1px solid #244b36;border-radius:16px;padding:16px}.top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}input,textarea,button{font:inherit}input,textarea{background:#08150e;color:#effff5;border:1px solid #244b36;border-radius:10px;padding:10px}button,.btn{border:0;border-radius:10px;padding:10px 13px;font-weight:700;cursor:pointer;background:#25d366;color:#05210f}.secondary{background:#254e38;color:#ecfff4}.danger{background:#5a2028;color:#ffe1e5}.muted{color:#94b3a1}.msg{min-height:22px;margin:8px 0}.ok{color:#8ff0b4}.bad{color:#ff9b9b}`;
}
function whatsappPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera WA</title><style>${css()}.qr{min-height:340px;display:grid;place-items:center;background:#fff;border-radius:18px;padding:12px}.qr img{max-width:100%}.empty{color:#173226}</style></head><body><div class="wrap">${nav()}<div class="panel"><h1>WhatsApp Axynera</h1><p class="muted">Auto-read, online presence, dynamic About, memory, dan media aktif.</p><div id="status">Memuat...</div><div class="qr" id="qr"><div class="empty">Menunggu QR...</div></div><div class="top"><button onclick="act('/wa/restart')">Restart WA</button><button class="danger" onclick="logoutWA()">Logout sesi</button></div><div id="meta" class="muted"></div></div></div><script>async function act(u){await fetch(u,{method:'POST'});refresh()}async function logoutWA(){if(confirm('Logout session?'))await act('/wa/logout')}async function refresh(){try{const s=await(await fetch('/wa/status',{cache:'no-store'})).json();status.textContent='Status: '+s.status;qr.innerHTML=s.qrDataUrl?'<img src="'+s.qrDataUrl+'">':'<div class="empty">'+(s.status==='connected'?'WhatsApp sudah terhubung ✅':'QR belum tersedia...')+'</div>';meta.innerHTML='Nomor: '+(s.phone||'-')+' · Plugin: '+(s.pluginCount||0)+' · Auto-read: '+(s.autoRead?'ON':'OFF')+' · Online: '+(s.autoOnline?'ON':'OFF')+'<br>Tentang: '+(s.about||'-')+'<br>Session: '+(s.sessionDir||'-')+'<br>Media: '+(s.mediaDir||'-')}catch(e){status.textContent=e.message}}refresh();setInterval(refresh,2000)</script></body></html>`;
}
function pluginManagerPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera Plugin Studio</title><style>${css()}.grid{display:grid;grid-template-columns:250px minmax(0,1fr);gap:14px}.list button{display:block;width:100%;text-align:left;margin:6px 0;background:#14291d;color:#fff}.editor{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.72fr);gap:12px}textarea{width:100%;min-height:520px;font-family:ui-monospace,monospace;resize:vertical}.aiPrompt{width:min(620px,100%)}iframe{width:100%;height:520px;background:#fff;border:1px solid #244b36;border-radius:12px}.previewEmpty{height:520px;display:grid;place-items:center;border:1px dashed #315f45;border-radius:12px;color:#94b3a1}@media(max-width:900px){.grid,.editor{grid-template-columns:1fr}iframe,.previewEmpty{height:360px}}</style></head><body><div class="wrap">${nav()}<h1>🧩 Axynera Plugin Studio</h1><p class="muted">Buat, edit, upload plugin Baileys dan minta Nera membuat/perbaiki/render preview.</p><div class="top"><input id="upload" type="file" accept=".js,.mjs"><button class="secondary" onclick="uploadFile()">Upload</button><button class="secondary" onclick="newPlugin()">+ Baru</button></div><div class="top"><input id="aiPrompt" class="aiPrompt" placeholder="Contoh: buat command .menu yang menampilkan daftar fitur"><button onclick="aiGenerate('generate')">✨ Buat dengan Nera</button><button class="secondary" onclick="aiGenerate('edit')">🛠️ Perbaiki dengan Nera</button><button class="secondary" onclick="aiGenerate('render')">👁️ Render AI</button></div><div id="msg" class="msg"></div><div class="grid"><div class="panel"><b>Plugin</b><div id="list" class="list"></div></div><div class="panel"><div class="top"><input id="name" placeholder="plugin.js"><button onclick="savePlugin()">💾 Simpan</button><button class="danger" onclick="deletePlugin()">Hapus</button></div><div class="editor"><textarea id="code" spellcheck="false"></textarea><div><iframe id="preview" sandbox="" hidden></iframe><div id="previewEmpty" class="previewEmpty">Preview AI muncul di sini</div></div></div></div></div></div><script>
function setMsg(t,bad=false){msg.textContent=t;msg.className='msg '+(bad?'bad':'ok')}
function h(){return {'content-type':'application/json'}}
async function api(u,o={}){const r=await fetch(u,{...o,headers:{...h(),...(o.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request gagal');return d}
async function loadList(){try{const d=await api('/api/plugins');list.innerHTML=d.plugins.map(p=>'<button onclick="openPlugin(\''+p.name.replace(/'/g,"\\'")+'\')">'+p.name+' <small>('+p.size+' B)</small></button>').join('')||'<span class="muted">Belum ada plugin</span>';setMsg('Terhubung. Plugin: '+d.plugins.length)}catch(e){setMsg(e.message,true)}}
async function openPlugin(n){try{const d=await api('/api/plugins/'+encodeURIComponent(n));name.value=d.name;code.value=d.content;hidePreview();setMsg('Dibuka: '+d.name)}catch(e){setMsg(e.message,true)}}
function newPlugin(){name.value='plugin-baru.js';code.value='export default async function plugin({ sock, message, media, state, log }) {\n  const jid = message?.key?.remoteJid;\n  if (!jid || message?.key?.fromMe) return;\n\n  // Tulis logic plugin di sini\n}\n';hidePreview();setMsg('Plugin baru siap diedit.')}
async function savePlugin(){try{const d=await api('/api/plugins',{method:'POST',body:JSON.stringify({name:name.value,content:code.value})});name.value=d.name;setMsg('Tersimpan ✅ '+d.name+' · auto-load maksimal beberapa detik');loadList()}catch(e){setMsg(e.message,true)}}
async function deletePlugin(){if(!name.value||!confirm('Hapus '+name.value+'?'))return;try{await api('/api/plugins/'+encodeURIComponent(name.value),{method:'DELETE'});name.value='';code.value='';hidePreview();setMsg('Plugin dihapus.');loadList()}catch(e){setMsg(e.message,true)}}
async function uploadFile(){const f=upload.files[0];if(!f)return setMsg('Pilih file .js/.mjs dulu.',true);try{const d=await api('/api/plugins',{method:'POST',body:JSON.stringify({name:f.name,content:await f.text()})});name.value=d.name;code.value=await f.text();setMsg('Upload berhasil ✅ '+d.name);loadList()}catch(e){setMsg(e.message,true)}}
function hidePreview(){preview.hidden=true;previewEmpty.hidden=false;preview.srcdoc=''}
async function aiGenerate(action){try{setMsg(action==='render'?'Nera sedang membuat preview…':'Nera sedang menulis kode…');const d=await api('/api/plugins/ai',{method:'POST',body:JSON.stringify({action,prompt:aiPrompt.value,name:name.value||'plugin-baru.js',code:code.value})});if(action==='render'){previewEmpty.hidden=true;preview.hidden=false;preview.srcdoc=d.result;setMsg('Preview AI selesai ✅')}else{code.value=d.result;setMsg('Kode dari Nera sudah masuk editor. Cek lalu klik Simpan ✅')}}catch(e){setMsg(e.message,true)}}
newPlugin();loadList();
</script></body></html>`;
}
function usersPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Axynera Users</title><style>${css()}.table{display:grid;gap:10px}.user{display:grid;grid-template-columns:minmax(180px,1fr) 180px 110px 130px 90px;gap:10px;align-items:center;background:#0d1d14;border:1px solid #244b36;border-radius:14px;padding:12px}.user input,.user select{width:100%}@media(max-width:800px){.user{grid-template-columns:1fr}.actions{display:flex;gap:8px}}</style></head><body><div class="wrap">${nav()}<div class="panel"><div class="top"><h1 style="margin:0">👥 Users</h1><button onclick="load()">Refresh</button><span id="msg" class="muted"></span></div><p class="muted">LID diambil otomatis dari WhatsApp. Owner dapat mengubah nama, username, role, dan status.</p><div id="list" class="table"></div></div></div><script>
function h(){return {'content-type':'application/json'}}
function esc(v){return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function api(u,o={}){const r=await fetch(u,{...o,headers:{...h(),...(o.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request gagal');return d}
async function save(id){const row=document.querySelector('[data-id="'+CSS.escape(id)+'"]');const body={username:row.querySelector('.username').value,name:row.querySelector('.name').value,role:row.querySelector('.role').value,status:row.querySelector('.status').value};await api('/api/users/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(body)});load()}
async function removeUser(id){if(!confirm('Hapus user ini?'))return;await api('/api/users/'+encodeURIComponent(id),{method:'DELETE'});load()}
async function load(){try{const d=await api('/api/users');list.innerHTML=(d.users||[]).map(u=>\`<div class="user" data-id="\${esc(u.$id)}"><div><b>\${esc(u.name||u.username||'Tanpa nama')}</b><div class="muted">LID: \${esc(u.lid)}</div><div class="muted">Pesan: \${Number(u.message_count||0)} · \${esc(u.last_seen||'-')}</div></div><input class="username" value="\${esc(u.username)}" placeholder="Username"><input class="name" value="\${esc(u.name)}" placeholder="Nama"><select class="role"><option value="user" \${u.role==='user'?'selected':''}>user</option><option value="owner" \${u.role==='owner'?'selected':''}>owner</option></select><select class="status"><option value="active" \${u.status==='active'?'selected':''}>active</option><option value="blocked" \${u.status==='blocked'?'selected':''}>blocked</option></select><div class="actions"><button onclick="save('\${esc(u.$id)}')">Simpan</button><button class="danger" onclick="removeUser('\${esc(u.$id)}')">Hapus</button></div></div>\`).join('')||'<div class="muted">Belum ada user. User muncul otomatis setelah chat masuk.</div>';msg.textContent='Total: '+(d.total||0)}catch(e){msg.textContent=e.message;msg.className='bad'}}load();setInterval(load,10000)
</script></body></html>`;
}
function consolePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Live Console</title><style>${css()}.consoleHead{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.terminal{background:#020805;border:1px solid #1d3b2a;border-radius:16px;min-height:520px;max-height:72vh;overflow:auto;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:inset 0 0 30px #0006}.row{padding:8px 4px;border-bottom:1px solid #102218;white-space:pre-wrap;word-break:break-word;line-height:1.5}.time{color:#607b6a}.ping{color:#7ee2a5}.chat{color:#8bd5ff}.reply{color:#f5d58a}.system{color:#a7b9ad}.err{color:#ff9b9b}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.liveDot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#36e58a;box-shadow:0 0 10px #36e58a;margin-right:6px}.paused .liveDot{background:#dcae45;box-shadow:none}@media(max-width:600px){body{padding:10px}.terminal{min-height:460px;font-size:12px}}</style></head><body><div class="wrap">${nav()}<div class="panel"><div class="consoleHead"><div><h1 style="margin:0">Live Console</h1><div class="muted">Read-only activity monitor · tidak bisa menjalankan command</div></div><div class="toolbar"><button class="secondary" id="pauseBtn" onclick="togglePause()">Pause</button><button class="danger" onclick="clearLogs()">Bersihkan layar</button></div></div><div id="terminal" class="terminal"></div><div id="st" class="muted" style="margin-top:10px"><span class="liveDot"></span>LIVE</div></div></div><script>
let last=0,paused=false,autoScroll=true;
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function format(x){
 const time=new Date(x.time).toLocaleTimeString();
 if(x.type==='ping_success') return '<span class="time">['+time+']</span> <span class="ping">Ping x berhasil ✓</span>';
 if(x.type==='wa_in') return '<span class="time">['+time+']</span> <span class="chat">'+esc(x.contact||x.jid||'User')+': '+esc(x.text||'[media]')+'</span>';
 if(x.type==='ai_response'||x.type==='wa_out') return '<span class="time">['+time+']</span> <span class="reply">'+esc(x.aiName||'Axynity')+': '+esc(x.text||x.body||'[response]')+'</span>';
 if(x.type.includes('error')) return '<span class="time">['+time+']</span> <span class="err">'+esc(x.text||x.error||x.type)+'</span>';
 const detail=x.text||x.error||x.status||x.body||'';
 return '<span class="time">['+time+']</span> <span class="system">'+esc(detail||x.type)+'</span>';
}
function append(x){const div=document.createElement('div');div.className='row';div.innerHTML=format(x);terminal.appendChild(div)}
async function poll(){
 if(paused){st.innerHTML='<span class="liveDot"></span>PAUSED';return}
 try{const r=await fetch('/api/console?after='+last,{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Gagal');
 for(const x of d.logs||[]){last=Math.max(last,x.id);append(x)}
 if((d.logs||[]).length)terminal.scrollTop=terminal.scrollHeight;
 st.innerHTML='<span class="liveDot"></span>LIVE · '+new Date().toLocaleTimeString();
 }catch(e){st.textContent=e.message}
}
function togglePause(){paused=!paused;pauseBtn.textContent=paused?'Resume':'Pause';document.body.classList.toggle('paused',paused);poll()}
async function clearLogs(){await fetch('/api/console',{method:'DELETE'});last=0;terminal.innerHTML=''}
poll();setInterval(poll,1000);
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost"); const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/health") {
      return send(res, 200, { ok: true, service: "axynera-botwa", status: getWhatsAppState().status, uptime: process.uptime(), ts: Date.now() });
    }
    if (req.method === "GET" && p === "/ping") {
      const wa = getWhatsAppState();
      const entry = (await import("./live-console.js")).pushConsoleLog("ping_success", { status: wa.status });
      res.writeHead(204, { "cache-control": "no-store", "x-console-event": String(entry.id) });
      return res.end();
    }
    if (req.method === "POST" && p === "/login") {
      const body = await readJson(req);
      if (!WEB_PASSWORD || String(body.username || "") !== WEB_USERNAME || String(body.password || "") !== WEB_PASSWORD) return send(res, 401, { error: "Username atau password salah." });
      const token = crypto.randomUUID();
      webSessions.set(token, { expiresAt: Date.now() + WEB_SESSION_TTL_MS });
      res.writeHead(200, { "content-type": "application/json", "set-cookie": `axynera_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`, "cache-control": "no-store" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && p === "/logout") {
      const token = parseCookies(req).axynera_session; if (token) webSessions.delete(token);
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "axynera_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" }); return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && p === "/") { if (!webAuthorized(req)) return sendHtml(res, loginPage()); return sendHtml(res, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css()}</style></head><body><div class="wrap">${nav()}<div class="panel"><h1>Axynera WhatsApp Bot</h1><p>Baileys + Nera SSE + memory + image-ready + Plugin Studio.</p></div></div></body></html>`); }
    if (req.method === "GET" && p === "/wa") { if (!webAuthorized(req)) return sendHtml(res, loginPage()); return sendHtml(res, whatsappPage()); }
    if (req.method === "GET" && p === "/plugins") { if (!webAuthorized(req)) return sendHtml(res, loginPage()); return sendHtml(res, pluginManagerPage()); }
    if (req.method === "GET" && p === "/users") { if (!webAuthorized(req)) return sendHtml(res, loginPage()); return sendHtml(res, usersPage()); }
    if (req.method === "GET" && p === "/console") { if (!webAuthorized(req)) return sendHtml(res, loginPage()); return sendHtml(res, consolePage()); }
    if (req.method === "GET" && p === "/wa/status") { if (!requireAdmin(req,res,url)) return; return send(res, 200, getWhatsAppState()); }
    if (req.method === "POST" && p === "/wa/restart") { if (!requireAdmin(req,res,url)) return; return send(res, 200, await restartWhatsApp()); }
    if (req.method === "POST" && p === "/wa/logout") { if (!requireAdmin(req,res,url)) return; return send(res, 200, await logoutWhatsApp()); }

    if (p === "/api/users") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method !== "GET") return send(res, 405, { error: "Method tidak didukung." });
      const result = await listUsers();
      return send(res, 200, { users: result.documents || [], total: Number(result.total || 0) });
    }
    if (p.startsWith("/api/users/")) {
      if (!requireAdmin(req, res, url)) return;
      const id = decodeURIComponent(p.slice("/api/users/".length));
      if (req.method === "PATCH") {
        const body = await readJson(req);
        const user = await updateUser(id, body);
        return send(res, 200, { ok: true, user });
      }
      if (req.method === "DELETE") {
        await deleteUser(id);
        return send(res, 200, { ok: true });
      }
    }

    if (p === "/api/console") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method === "GET") return send(res, 200, { logs: getConsoleLogs(url.searchParams.get("after")) });
      if (req.method === "DELETE") { clearConsoleLogs(); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/plugins/ai") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method !== "POST") return send(res, 405, { error: "Method tidak didukung." });
      const body = await readJson(req);
      const action = ["generate", "edit", "render"].includes(body.action) ? body.action : "generate";
      const name = safePluginName(body.name || "plugin-baru.js");
      if (action !== "render" && !String(body.prompt || "").trim()) return send(res, 400, { error: "Tulis permintaan untuk Nera dulu." });
      const result = await askNeraForPlugin({ action, prompt: String(body.prompt || ""), code: String(body.code || ""), name });
      return send(res, 200, { ok: true, action, name, result });
    }
    if (p === "/api/plugins") {
      if (!requireAdmin(req, res, url)) return;
      if (req.method === "GET") return send(res, 200, { plugins: listPlugins() });
      if (req.method === "POST") {
        const body = await readJson(req);
        const { safe, target } = pluginPath(body.name);
        const content = String(body.content ?? "");
        if (!content.trim()) return send(res, 400, { error: "Kode plugin kosong." });
        if (isAppwriteEnabled()) {
          try {
            await uploadPluginFile(content, safe);
          } catch (error) {
            console.error("[plugins] Appwrite upload failed:", error);
            return send(res, 502, { error: `Gagal menyimpan plugin ke Appwrite: ${error?.message || error}` });
          }
        }
        fs.writeFileSync(target, content, "utf8");
        return send(res, 200, { ok: true, name: safe, size: Buffer.byteLength(content), storage: isAppwriteEnabled() ? "appwrite" : "local" });
      }
    }
    if (p.startsWith("/api/plugins/")) {
      if (!requireAdmin(req, res, url)) return;
      const name = decodeURIComponent(p.slice("/api/plugins/".length));
      const { safe, target } = pluginPath(name);
      if (req.method === "GET") {
        if (!fs.existsSync(target)) return send(res, 404, { error: "Plugin tidak ditemukan." });
        return send(res, 200, { name: safe, content: fs.readFileSync(target, "utf8") });
      }
      if (req.method === "DELETE") {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (isAppwriteEnabled()) await deletePluginFile(safe);
        return send(res, 200, { ok: true, name: safe, storage: isAppwriteEnabled() ? "appwrite" : "local" });
      }
    }

    const healthMatch = p.match(/^\/health(?:[-\/]?([123]))?$/);
    if (req.method === "GET" && healthMatch) return send(res, 200, healthPayload(healthMatch[1] ? Number(healthMatch[1]) : null));
    const uptimeMatch = p.match(/^\/uptime(?:[-\/]?([123]))?$/);
    if (req.method === "GET" && uptimeMatch) return send(res, 200, uptimePayload(uptimeMatch[1] ? Number(uptimeMatch[1]) : null));
    if (req.method === "GET" && p === "/ping") return send(res, 200, healthPayload());
    return send(res, 404, { error: "Endpoint tidak ditemukan." });
  } catch (error) {
    return send(res, 400, { error: error.message || String(error) });
  }
});

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 75000);
server.headersTimeout = server.keepAliveTimeout + 5000;
function shutdown(signal) {
  console.log(`[axynera-wa] Shutdown ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
server.listen(PORT, HOST, () => console.log(`[axynera-wa] online http://${HOST}:${PORT} · /wa · /plugins · /console`));
