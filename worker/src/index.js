/**
 * ============================================================
 * NicoList Share API - Cloudflare Worker + D1
 * ============================================================
 * 
 * POST /api/share     : リストデータをD1に保存し、短いIDを発行
 * GET  /api/share/:id : IDからリストデータを取得
 * Scheduled (Cron)    : 30日超の古いデータと古いレートリミット記録を削除
 * 
 * セキュリティ:
 *   - ペイロードサイズ制限 (500KB)
 *   - JSONバリデーション
 *   - IPベースのレートリミット (1分間に5回まで POST 可能)
 *   - 30日後の自動削除
 */

// ─── 設定 ─────────────────────────────────────
const RATE_LIMIT_WINDOW = 60;   // 秒（1分間）
const RATE_LIMIT_MAX = 5;       // ウィンドウ内の最大POST回数
const MAX_PAYLOAD_BYTES = 500000; // 500KB
const SHARE_ID_LENGTH = 6;
const DATA_TTL_SECONDS = 30 * 24 * 60 * 60; // 30日

// ─── ユーティリティ ──────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function generateShortId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < SHARE_ID_LENGTH; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getClientIP(request) {
  // Cloudflare が自動で付与するヘッダー（偽装不可）
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

// ─── レートリミット ──────────────────────────────

async function checkRateLimit(db, ip) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;

  // 現在のウィンドウ内のリクエスト数をカウント
  const result = await db.prepare(
    "SELECT COUNT(*) as cnt FROM rate_limits WHERE ip = ? AND ts > ?"
  ).bind(ip, windowStart).first();

  const count = result?.cnt || 0;

  if (count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetIn: RATE_LIMIT_WINDOW };
  }

  // 今回のリクエストを記録
  await db.prepare("INSERT INTO rate_limits (ip, ts) VALUES (?, ?)")
    .bind(ip, now).run();

  return { allowed: true, remaining: RATE_LIMIT_MAX - count - 1 };
}

// ─── メインハンドラ ──────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // CORS プリフライト
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // ─── POST /api/share ───
    if (request.method === "POST" && url.pathname === "/api/share") {
      const ip = getClientIP(request);

      // 1. レートリミットチェック
      const rateCheck = await checkRateLimit(env.DB, ip);
      if (!rateCheck.allowed) {
        return jsonResponse(
          { error: "リクエストが多すぎます。1分後に再試行してください。" },
          429
        );
      }

      // 2. サイズチェック
      const contentLength = request.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > MAX_PAYLOAD_BYTES) {
        return jsonResponse({ error: "Payload too large" }, 413);
      }

      try {
        const bodyText = await request.text();
        if (bodyText.length > MAX_PAYLOAD_BYTES) {
          return jsonResponse({ error: "Payload too large" }, 413);
        }

        // 3. JSONバリデーション
        const parsed = JSON.parse(bodyText);

        // 4. 最低限の構造チェック（NicoList形式であることを確認）
        if (!parsed.v || !parsed.d || !Array.isArray(parsed.d)) {
          return jsonResponse({ error: "Invalid data format" }, 400);
        }

        let id = parsed.i;
        if (id && /^[A-Za-z0-9]{6}$/.test(id)) {
          // 既存のIDがあれば上書き（UPSERT）
          await env.DB.prepare("INSERT INTO shared_lists (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, created_at=unixepoch()")
            .bind(id, bodyText)
            .run();
        } else {
          // 5. 重複しないIDを生成（最大5回リトライ）
          id = generateShortId();
          for (let attempts = 0; attempts < 5; attempts++) {
            const existing = await env.DB.prepare(
              "SELECT id FROM shared_lists WHERE id = ?"
            ).bind(id).first();
            if (!existing) break;
            id = generateShortId();
          }

          // 6. DBに新規保存
          await env.DB.prepare("INSERT INTO shared_lists (id, data) VALUES (?, ?)")
            .bind(id, bodyText)
            .run();
        }

        return jsonResponse({ id, remaining: rateCheck.remaining });

      } catch (e) {
        if (e instanceof SyntaxError) {
          return jsonResponse({ error: "Invalid JSON" }, 400);
        }
        console.error("POST /api/share error:", e);
        return jsonResponse({ error: "Server Error" }, 500);
      }
    }

    // ─── GET /api/share/:id ───
    if (request.method === "GET" && url.pathname.startsWith("/api/share/")) {
      const id = url.pathname.replace("/api/share/", "");

      if (!id || id.length > 10 || !/^[A-Za-z0-9]+$/.test(id)) {
        return jsonResponse({ error: "Invalid ID" }, 400);
      }

      const result = await env.DB.prepare(
        "SELECT data FROM shared_lists WHERE id = ?"
      ).bind(id).first();

      if (!result) {
        return jsonResponse({ error: "Not found" }, 404);
      }

      return new Response(result.data, {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders() }
      });
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },

  // ─── 定期実行（Cron トリガー） ───
  async scheduled(event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);

    try {
      // 30日以上前の共有データを削除
      const dataResult = await env.DB.prepare(
        "DELETE FROM shared_lists WHERE created_at < ?"
      ).bind(now - DATA_TTL_SECONDS).run();
      console.log(`[Cron] Deleted ${dataResult.meta.changes} expired shared lists`);

      // 5分以上前のレートリミット記録を削除（テーブル肥大化防止）
      const rateResult = await env.DB.prepare(
        "DELETE FROM rate_limits WHERE ts < ?"
      ).bind(now - 300).run();
      console.log(`[Cron] Deleted ${rateResult.meta.changes} old rate limit records`);
    } catch (e) {
      console.error("[Cron] Cleanup failed:", e);
    }
  }
};
