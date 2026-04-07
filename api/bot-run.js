// ═══════════════════════════════════════════════════════════════════════════════
// EDGE TERMINAL — Paper Trading Bot
// Runs on schedule. Finds edge, places paper bets, sends Telegram alerts.
// ═══════════════════════════════════════════════════════════════════════════════

const INITIAL_BANKROLL = 1000;
const MAX_DEPLOYED_PCT = 20;   // Max % of bankroll deployed at once
const MAX_POSITIONS = 5;       // Max concurrent open positions
const MIN_EDGE = 3;            // Min edge % to consider a bet
const MAX_BET_PCT = 6;         // Max single bet as % of bankroll
const MIN_BET = 10;            // Minimum bet size $
const BET_WINDOW_MIN_H = 0.5;  // Don't bet on matches starting in < 30 min
const BET_WINDOW_MAX_H = 48;   // Don't bet on matches > 48hr out

// ─── Redis Helpers ───────────────────────────────────────────────────────────

async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(["SET", key, JSON.stringify(value)]),
  });
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function sendTG(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("TG error:", e); }
}

// ─── PandaScore ──────────────────────────────────────────────────────────────

async function pandaFetch(path) {
  const token = process.env.PANDA_TOKEN;
  const r = await fetch(`https://api.pandascore.co/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`PandaScore ${r.status}: ${path}`);
  return r.json();
}

// ─── Polymarket ──────────────────────────────────────────────────────────────

// Polymarket Gamma API — sports moneyline markets by game-specific tag_id
const POLY_TAG = { csgo: 100780, dota2: 102366, lol: 65 };

async function fetchPolymarketByGame(game) {
  const tagId = POLY_TAG[game];
  if (!tagId) return [];
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?sports_market_types=moneyline&closed=false&tag_id=${tagId}&limit=50`);
    if (!r.ok) return [];
    return await r.json();
  } catch (e) { return []; }
}

async function fetchAllPolymarketEsports() {
  const [csgo, dota2, lol] = await Promise.all([
    fetchPolymarketByGame("csgo"),
    fetchPolymarketByGame("dota2"),
    fetchPolymarketByGame("lol"),
  ]);
  return [...csgo, ...dota2, ...lol];
}

function matchPolymarket(polyMarkets, teamA, teamB) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(teamA);
  const b = norm(teamB);

  for (const mkt of polyMarkets) {
    const question = norm(mkt.question || "");
    const rawOutcomes = typeof mkt.outcomes === "string" ? JSON.parse(mkt.outcomes) : (mkt.outcomes || []);
    const outcomes = rawOutcomes.map(o => norm(String(o)));

    // Check if both teams appear in the question or outcomes
    const allText = question + " " + outcomes.join(" ");
    const hasA = allText.includes(a) || outcomes.some(o => o.includes(a) || a.includes(o));
    const hasB = allText.includes(b) || outcomes.some(o => o.includes(b) || b.includes(o));

    if (hasA && hasB && mkt.outcomePrices) {
      const prices = typeof mkt.outcomePrices === "string" ? JSON.parse(mkt.outcomePrices) : mkt.outcomePrices;
      if (prices.length >= 2) {
        // Figure out which outcome is which team
        const o0 = outcomes[0] || "";
        const o1 = outcomes[1] || "";
        const aIsFirst = o0.includes(a) || a.includes(o0);
        const probFirst = parseFloat(prices[0]) * 100;
        const probSecond = parseFloat(prices[1]) * 100;
        return {
          probA: aIsFirst ? probFirst : probSecond,
          probB: aIsFirst ? probSecond : probFirst,
        };
      }
    }
  }
  return null;
}

// ─── Prediction Model (mirrors client-side) ──────────────────────────────────

function computePrediction(teamAId, teamBId, histA, histB, format, weights) {
  const getResults = (history, teamId) =>
    history.map(m => ({
      won: m.winner?.id === teamId,
      oppId: m.opponents?.find(o => o.opponent?.id !== teamId)?.opponent?.id,
    })).filter(r => r.oppId !== undefined);

  const weightedWR = (results, n = 10) => {
    const recent = results.slice(0, n);
    if (!recent.length) return 50;
    let tw = 0, ww = 0;
    recent.forEach((r, i) => { const w = 1 - i / (n * 1.5); tw += w; if (r.won) ww += w; });
    return tw > 0 ? (ww / tw) * 100 : 50;
  };

  const overallWR = (results) => {
    if (!results.length) return 50;
    return (results.filter(r => r.won).length / results.length) * 100;
  };

  const h2hWR = (results, oppId) => {
    const meetings = results.filter(r => r.oppId === oppId);
    if (meetings.length < 2) return { wr: 50, n: meetings.length };
    return { wr: (meetings.filter(r => r.won).length / meetings.length) * 100, n: meetings.length };
  };

  const rA = getResults(histA, teamAId);
  const rB = getResults(histB, teamBId);

  const formA = weightedWR(rA, weights.formN || 10);
  const formB = weightedWR(rB, weights.formN || 10);
  const allA = overallWR(rA);
  const allB = overallWR(rB);
  const h2h = h2hWR(rA, teamBId);

  const fw = weights.form || 0.45;
  const ow = weights.overall || 0.35;
  const hw = h2h.n >= 3 ? (weights.h2h || 0.15) : 0.05;
  const owAdj = ow + ((weights.h2h || 0.15) - hw);

  const sA = fw * formA + owAdj * allA + hw * h2h.wr;
  const sB = fw * formB + owAdj * allB + hw * (100 - h2h.wr);

  let prob = (sA + sB) > 0 ? (sA / (sA + sB)) * 100 : 50;

  // BO format adjustment
  const bo = format || 1;
  if (bo === 1) prob = prob * 0.88 + 50 * 0.12;
  else if (bo >= 5) prob = 50 + (prob - 50) * 1.08;

  prob = Math.max(5, Math.min(95, prob));

  const confidence = Math.min(rA.length, rB.length) >= 8 ? "high" : Math.min(rA.length, rB.length) >= 4 ? "medium" : "low";

  return {
    probA: prob, probB: 100 - prob, confidence,
    formA: weightedWR(rA, 10), formB: weightedWR(rB, 10),
    overallA: allA, overallB: allB,
    h2hWR: h2h.wr, h2hN: h2h.n,
    recordA: `${rA.filter(r => r.won).length}-${rA.filter(r => !r.won).length}`,
    recordB: `${rB.filter(r => r.won).length}-${rB.filter(r => !r.won).length}`,
  };
}

// ─── Bet Sizing ──────────────────────────────────────────────────────────────

function calcBetSize(edge, bankroll, confidence) {
  const kellyFull = edge / 100 * bankroll; // Simplified Kelly for small edges
  let fraction;
  if (edge >= 8) fraction = 1.0;        // Full Kelly
  else if (edge >= 5) fraction = 0.75;   // 3/4 Kelly
  else fraction = 0.5;                    // Half Kelly

  if (confidence === "low") fraction *= 0.5;
  else if (confidence === "medium") fraction *= 0.75;

  let size = Math.round(kellyFull * fraction);
  size = Math.max(MIN_BET, size);
  size = Math.min(bankroll * MAX_BET_PCT / 100, size);
  return size;
}

// ─── Self-Improving Model ────────────────────────────────────────────────────

function adjustWeights(state) {
  const closed = state.closedPositions || [];
  if (closed.length < 10) return state.modelWeights; // Not enough data

  // Analyze recent performance
  const recent = closed.slice(0, 30);
  let overconfident = 0, underconfident = 0;

  recent.forEach(p => {
    const predicted = p.pickSide === "A" ? p.ourProb : 100 - p.ourProb;
    if (predicted > 60 && p.result === "loss") overconfident++;
    if (predicted < 55 && p.result === "win") underconfident++;
  });

  const total = recent.length;
  const wins = recent.filter(p => p.result === "win").length;
  const actualHitRate = wins / total;

  const weights = { ...state.modelWeights };

  // If we're overconfident (losing high-confidence bets), increase H2H weight and decrease form weight
  if (overconfident / total > 0.3) {
    weights.form = Math.max(0.25, weights.form - 0.03);
    weights.overall = Math.min(0.45, weights.overall + 0.02);
    weights.h2h = Math.min(0.25, weights.h2h + 0.01);
  }

  // If we're doing well, slightly increase form weight (momentum matters)
  if (actualHitRate > 0.6) {
    weights.form = Math.min(0.55, weights.form + 0.01);
  }

  // Normalize weights to sum to ~0.95 (leaving 0.05 buffer)
  const sum = weights.form + weights.overall + weights.h2h;
  if (sum > 0) {
    const scale = 0.95 / sum;
    weights.form *= scale;
    weights.overall *= scale;
    weights.h2h *= scale;
  }

  return weights;
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Auth check
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  const botSecret = req.query.secret || req.headers["x-bot-secret"];

  // Allow Vercel cron, or manual trigger with secret
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManual = botSecret && botSecret === process.env.BOT_SECRET;
  if (!isCron && !isManual) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const log = [];
  const push = (msg) => { log.push(msg); console.log(msg); };

  try {
    push("🤖 Bot run starting...");

    // 1. Load state
    let state = await redisGet("bot-state");
    if (!state) {
      state = {
        bankroll: INITIAL_BANKROLL,
        initialBankroll: INITIAL_BANKROLL,
        openPositions: [],
        closedPositions: [],
        modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
        calibration: { totalPredictions: 0, correctPredictions: 0, bins: {} },
        lastRunAt: null,
        totalRuns: 0,
      };
    }

    const now = new Date();

    // 2. Resolve completed matches
    const toResolve = state.openPositions.filter(p => new Date(p.matchTime) < new Date(now - 1800000)); // Match started > 30min ago
    const stillOpen = [];
    let resolvedCount = 0;

    for (const pos of state.openPositions) {
      if (!toResolve.includes(pos)) { stillOpen.push(pos); continue; }

      try {
        const match = await pandaFetch(`${pos.game}/matches/${pos.matchId}`);
        if (match.status === "finished" && match.winner) {
          const won = (pos.pickSide === "A" && match.winner.id === pos.teamAId) ||
                      (pos.pickSide === "B" && match.winner.id === pos.teamBId);

          const result = won ? "win" : "loss";
          const pnl = won ? pos.betSize * ((100 / pos.marketProb) - 1) : -pos.betSize;

          // When bet placed: bankroll -= betSize. If won: return stake + profit. If lost: already deducted.
          if (won) state.bankroll += pos.betSize + pnl;

          const closed = { ...pos, result, pnl: +pnl.toFixed(2), resolvedAt: now.toISOString() };
          state.closedPositions.unshift(closed);
          resolvedCount++;

          // Update calibration
          const bin = `${Math.floor(pos.ourProb / 5) * 5}-${Math.floor(pos.ourProb / 5) * 5 + 5}`;
          if (!state.calibration.bins[bin]) state.calibration.bins[bin] = { total: 0, wins: 0 };
          state.calibration.bins[bin].total++;
          if (won) state.calibration.bins[bin].wins++;
          state.calibration.totalPredictions++;
          if (won) state.calibration.correctPredictions++;

          const emoji = won ? "✅" : "❌";
          push(`${emoji} Resolved: ${pos.pick} (${pos.event}) → ${result} | P&L: $${pnl.toFixed(2)}`);
          await sendTG(`${emoji} <b>BET RESOLVED</b>\n\n${pos.event}\nPick: <b>${pos.pick}</b>\nResult: <b>${result.toUpperCase()}</b>\nP&L: <b>$${pnl.toFixed(2)}</b>\nBankroll: <b>$${state.bankroll.toFixed(2)}</b>`);
        } else {
          stillOpen.push(pos); // Not finished yet
        }
      } catch (e) {
        stillOpen.push(pos); // Keep it if we can't check
        push(`⚠️ Couldn't check match ${pos.matchId}: ${e.message}`);
      }
    }
    state.openPositions = stillOpen;

    // Adjust weights after resolutions
    if (resolvedCount > 0 && state.closedPositions.length >= 10) {
      const newWeights = adjustWeights(state);
      if (JSON.stringify(newWeights) !== JSON.stringify(state.modelWeights)) {
        push(`🧠 Model weights adjusted: form=${newWeights.form.toFixed(2)} overall=${newWeights.overall.toFixed(2)} h2h=${newWeights.h2h.toFixed(2)}`);
        state.modelWeights = newWeights;
      }
    }

    // 3. Find new opportunities
    const deployedPct = state.openPositions.reduce((s, p) => s + p.betSize, 0) / state.bankroll * 100;
    const canBet = state.openPositions.length < MAX_POSITIONS && deployedPct < MAX_DEPLOYED_PCT && state.bankroll > MIN_BET;

    if (canBet) {
      // Fetch upcoming matches + Polymarket moneyline markets in parallel
      const [csgo, dota2, lol, polyMarkets] = await Promise.all([
        pandaFetch("csgo/matches/upcoming?per_page=15&sort=scheduled_at").catch(() => []),
        pandaFetch("dota2/matches/upcoming?per_page=15&sort=scheduled_at").catch(() => []),
        pandaFetch("lol/matches/upcoming?per_page=15&sort=scheduled_at").catch(() => []),
        fetchAllPolymarketEsports(),
      ]);

      const allMatches = [
        ...csgo.map(m => ({ ...m, _game: "csgo" })),
        ...dota2.map(m => ({ ...m, _game: "dota2" })),
        ...lol.map(m => ({ ...m, _game: "lol" })),
      ];

      push(`📊 Found ${allMatches.length} upcoming matches, ${polyMarkets.length} Polymarket moneyline markets`);

      const opportunities = [];

      for (const m of allMatches) {
        const t1 = m.opponents?.[0]?.opponent;
        const t2 = m.opponents?.[1]?.opponent;
        if (!t1 || !t2) continue;

        // Check betting window
        const matchTime = new Date(m.scheduled_at);
        const hoursUntil = (matchTime - now) / 3600000;
        if (hoursUntil < BET_WINDOW_MIN_H || hoursUntil > BET_WINDOW_MAX_H) continue;

        // Check if already have position on this match
        if (state.openPositions.some(p => p.matchId === m.id)) continue;

        // Try to find Polymarket odds (try full name, then acronym)
        const polyOdds = matchPolymarket(polyMarkets, t1.name, t2.name) ||
                         matchPolymarket(polyMarkets, t1.acronym || t1.name, t2.acronym || t2.name);

        if (!polyOdds) continue; // No market price = can't calculate edge

        opportunities.push({ match: m, t1, t2, polyOdds });
      }

      push(`🎯 ${opportunities.length} matches with Polymarket odds`);

      // Fetch predictions for opportunities (limit to 8 to stay within timeout)
      const toAnalyze = opportunities.slice(0, 8);

      for (const opp of toAnalyze) {
        if (state.openPositions.length >= MAX_POSITIONS) break;
        const currentDeployed = state.openPositions.reduce((s, p) => s + p.betSize, 0);
        if (currentDeployed / state.bankroll * 100 >= MAX_DEPLOYED_PCT) break;

        try {
          const [histA, histB] = await Promise.all([
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t1.id}&per_page=25&sort=-scheduled_at`),
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t2.id}&per_page=25&sort=-scheduled_at`),
          ]);

          const pred = computePrediction(opp.t1.id, opp.t2.id, histA, histB, opp.match.number_of_games, state.modelWeights);

          // Only bet on the team we think WINS (>50%) where market undervalues them
          const pickSide = pred.probA >= pred.probB ? "A" : "B";
          const ourProb = pickSide === "A" ? pred.probA : pred.probB;
          const marketProb = pickSide === "A" ? opp.polyOdds.probA : opp.polyOdds.probB;
          const edge = ourProb - marketProb;

          if (ourProb < 52) continue;    // Must believe team wins convincingly
          if (edge < MIN_EDGE) continue;  // Must have real edge vs market
          if (pred.confidence === "low" && edge < 8) continue;

          const pick = pickSide === "A" ? (opp.t1.acronym || opp.t1.name) : (opp.t2.acronym || opp.t2.name);
          const betSize = calcBetSize(edge, state.bankroll, pred.confidence);

          if (betSize > state.bankroll - currentDeployed) continue; // Not enough available bankroll

          // Place the paper bet
          const position = {
            id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            matchId: opp.match.id,
            game: opp.match._game,
            teamA: opp.t1.acronym || opp.t1.name,
            teamB: opp.t2.acronym || opp.t2.name,
            teamAId: opp.t1.id,
            teamBId: opp.t2.id,
            pick,
            pickSide,
            ourProb: +(pickSide === "A" ? pred.probA : pred.probB).toFixed(1),
            marketProb: +(pickSide === "A" ? opp.polyOdds.probA : opp.polyOdds.probB).toFixed(1),
            edge: +edge.toFixed(1),
            betSize,
            betPercent: +(betSize / state.bankroll * 100).toFixed(1),
            confidence: pred.confidence,
            event: `${opp.t1.acronym || opp.t1.name} vs ${opp.t2.acronym || opp.t2.name}`,
            league: opp.match.league?.name || "",
            format: opp.match.number_of_games || 1,
            placedAt: now.toISOString(),
            matchTime: opp.match.scheduled_at,
            formA: pred.recordA,
            formB: pred.recordB,
          };

          state.openPositions.push(position);
          state.bankroll -= betSize;

          push(`💰 BET PLACED: ${pick} in ${position.event} | Edge: ${edge.toFixed(1)}% | Size: $${betSize} (${position.betPercent}%)`);

          // Send Telegram alert
          await sendTG(
            `💰 <b>NEW PAPER BET</b>\n\n` +
            `🎮 ${opp.match._game.toUpperCase()}\n` +
            `📋 ${position.event}\n` +
            `🏆 ${position.league} · BO${position.format}\n\n` +
            `<b>Pick: ${pick}</b>\n` +
            `Our model: <b>${position.ourProb}%</b>\n` +
            `Market: <b>${position.marketProb}%</b>\n` +
            `Edge: <b>+${position.edge}%</b>\n` +
            `Confidence: ${position.confidence}\n\n` +
            `💵 Bet: <b>$${betSize}</b> (${position.betPercent}% of bankroll)\n` +
            `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n` +
            `📊 Open positions: ${state.openPositions.length}/${MAX_POSITIONS}\n\n` +
            `⏰ Match: ${new Date(position.matchTime).toLocaleString()}`
          );
        } catch (e) {
          push(`⚠️ Error analyzing ${opp.t1.name} vs ${opp.t2.name}: ${e.message}`);
        }
      }
    } else {
      if (state.openPositions.length >= MAX_POSITIONS) push("⏸️ Max positions reached, skipping new bets");
      else if (deployedPct >= MAX_DEPLOYED_PCT) push("⏸️ Max deployment reached, skipping new bets");
      else if (state.bankroll <= MIN_BET) push("⏸️ Bankroll too low");
    }

    // 4. Save state
    state.lastRunAt = now.toISOString();
    state.totalRuns = (state.totalRuns || 0) + 1;
    // Keep last 500 closed positions for full trade history
    state.closedPositions = (state.closedPositions || []).slice(0, 500);

    await redisSet("bot-state", state);

    // Summary
    const pnl = state.bankroll - state.initialBankroll;
    push(`\n📈 Bankroll: $${state.bankroll.toFixed(2)} | P&L: $${pnl.toFixed(2)} | Open: ${state.openPositions.length} | Closed: ${state.closedPositions.length} | Run #${state.totalRuns}`);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, log, bankroll: state.bankroll, openPositions: state.openPositions.length });

  } catch (e) {
    push(`❌ Fatal error: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message, log });
  }
}
