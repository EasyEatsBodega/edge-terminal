// ═══════════════════════════════════════════════════════════════════════════════
// EDGE TERMINAL — Bot State Reader
// Returns the bot's current state from Redis for the dashboard.
// ═══════════════════════════════════════════════════════════════════════════════

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  return data.result ? JSON.parse(data.result) : null;
}

export default async function handler(req, res) {
  const secret = req.query.secret || req.headers["x-bot-secret"];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const state = await redisGet("bot-state");
    if (!state) {
      return res.status(200).json({
        bankroll: 1000, initialBankroll: 1000,
        openPositions: [], closedPositions: [],
        modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
        calibration: { totalPredictions: 0, correctPredictions: 0, bins: {} },
        lastRunAt: null, totalRuns: 0,
      });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(state);
  } catch (e) {
    return res.status(500).json({ error: "Failed to read state", detail: e.message });
  }
}
