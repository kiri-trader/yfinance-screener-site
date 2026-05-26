"use strict";

// 日本株スクリーニング結果サイトのログインゲート（Cloudflare Worker）。
// 認証を通過したリクエストにのみ _site の静的アセット(env.ASSETS)を返す。
// 必須の Secret(環境変数): AUTH_USER / AUTH_PASS / AUTH_SECRET(Cookie署名鍵)

const COOKIE = "yss_auth";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7日（秒）
const enc = new TextEncoder();

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// トークン = "<失効UNIX秒>.<HMAC(secret, 失効秒)>"。Cookie改ざんを署名で防ぐ。
async function issueToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return `${exp}.${await hmacHex(secret, String(exp))}`;
}

async function tokenValid(secret, token) {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const exp = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return sig === await hmacHex(secret, exp);
}

function cookieOf(header, name) {
  for (const part of (header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function loginPage(failed) {
  const msg = failed ? '<p class="err">ユーザー名またはパスワードが違います。</p>' : "";
  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン｜日本株スクリーニング結果</title>
<style>
  :root{--bg:#0f1419;--panel:#171d26;--border:#2a3441;--text:#d8dee9;--dim:#8a97a8;--accent:#4ea1ff}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:var(--bg);color:var(--text);
    font:14px/1.5 -apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",Meiryo,sans-serif}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;
    padding:28px 26px;width:320px;max-width:90vw}
  h1{font-size:17px;margin:0 0 4px}
  .sub{color:var(--dim);font-size:12px;margin:0 0 18px}
  label{display:block;font-size:12px;color:var(--dim);margin:12px 0 4px}
  input{width:100%;background:#1d2531;color:var(--text);border:1px solid var(--border);
    border-radius:7px;padding:9px 10px;font:inherit}
  input:focus{outline:none;border-color:var(--accent)}
  button{width:100%;margin-top:18px;background:var(--accent);color:#0f1419;border:0;
    border-radius:7px;padding:10px;font:inherit;font-weight:700;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  .err{color:#ff5c5c;font-size:12px;margin:12px 0 0}
</style></head>
<body>
  <form class="card" method="POST" action="/__login">
    <h1>🇯🇵 日本株スクリーニング結果</h1>
    <p class="sub">続行するにはログインしてください。</p>
    <label for="user">ユーザー名</label>
    <input id="user" name="user" autocomplete="username" autofocus required>
    <label for="pass">パスワード</label>
    <input id="pass" name="pass" type="password" autocomplete="current-password" required>
    <button type="submit">ログイン</button>
    ${msg}
  </form>
</body></html>`;
  return new Response(html, {
    status: failed ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const COOKIE_ATTRS = "Path=/; HttpOnly; Secure; SameSite=Lax";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.AUTH_USER || !env.AUTH_PASS || !env.AUTH_SECRET) {
      return new Response("認証情報(AUTH_USER/AUTH_PASS/AUTH_SECRET)が未設定です。", {
        status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/__logout") {
      return new Response(null, { status: 302,
        headers: { "Location": "/", "Set-Cookie": `${COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0` } });
    }

    if (url.pathname === "/__login" && request.method === "POST") {
      const form = await request.formData();
      if (form.get("user") === env.AUTH_USER && form.get("pass") === env.AUTH_PASS) {
        const token = await issueToken(env.AUTH_SECRET);
        return new Response(null, { status: 302,
          headers: { "Location": "/", "Set-Cookie": `${COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL}` } });
      }
      return loginPage(true);
    }

    if (await tokenValid(env.AUTH_SECRET, cookieOf(request.headers.get("Cookie"), COOKIE))) {
      return env.ASSETS.fetch(request);
    }
    return loginPage(false);
  },
};
