// functions/_middleware.js
// このサイトへの全リクエストに HTTP Basic 認証を要求する Cloudflare Pages Function。
// data.json を含む全アセットが next() 通過後にのみ配信されるため、ページもデータも保護される。
//
// 資格情報は Cloudflare Pages の環境変数から読む（コードにハードコードしない）:
//   BASIC_AUTH_USER … ログインID
//   BASIC_AUTH_PASS … パスワード
// ダッシュボードの Settings → Environment variables で「Encrypt」して登録すること。

export const onRequest = async (context) => {
  const { request, env, next } = context;

  const expectedUser = env.BASIC_AUTH_USER;
  const expectedPass = env.BASIC_AUTH_PASS;

  // 環境変数が未設定なら「全公開」にフォールバックせず閉じる（構成ミスでの情報漏れ防止）。
  if (!expectedUser || !expectedPass) {
    return new Response("Auth not configured.", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const header = request.headers.get("Authorization") || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {
      decoded = "";
    }
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
        return next(); // 認証OK → 静的アセット（index.html / data.json など）を配信
      }
    }
  }

  // 未認証 / 不一致 → ブラウザ標準のID・パスワード入力ダイアログを出す。
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="yfinance screener", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
};

// タイミング攻撃を避けるための定数時間比較。
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
