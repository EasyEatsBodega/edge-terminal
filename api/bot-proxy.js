// ═══════════════════════════════════════════════════════════════════════════════
// EDGE TERMINAL — Bot Proxy
// Proxies HTTPS requests from the dashboard to the HTTP-only VPS bot.
// Fixes the "Mixed Content" browser block (HTTPS dashboard can't fetch HTTP).
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_BOT_URL = "http://142.93.228.49:3069";

export default async function handler(req, res) {
  // CORS headers for frontend
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { path = "state", secret, botUrl } = req.query;
  if (!secret) {
    return res.status(400).json({ error: "Missing secret" });
  }

  // Allow overriding the bot URL via query param, otherwise use default
  const base = (botUrl || DEFAULT_BOT_URL).replace(/\/+$/, "");
  // Whitelist paths to prevent abuse
  const allowedPaths = new Set(["state", "run", "log"]);
  const cleanPath = String(path).replace(/[^a-z0-9_/-]/gi, "");
  if (!allowedPaths.has(cleanPath)) {
    return res.status(403).json({ error: "Path not allowed" });
  }

  const target = `${base}/${cleanPath}?secret=${encodeURIComponent(secret)}`;

  try {
    const upstream = await fetch(target, {
      method: "GET",
      headers: { "x-bot-secret": secret },
      // Vercel serverless has a 10s default timeout for fetches
      signal: AbortSignal.timeout(8000),
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = await upstream.text();

    res.setHeader("Content-Type", contentType);
    res.status(upstream.status).send(body);
  } catch (e) {
    return res.status(502).json({
      error: "Bot unreachable",
      detail: e.message,
      target: target.replace(/secret=[^&]+/, "secret=***"),
    });
  }
}
