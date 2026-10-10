// The door between the phone and R2. Every URL carries a token signed by the Hermes box
// (hermes/bin/upload-link) with UPLOAD_HMAC_SECRET, so nothing here is open to the world.
//
//   GET  /u/<tok>                    upload page (Spanish, phone-first)
//   POST /u/<tok>/create?name=…      start a multipart upload  -> { key, uploadId }
//   PUT  /u/<tok>/part?key&uploadId&n   one ≤50 MB part        -> { n, etag }
//   POST /u/<tok>/complete?key&uploadId  body [{n,etag}]       -> { key, size }
//   GET  /l/<tok>                    list incoming/<p>/ (JSON, for the agent)
//   GET  /d/<tok>                    download one object (Range supported)
//
// Token = base64url(JSON {a: "u"|"l"|"d", p: project, k?: key, x: expiry-epoch-s}) "." base64url(HMAC-SHA256)

const PART = 50 * 1024 * 1024; // the free plan caps a request body at 100 MB
const PROJECT = /^[A-Za-z0-9._-]+$/;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function verify(tok, secret) {
  const [payload, sig] = (tok || "").split(".");
  if (!payload || !sig) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, unb64url(sig), new TextEncoder().encode(payload));
  } catch {}
  if (!ok) return null;
  const t = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  if (!t.x || t.x < Date.now() / 1000 || !PROJECT.test(t.p || "")) return null;
  return t;
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const safeName = (n) => (n || "archivo").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(-80) || "archivo";
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const [, kind, tok, op] = url.pathname.split("/");
    const t = await verify(tok, env.UPLOAD_HMAC_SECRET);
    if (!t || t.a !== kind) return new Response("Enlace no válido o caducado. Pide uno nuevo al bot.", { status: 403 });
    const prefix = `incoming/${t.p}/`;
    const own = (k) => typeof k === "string" && k.startsWith(prefix) && !k.slice(prefix.length).includes("/");

    if (kind === "u") {
      if (!op && req.method === "GET") return new Response(page(t), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (op === "create" && req.method === "POST") {
        const key = prefix + `${stamp()}-${safeName(url.searchParams.get("name"))}`;
        const mp = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: req.headers.get("x-type") || "application/octet-stream" } });
        return json({ key, uploadId: mp.uploadId, part: PART });
      }
      const key = url.searchParams.get("key"), uploadId = url.searchParams.get("uploadId");
      if (!own(key) || !uploadId) return json({ error: "bad key" }, 400);
      const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
      if (op === "part" && req.method === "PUT") {
        const n = Number(url.searchParams.get("n"));
        if (!(n >= 1 && n <= 10000)) return json({ error: "bad part" }, 400);
        const r = await mp.uploadPart(n, req.body);
        return json({ n, etag: r.etag });
      }
      if (op === "complete" && req.method === "POST") {
        const parts = (await req.json()).map((p) => ({ partNumber: p.n, etag: p.etag }));
        const obj = await mp.complete(parts);
        await notify(env, `📥 Subido para «${t.p}»: ${key} (${(obj.size / 1048576).toFixed(1)} MB). Dile al bot «listo».`);
        return json({ key, size: obj.size });
      }
      if (op === "abort" && req.method === "POST") {
        await mp.abort();
        return json({ aborted: key });
      }
      return json({ error: "not found" }, 404);
    }

    if (kind === "l" && req.method === "GET") {
      const out = [];
      let cursor;
      do {
        const r = await env.BUCKET.list({ prefix, cursor });
        for (const o of r.objects) out.push({ key: o.key, size: o.size, uploaded: o.uploaded });
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      return json(out);
    }

    if (kind === "d" && req.method === "GET") {
      if (!t.k || !/^(renders|incoming)\//.test(t.k)) return new Response("not found", { status: 404 });
      const range = req.headers.get("range");
      const obj = await env.BUCKET.get(t.k, range ? { range: req.headers } : {});
      if (!obj) return new Response("Ya no existe.", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("etag", obj.httpEtag);
      h.set("accept-ranges", "bytes");
      h.set("content-disposition", `inline; filename="${t.k.split("/").pop()}"`);
      if (range && obj.range) {
        const { offset = 0, length = obj.size - offset } = obj.range;
        h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        h.set("content-length", String(length));
        return new Response(obj.body, { status: 206, headers: h });
      }
      h.set("content-length", String(obj.size));
      return new Response(obj.body, { headers: h });
    }
    return new Response("not found", { status: 404 });
  },
};

function page(t) {
  const kinds = { media: "el video", voice: "la voz en off", context: "imágenes o clips de referencia", none: "el video" };
  const what = kinds[t.w] || "tus archivos";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subir · ${t.p}</title><style>
body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#111;color:#eee}
h1{font-size:20px;margin:0 0 4px}p{color:#aaa;margin:0 0 20px}
label{display:block;padding:28px;border:2px dashed #555;border-radius:14px;text-align:center;font-size:18px}
input{display:none}.f{margin-top:16px;padding:12px;background:#1d1d1d;border-radius:10px}
.bar{height:8px;background:#333;border-radius:4px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;width:0;background:#f5c518}
.ok{color:#7c7}.err{color:#f66}</style></head><body>
<h1>Subir ${what}</h1><p>Proyecto <b>${t.p}</b>. Puedes cerrar la app de Telegram, pero no esta página, hasta que termine.</p>
<label>Toca para elegir archivos<input id="i" type="file" multiple accept="video/*,audio/*,image/*"></label>
<div id="l"></div>
<script>
const base = location.pathname.replace(/\\/$/, "");
const q = (o) => new URLSearchParams(o).toString();
async function call(path, opt, tries = 4) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(base + path, opt); if (r.ok) return r.json(); throw new Error(r.status + " " + (await r.text())); }
    catch (e) { if (i >= tries) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
}
async function up(file) {
  const row = document.createElement("div"); row.className = "f";
  row.innerHTML = "<div></div><div class=bar><i></i></div><small></small>"; document.getElementById("l").append(row);
  const [name, bar, msg] = [row.children[0], row.querySelector("i"), row.children[2]];
  name.textContent = file.name + " · " + (file.size / 1048576).toFixed(1) + " MB";
  try {
    const { key, uploadId, part } = await call("/create?" + q({ name: file.name }), { method: "POST", headers: { "x-type": file.type } });
    const n = Math.max(1, Math.ceil(file.size / part)), parts = []; let done = 0, next = 1;
    async function worker() {
      while (next <= n) {
        const i = next++;
        const r = await call("/part?" + q({ key, uploadId, n: i }), { method: "PUT", body: file.slice((i - 1) * part, i * part) });
        parts.push(r); done++; bar.style.width = (100 * done / n) + "%";
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    parts.sort((a, b) => a.n - b.n);
    await call("/complete?" + q({ key, uploadId }), { method: "POST", body: JSON.stringify(parts) });
    msg.className = "ok"; msg.textContent = "✓ Listo. Vuelve a Telegram y dile al bot «listo».";
  } catch (e) { msg.className = "err"; msg.textContent = "Falló: " + e.message + ". Inténtalo de nuevo."; }
}
document.getElementById("i").onchange = async (e) => { for (const f of e.target.files) await up(f); };
</script></body></html>`;
}
