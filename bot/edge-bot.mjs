#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// EDGE TERMINAL — Paper Trading Bot (VPS Standalone)
// Runs on cron. Stores state in a local JSON file. No Redis needed.
// Also runs a tiny HTTP server so the dashboard can read bot state.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "config.json");
const STATE_PATH = join(__dirname, "state.json");
const LOG_PATH = join(__dirname, "bot.log");

// ─── Config ─────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("❌ config.json not found. Copy config.json and fill in your tokens.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

const CFG = loadConfig();

// ─── Constants ──────────────────────────────────────────────────────────────

const INITIAL_BANKROLL = 1000;
const MAX_DEPLOYED_PCT = 20;         // Conservative — protect remaining bankroll
const MAX_POSITIONS = 5;             // Fewer concurrent bets = less correlated risk
const MIN_EDGE = 5;                  // Need real edge vs market, not 3% noise
const MAX_BET_PCT = 5;               // Smaller max bet — survival first
const MIN_BET = 5;
const BET_WINDOW_MIN_H = 0.5;       // 30min minimum — need settled odds
const BET_WINDOW_MAX_H = 6;          // Tighter window — odds more reliable closer to match
const MIN_LIQUIDITY = 2000;          // Real liquidity only — thin markets = bad prices
const MIN_OUR_PROB = 60;             // Keep — only bet confident picks
const BETS_PER_RUN = 2;              // Quality over quantity — max 2 bets per run
const PRICE_DISCOVERY_MIN = 58;      // Market must show some signal (not coin-flip territory)

// ─── Market Confirmation Mode ──────────────────────────────────────────────
// When model AND market agree on a heavy favorite, take a bigger position.
// Esports markets tend to underprice favorites (degen bettors love underdogs).
// These are our "safe" plays — both signals agree, so size up.
const CONFIRM_ENABLED = true;
const CONFIRM_MIN_MARKET_PROB = 72;  // Market must see team as 72%+ favorite
const CONFIRM_MIN_OUR_PROB = 70;     // Our model must also agree (70%+)
const CONFIRM_MAX_BET_PCT = 5;       // 5% of bankroll — confident plays deserve real sizing
const CONFIRM_MIN_LIQUIDITY = 3000;  // Higher liquidity required — need reliable prices
const CONFIRM_MAX_PER_RUN = 2;       // Up to 2 confirmation bets per run

// ─── Drawdown Protection ───────────────────────────────────────────────────

const DRAWDOWN_HALT_PCT = 50;        // Stop betting if bankroll drops below 50% of initial
const DRAWDOWN_SURVIVAL_PCT = 70;    // Enter survival mode below 70% (half sizing)
const MAX_CONSEC_LOSSES = 3;         // After 3 consecutive losses, halve sizing
const COOLDOWN_AFTER_LOSS_STREAK = 2; // Skip N runs after hitting loss streak limit

// ─── File-Based State ───────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); }
  catch (e) { console.error("⚠️ Failed to read state.json:", e.message); return null; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function appendLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { writeFileSync(LOG_PATH, line, { flag: "a" }); } catch {}
}

// ─── Telegram (optional) ────────────────────────────────────────────────────

async function sendTG(msg) {
  const token = CFG.TELEGRAM_BOT_TOKEN;
  const chat = CFG.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
  } catch (e) { console.error("TG error:", e.message); }
}

// ─── PandaScore ─────────────────────────────────────────────────────────────

async function pandaFetch(path) {
  const r = await fetch(`https://api.pandascore.co/${path}`, {
    headers: { Authorization: `Bearer ${CFG.PANDA_TOKEN}` },
  });
  if (!r.ok) throw new Error(`PandaScore ${r.status}: ${path}`);
  return r.json();
}

// ─── Polymarket ─────────────────────────────────────────────────────────────

const POLY_TAG = { csgo: 100780, dota2: 102366, lol: 65 };

async function fetchPolymarketByGame(game) {
  const tagId = POLY_TAG[game];
  if (!tagId) return [];
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?sports_market_types=moneyline&closed=false&tag_id=${tagId}&limit=50`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
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
    const allText = question + " " + outcomes.join(" ");
    const hasA = allText.includes(a) || outcomes.some(o => o.includes(a) || a.includes(o));
    const hasB = allText.includes(b) || outcomes.some(o => o.includes(b) || b.includes(o));

    if (hasA && hasB && mkt.outcomePrices) {
      const prices = typeof mkt.outcomePrices === "string" ? JSON.parse(mkt.outcomePrices) : mkt.outcomePrices;
      if (prices.length >= 2) {
        const o0 = outcomes[0] || "";
        const aIsFirst = o0.includes(a) || a.includes(o0);
        const probFirst = parseFloat(prices[0]) * 100;
        const probSecond = parseFloat(prices[1]) * 100;
        const liquidity = parseFloat(mkt.liquidity) || 0;
        const volume = parseFloat(mkt.volume) || 0;
        const slug = mkt.slug || "";
        const polyUrl = slug ? `https://polymarket.com/event/${slug}` : null;
        return {
          probA: aIsFirst ? probFirst : probSecond,
          probB: aIsFirst ? probSecond : probFirst,
          liquidity,
          volume,
          slug,
          polyUrl,
        };
      }
    }
  }
  return null;
}

// ─── Prediction Model (v3 — game scores, margins, dominance + recency) ─────

function computePrediction(teamAId, teamBId, histA, histB, format, weights) {
  // Extract rich results — game scores, margins, not just W/L
  const getResults = (history, teamId) =>
    history.map(m => {
      const teamResult = m.results?.find(r => r.team_id === teamId);
      const oppResult = m.results?.find(r => r.team_id !== teamId);
      const opp = m.opponents?.find(o => o.opponent?.id !== teamId)?.opponent;

      // Game-level scores (e.g., 2-1 in BO3, 16-12 in CS2 maps)
      const gamesWon = teamResult?.score || 0;
      const gamesLost = oppResult?.score || 0;
      const totalGames = gamesWon + gamesLost;

      // Dominance: how convincingly did they win/lose?
      // 2-0 win = dominance 1.0, 2-1 win = 0.5, 0-2 loss = -1.0, 1-2 loss = -0.5
      let dominance = 0;
      if (totalGames > 0) {
        dominance = (gamesWon - gamesLost) / Math.max(totalGames, 1);
      }

      // Match recency in days (for time-decay)
      const matchDate = new Date(m.scheduled_at || m.begin_at);
      const daysAgo = (Date.now() - matchDate.getTime()) / 86400000;

      return {
        won: m.winner?.id === teamId,
        oppId: opp?.id,
        oppName: opp?.name || "?",
        date: m.scheduled_at || m.begin_at,
        daysAgo,
        bo: m.number_of_games || 1,
        gamesWon,
        gamesLost,
        dominance,        // -1 to +1: how convincing the result was
        league: m.league?.name || "",
        tournamentTier: m.tournament?.tier || "unranked",
      };
    }).filter(r => r.oppId !== undefined);

  // Recent form — exponential decay + dominance weighting
  // A 2-0 stomp counts more than a 2-1 scrape
  const recentFormWR = (results, n = 10) => {
    const recent = results.slice(0, n);
    if (!recent.length) return 50;
    let tw = 0, ww = 0;
    recent.forEach((r, i) => {
      const w = Math.pow(0.8, i);
      tw += w;
      if (r.won) ww += w;
    });
    return tw > 0 ? (ww / tw) * 100 : 50;
  };

  // Dominance score — average dominance across recent matches
  // Positive = winning convincingly, negative = losing badly or barely winning
  const dominanceScore = (results, n = 10) => {
    const recent = results.slice(0, n);
    if (!recent.length) return 0;
    let tw = 0, dw = 0;
    recent.forEach((r, i) => {
      const w = Math.pow(0.85, i);
      tw += w;
      dw += r.dominance * w;
    });
    return tw > 0 ? dw / tw : 0;
  };

  // Close-match performance — how do they perform in tight games?
  // Teams that win close matches (2-1, 13-16) are more clutch
  const clutchFactor = (results) => {
    const recent = results.slice(0, 15);
    const closeMatches = recent.filter(r => Math.abs(r.dominance) <= 0.4 && r.bo >= 3);
    if (closeMatches.length < 2) return 0;
    const closeWins = closeMatches.filter(r => r.won).length;
    // Return -5 to +5 range
    return ((closeWins / closeMatches.length) - 0.5) * 10;
  };

  // Opponent-strength-adjusted win rate — wins vs tough opponents count more
  const strengthAdjustedWR = (results) => {
    if (!results.length) return 50;
    let tw = 0, ww = 0;
    results.forEach(r => {
      const tierMult = r.tournamentTier === "s" ? 1.5 : r.tournamentTier === "a" ? 1.3 : r.tournamentTier === "b" ? 1.1 : 1.0;
      tw += tierMult;
      if (r.won) ww += tierMult;
    });
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

  // Hot/cold streak with momentum direction
  const streakFactor = (results) => {
    const last3 = results.slice(0, 3);
    if (last3.length < 3) return 0;
    const wins = last3.filter(r => r.won).length;
    if (wins === 3) return 4;
    if (wins === 0) return -4;
    return 0;
  };

  // Form trajectory — is the team improving or declining?
  // Compare last 5 matches to matches 6-10
  const formTrajectory = (results) => {
    if (results.length < 8) return 0;
    const recent5WR = results.slice(0, 5).filter(r => r.won).length / 5;
    const prev5WR = results.slice(5, 10).filter(r => r.won).length / Math.min(5, results.slice(5, 10).length);
    // Positive = improving, negative = declining, range roughly -3 to +3
    return (recent5WR - prev5WR) * 6;
  };

  const rA = getResults(histA, teamAId);
  const rB = getResults(histB, teamBId);

  const formA = recentFormWR(rA, 10);
  const formB = recentFormWR(rB, 10);
  const strengthA = strengthAdjustedWR(rA.slice(0, 15));
  const strengthB = strengthAdjustedWR(rB.slice(0, 15));
  const allA = overallWR(rA);
  const allB = overallWR(rB);
  const h2h = h2hWR(rA, teamBId);
  const streakA = streakFactor(rA);
  const streakB = streakFactor(rB);
  const domA = dominanceScore(rA, 10);
  const domB = dominanceScore(rB, 10);
  const clutchA = clutchFactor(rA);
  const clutchB = clutchFactor(rB);
  const trajA = formTrajectory(rA);
  const trajB = formTrajectory(rB);

  // ─── Composite score ─────────────────────────────────────────────────
  const fw = weights.form || 0.40;
  const sw = 0.20;
  const ow = weights.overall || 0.25;
  const hw = h2h.n >= 3 ? (weights.h2h || 0.15) : 0.05;
  const owAdj = ow + ((weights.h2h || 0.15) - hw);

  const sA = fw * formA + sw * strengthA + owAdj * allA + hw * h2h.wr;
  const sB = fw * formB + sw * strengthB + owAdj * allB + hw * (100 - h2h.wr);

  let prob = (sA + sB) > 0 ? (sA / (sA + sB)) * 100 : 50;

  // Apply adjustments from richer data
  prob += (streakA - streakB) * 0.5;            // Streak momentum
  prob += (domA - domB) * 3;                     // Dominance: winning 2-0 vs 2-1 matters
  prob += (clutchA - clutchB) * 0.3;            // Clutch performance in close matches
  prob += (trajA - trajB) * 0.4;                // Form trajectory (improving vs declining)

  // BO format adjustment — BO1 is volatile, BO3+ rewards better team
  const bo = format || 1;
  if (bo === 1) prob = prob * 0.75 + 50 * 0.25;
  else if (bo >= 5) prob = 50 + (prob - 50) * 1.08;

  prob = Math.max(5, Math.min(95, prob));
  const confidence = Math.min(rA.length, rB.length) >= 8 ? "high" : Math.min(rA.length, rB.length) >= 4 ? "medium" : "low";

  const thesis = buildThesis(
    rA, rB, formA, formB, strengthA, strengthB, allA, allB,
    h2h, streakA, streakB, bo, prob,
    teamAId, teamBId, domA, domB, clutchA, clutchB, trajA, trajB
  );

  return {
    probA: prob, probB: 100 - prob, confidence, thesis,
    formA: recentFormWR(rA, 10), formB: recentFormWR(rB, 10),
    strengthA, strengthB,
    overallA: allA, overallB: allB,
    h2hWR: h2h.wr, h2hN: h2h.n,
    streakA, streakB,
    dominanceA: domA, dominanceB: domB,
    clutchA, clutchB,
    trajectoryA: trajA, trajectoryB: trajB,
    recordA: `${rA.filter(r => r.won).length}-${rA.filter(r => !r.won).length}`,
    recordB: `${rB.filter(r => r.won).length}-${rB.filter(r => !r.won).length}`,
    dataPointsA: rA.length, dataPointsB: rB.length,
  };
}

// ─── Thesis Generator — plain English reasoning for each bet ────────────────

function buildThesis(rA, rB, formA, formB, strA, strB, allA, allB, h2h, streakA, streakB, bo, prob, teamAId, teamBId, domA = 0, domB = 0, clutchA = 0, clutchB = 0, trajA = 0, trajB = 0) {
  const parts = [];
  const fav = prob > 50 ? "A" : "B";
  const favForm = fav === "A" ? formA : formB;
  const dogForm = fav === "A" ? formB : formA;

  // Form analysis
  const formDiff = Math.abs(formA - formB);
  if (formDiff > 15) {
    parts.push(`Strong form gap — ${favForm.toFixed(0)}% vs ${dogForm.toFixed(0)}% weighted recent`);
  } else if (formDiff > 8) {
    parts.push(`Moderate form edge (${favForm.toFixed(0)}% vs ${dogForm.toFixed(0)}%)`);
  } else {
    parts.push(`Similar form (${formA.toFixed(0)}% vs ${formB.toFixed(0)}%)`);
  }

  // Dominance — are they winning convincingly?
  const domDiff = domA - domB;
  if (Math.abs(domDiff) > 0.3) {
    const dominant = domDiff > 0 ? "A" : "B";
    parts.push(`Team ${dominant} winning more convincingly (dominant in game scores)`);
  }

  // Trajectory — improving or declining?
  if (Math.abs(trajA) > 1.5 || Math.abs(trajB) > 1.5) {
    if (trajA > 1.5) parts.push("Team A trending up (recent form improving)");
    if (trajA < -1.5) parts.push("Team A trending down (form declining)");
    if (trajB > 1.5) parts.push("Team B trending up (recent form improving)");
    if (trajB < -1.5) parts.push("Team B trending down (form declining)");
  }

  // Strength-adjusted
  if (Math.abs(strA - strB) > 10) {
    const betterStr = strA > strB ? "A" : "B";
    parts.push(`Team ${betterStr} wins against tougher opponents`);
  }

  // Clutch factor
  if (Math.abs(clutchA - clutchB) > 3) {
    const clutcher = clutchA > clutchB ? "A" : "B";
    parts.push(`Team ${clutcher} better in close matches`);
  }

  // H2H
  if (h2h.n >= 3) {
    if (h2h.wr > 60) parts.push(`H2H favors Team A (${h2h.wr.toFixed(0)}% in ${h2h.n} meetings)`);
    else if (h2h.wr < 40) parts.push(`H2H favors Team B (${(100 - h2h.wr).toFixed(0)}% in ${h2h.n} meetings)`);
  }

  // Streaks
  if (streakA > 0) parts.push("Team A on 3W hot streak");
  if (streakA < 0) parts.push("Team A on 3L cold streak");
  if (streakB > 0) parts.push("Team B on 3W hot streak");
  if (streakB < 0) parts.push("Team B on 3L cold streak");

  // Format
  if (bo === 1) parts.push("BO1 increases upset risk significantly");
  else if (bo >= 3) parts.push(`BO${bo} favors the better team`);

  return parts.join(". ") + ".";
}

// ─── Drawdown Detection ────────────────────────────────────────────────────

function getDrawdownState(state) {
  const bankrollPct = (state.bankroll / state.initialBankroll) * 100;
  const closed = state.closedPositions || [];

  // Count consecutive losses from most recent
  let consecLosses = 0;
  for (const p of closed) {
    if (p.result === "loss") consecLosses++;
    else break;
  }

  // Check if we should halt entirely
  const halted = bankrollPct <= DRAWDOWN_HALT_PCT;

  // Check if we're in survival mode
  const survival = bankrollPct <= DRAWDOWN_SURVIVAL_PCT;

  // Check if on a bad loss streak — apply cooldown
  const onCooldown = consecLosses >= MAX_CONSEC_LOSSES &&
    state.runsSinceLossStreak !== undefined &&
    state.runsSinceLossStreak < COOLDOWN_AFTER_LOSS_STREAK;

  // Sizing multiplier based on drawdown
  let sizeMult = 1.0;
  if (survival) sizeMult = 0.5;                     // Half size in survival mode
  if (consecLosses >= MAX_CONSEC_LOSSES) sizeMult *= 0.5;  // Half again on loss streak

  return { bankrollPct, consecLosses, halted, survival, onCooldown, sizeMult };
}

// ─── Bet Sizing ─────────────────────────────────────────────────────────────

function calcBetSize(edge, bankroll, confidence, format = 3, drawdownMult = 1.0) {
  // Quarter-Kelly base — conservative fractional Kelly
  const kellyFull = edge / 100 * bankroll;
  let fraction = 0.25;

  // Scale up slightly for strong edges, but cap conservatively
  if (edge >= 10) fraction = 0.5;
  else if (edge >= 7) fraction = 0.4;
  else if (edge >= 5) fraction = 0.3;

  // Confidence penalty — less data = smaller bets
  if (confidence === "low") fraction *= 0.4;
  else if (confidence === "medium") fraction *= 0.7;

  // BO1 penalty — high variance format
  if (format === 1) fraction *= 0.5;

  // Apply drawdown multiplier (from getDrawdownState)
  fraction *= drawdownMult;

  let size = Math.round(kellyFull * fraction);
  size = Math.max(MIN_BET, size);
  size = Math.min(Math.round(bankroll * MAX_BET_PCT / 100), size);
  return Math.round(size);
}

// ─── Self-Improving Model ───────────────────────────────────────────────────

function adjustWeights(state) {
  const closed = state.closedPositions || [];
  if (closed.length < 4) return state.modelWeights;  // Start adjusting after just 4 trades

  const recent = closed.slice(0, 20);
  const total = recent.length;
  const wins = recent.filter(p => p.result === "win").length;
  const losses = total - wins;
  const hitRate = wins / total;
  const weights = { ...state.modelWeights };

  // Count overconfident losses (model said 60%+ but lost)
  let overconfident = 0;
  recent.forEach(p => {
    if (p.ourProb > 55 && p.result === "loss") overconfident++;
  });

  // If more than 25% of recent picks are overconfident losses, reduce form reliance
  if (total >= 4 && overconfident / total > 0.25) {
    weights.form = Math.max(0.20, weights.form - 0.05);
    weights.overall = Math.min(0.50, weights.overall + 0.03);
    weights.h2h = Math.min(0.30, weights.h2h + 0.02);
  }

  // If winning, lean back into form
  if (hitRate > 0.55 && total >= 6) {
    weights.form = Math.min(0.55, weights.form + 0.02);
  }

  // Normalize weights to sum to ~0.95 (remaining 0.05 is implicit strength weight)
  const sum = weights.form + weights.overall + weights.h2h;
  if (sum > 0) {
    const scale = 0.95 / sum;
    weights.form *= scale;
    weights.overall *= scale;
    weights.h2h *= scale;
  }

  return weights;
}

// Circuit breaker — should we stop placing EDGE bets?
// Does NOT affect confirmation bets (those ride the market, not against it).
// Only looks at trades from the last 7 days to avoid penalizing new model for old bugs.
function shouldCircuitBreak(state) {
  const closed = state.closedPositions || [];
  if (closed.length < 4) return false;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recent = closed
    .filter(p => (p.resolvedAt || p.placedAt) > sevenDaysAgo)
    .slice(0, 10);

  if (recent.length < 4) return false;  // Not enough recent data to judge

  const wins = recent.filter(p => p.result === "win").length;
  const hitRate = wins / recent.length;

  // If win rate is below 20% over recent trades, pause edge bets
  if (hitRate < 0.20) return true;

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BOT RUN
// ═══════════════════════════════════════════════════════════════════════════════

async function runBot() {
  const log = [];
  const push = (msg) => { log.push(msg); console.log(msg); appendLog(msg); };

  try {
    push("🤖 Bot run starting...");

    // 1. Load state
    let state = loadState();
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
      push("📋 Fresh state initialized — $1,000 bankroll");
    }

    const now = new Date();

    // 2. Resolve completed matches (check 30min after match start)
    // Fetch Polymarket data once for resolution fallback + live prices
    const polyMarketsForResolve = await fetchAllPolymarketEsports();

    const toResolve = state.openPositions.filter(p => new Date(p.matchTime) < new Date(now - 1800000));
    const stillOpen = [];
    let resolvedCount = 0;

    for (const pos of state.openPositions) {
      if (!toResolve.includes(pos)) { stillOpen.push(pos); continue; }

      let won = null;

      // Try PandaScore first
      try {
        const match = await pandaFetch(`matches/${pos.matchId}`);
        if ((match.status === "finished" || match.status === "canceled") && match.winner) {
          won = (pos.pickSide === "A" && match.winner.id === pos.teamAId) ||
                (pos.pickSide === "B" && match.winner.id === pos.teamBId);
        }
      } catch (e) {
        push(`⚠️ PandaScore check failed for ${pos.event}: ${e.message}`);
      }

      // Fallback: check Polymarket — if market resolved (price at 0 or 100), determine winner
      if (won === null) {
        const polyOdds = matchPolymarket(polyMarketsForResolve, pos.teamA, pos.teamB);
        if (polyOdds) {
          const pickProb = pos.pickSide === "A" ? polyOdds.probA : polyOdds.probB;
          // Market resolved: price near 100 = our pick won, near 0 = lost
          if (pickProb >= 95) won = true;
          else if (pickProb <= 5) won = false;
          if (won !== null) push(`📡 Resolved via Polymarket: ${pos.event}`);
        }
      }

      if (won !== null) {
        const result = won ? "win" : "loss";
        const pnl = won ? pos.betSize * ((100 / pos.marketProb) - 1) : -pos.betSize;

        if (won) state.bankroll += pos.betSize + pnl;

        // Loss analysis — figure out WHY we lost
        let lossReason = "";
        if (!won) {
          if (pos.confidence === "low") lossReason = "Low confidence pick — insufficient data";
          else if (pos.format === 1) lossReason = "BO1 upset — high variance format";
          else if (pos.ourProb < 60) lossReason = "Marginal edge — model wasn't confident enough";
          else if (pos.edge < 5) lossReason = "Thin edge — market was close to correct";
          else lossReason = "Model overestimated — market was right";
        }

        const closed = {
          ...pos, result, pnl: +pnl.toFixed(2), resolvedAt: now.toISOString(),
          lossReason: won ? null : lossReason,
        };
        state.closedPositions.unshift(closed);
        resolvedCount++;

        const bin = `${Math.floor(pos.ourProb / 5) * 5}-${Math.floor(pos.ourProb / 5) * 5 + 5}`;
        if (!state.calibration.bins[bin]) state.calibration.bins[bin] = { total: 0, wins: 0 };
        state.calibration.bins[bin].total++;
        if (won) state.calibration.bins[bin].wins++;
        state.calibration.totalPredictions++;
        if (won) state.calibration.correctPredictions++;

        const emoji = won ? "✅" : "❌";
        push(`${emoji} Resolved: ${pos.pick} (${pos.event}) → ${result} | P&L: $${pnl.toFixed(2)}${lossReason ? ` | ${lossReason}` : ""}`);
        const lossLine = lossReason ? `\n📝 <i>${lossReason}</i>` : "";
        await sendTG(`${emoji} <b>BET RESOLVED</b>\n\n${pos.event}\nPick: <b>${pos.pick}</b>\nResult: <b>${result.toUpperCase()}</b>\nP&L: <b>$${pnl.toFixed(2)}</b>\nBankroll: <b>$${state.bankroll.toFixed(2)}</b>${lossLine}`);
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    if (resolvedCount > 0 && state.closedPositions.length >= 4) {
      const newWeights = adjustWeights(state);
      if (JSON.stringify(newWeights) !== JSON.stringify(state.modelWeights)) {
        push(`🧠 Model weights adjusted: form=${newWeights.form.toFixed(2)} overall=${newWeights.overall.toFixed(2)} h2h=${newWeights.h2h.toFixed(2)}`);
        state.modelWeights = newWeights;
      }
    }

    // ─── Drawdown & Circuit Breaker Checks ────────────────────────────────
    const dd = getDrawdownState(state);

    if (dd.halted) {
      push(`🛑 HALTED — Bankroll at ${dd.bankrollPct.toFixed(1)}% of initial (below ${DRAWDOWN_HALT_PCT}%). No new bets until manual review.`);
      if (!state.haltAlertSent) {
        await sendTG(`🛑 <b>BOT HALTED</b>\n\nBankroll dropped to <b>${dd.bankrollPct.toFixed(1)}%</b> of initial.\nNo new bets will be placed.\nUse /reset or manually adjust to resume.`);
        state.haltAlertSent = true;
      }
      saveState(state);
      return { ok: true, log };
    } else {
      state.haltAlertSent = false;
    }

    const circuitBroken = shouldCircuitBreak(state);
    if (circuitBroken) {
      push(`⚡ CIRCUIT BREAKER — Edge bets paused (win rate too low). Confirmation bets still active.`);
      if (!state.circuitBreakerAlertSent) {
        await sendTG(`⚡ <b>CIRCUIT BREAKER</b>\n\nEdge bet win rate too low — pausing edge bets.\nConfirmation bets (heavy favorites) still active.\n\n<i>This alert won't repeat — use /status to check.</i>`);
        state.circuitBreakerAlertSent = true;
      }
    } else {
      state.circuitBreakerAlertSent = false;
    }

    // Track cooldown after loss streaks
    if (dd.consecLosses >= MAX_CONSEC_LOSSES) {
      state.runsSinceLossStreak = (state.runsSinceLossStreak || 0) + 1;
      if (dd.onCooldown) {
        push(`❄️ COOLDOWN — ${dd.consecLosses} consecutive losses. Skipping this run.`);
        saveState(state);
        return { ok: true, log };
      }
    } else {
      state.runsSinceLossStreak = 0;
    }

    if (dd.survival) {
      push(`⚠️ SURVIVAL MODE — Bankroll at ${dd.bankrollPct.toFixed(1)}%. Half sizing active.`);
    }
    if (dd.consecLosses >= MAX_CONSEC_LOSSES) {
      push(`⚠️ LOSS STREAK — ${dd.consecLosses} consecutive losses. Reduced sizing.`);
    }

    // 3. Find new opportunities
    const deployedPct = state.openPositions.reduce((s, p) => s + p.betSize, 0) / state.bankroll * 100;
    const canBet = state.openPositions.length < MAX_POSITIONS && deployedPct < MAX_DEPLOYED_PCT && state.bankroll > MIN_BET;

    if (canBet) {
      const [csgo, dota2, lol, polyMarkets] = await Promise.all([
        pandaFetch("csgo/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("dota2/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("lol/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        fetchAllPolymarketEsports(),
      ]);

      const allMatches = [
        ...csgo.map(m => ({ ...m, _game: "csgo" })),
        ...dota2.map(m => ({ ...m, _game: "dota2" })),
        ...lol.map(m => ({ ...m, _game: "lol" })),
      ];

      push(`📊 Found ${allMatches.length} upcoming matches, ${polyMarkets.length} Polymarket moneyline markets`);

      const opportunities = [];
      let skippedLowLiq = 0;

      for (const m of allMatches) {
        const t1 = m.opponents?.[0]?.opponent;
        const t2 = m.opponents?.[1]?.opponent;
        if (!t1 || !t2) continue;

        const matchTime = new Date(m.scheduled_at);
        const hoursUntil = (matchTime - now) / 3600000;
        if (hoursUntil < BET_WINDOW_MIN_H || hoursUntil > BET_WINDOW_MAX_H) continue;
        if (state.openPositions.some(p => p.matchId === m.id)) continue;

        const polyOdds = matchPolymarket(polyMarkets, t1.name, t2.name) ||
                         matchPolymarket(polyMarkets, t1.acronym || t1.name, t2.acronym || t2.name);
        if (!polyOdds) continue;

        // FILTER: Skip low-liquidity markets — prices are meaningless without real money behind them
        if (polyOdds.liquidity < MIN_LIQUIDITY) {
          skippedLowLiq++;
          continue;
        }

        // FILTER: Skip coin-flip markets — need real price discovery signal
        const maxProb = Math.max(polyOdds.probA, polyOdds.probB);
        if (maxProb < PRICE_DISCOVERY_MIN) {
          skippedLowLiq++;
          continue;
        }

        opportunities.push({ match: m, t1, t2, polyOdds });
      }

      push(`🎯 ${opportunities.length} quality matches (skipped ${skippedLowLiq} low-liquidity/no-edge markets)`);

      // Analyze ALL matched opportunities — needed for both edge + confirmation bets
      const analyzed = [];
      const allPredictions = [];  // Store all predictions for confirmation bet scan

      for (const opp of opportunities) {
        try {
          const [histA, histB] = await Promise.all([
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t1.id}&per_page=25&sort=-scheduled_at`),
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t2.id}&per_page=25&sort=-scheduled_at`),
          ]);

          const pred = computePrediction(opp.t1.id, opp.t2.id, histA, histB, opp.match.number_of_games, state.modelWeights);

          const pickSide = pred.probA >= pred.probB ? "A" : "B";
          const ourProb = pickSide === "A" ? pred.probA : pred.probB;
          const marketProb = pickSide === "A" ? opp.polyOdds.probA : opp.polyOdds.probB;
          const edge = ourProb - marketProb;

          allPredictions.push({ opp, pred, pickSide, ourProb, marketProb, edge });

          // Edge bet filters — only if circuit breaker is NOT active
          if (circuitBroken) continue;
          if (ourProb < MIN_OUR_PROB) continue;
          if (edge < MIN_EDGE) continue;
          if (pred.confidence === "low" && ourProb < 65) continue;

          analyzed.push({ opp, pred, pickSide, ourProb, marketProb, edge });
        } catch (e) {
          push(`⚠️ Error analyzing ${opp.t1.name} vs ${opp.t2.name}: ${e.message}`);
        }
      }

      // RANK by edge (highest first) — biggest market mispricing = best opportunity
      analyzed.sort((a, b) => b.edge - a.edge);

      if (analyzed.length > 0) {
        push(`🏆 ${analyzed.length} opportunities pass filters — ranked by edge:`);
        for (let i = 0; i < Math.min(analyzed.length, 5); i++) {
          const a = analyzed[i];
          const pick = a.pickSide === "A" ? (a.opp.t1.acronym || a.opp.t1.name) : (a.opp.t2.acronym || a.opp.t2.name);
          push(`   ${i + 1}. ${pick} (${a.opp.t1.acronym || a.opp.t1.name} vs ${a.opp.t2.acronym || a.opp.t2.name}) — Edge: +${a.edge.toFixed(1)}% | Model: ${a.ourProb.toFixed(1)}% | Market: ${a.marketProb.toFixed(1)}% | Liq: $${a.opp.polyOdds.liquidity.toFixed(0)}`);
        }
      } else {
        push("📭 No opportunities pass quality filters this run");
      }

      // Take only the BEST bet (highest win probability)
      const betsPlaced = [];
      for (const a of analyzed) {
        if (betsPlaced.length >= BETS_PER_RUN) break;
        if (state.openPositions.length >= MAX_POSITIONS) break;
        const currentDeployed = state.openPositions.reduce((s, p) => s + p.betSize, 0);
        if (currentDeployed / state.bankroll * 100 >= MAX_DEPLOYED_PCT) break;

        const pick = a.pickSide === "A" ? (a.opp.t1.acronym || a.opp.t1.name) : (a.opp.t2.acronym || a.opp.t2.name);
        const betSize = calcBetSize(a.edge, state.bankroll, a.pred.confidence, a.opp.match.number_of_games || 1, dd.sizeMult);

        if (betSize > state.bankroll - currentDeployed) continue;

        const position = {
          id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          matchId: a.opp.match.id,
          game: a.opp.match._game,
          teamA: a.opp.t1.acronym || a.opp.t1.name,
          teamB: a.opp.t2.acronym || a.opp.t2.name,
          teamAId: a.opp.t1.id,
          teamBId: a.opp.t2.id,
          pick, pickSide: a.pickSide,
          ourProb: +a.ourProb.toFixed(1),
          marketProb: +a.marketProb.toFixed(1),
          edge: +a.edge.toFixed(1),
          betSize,
          betPercent: +(betSize / state.bankroll * 100).toFixed(1),
          confidence: a.pred.confidence,
          event: `${a.opp.t1.acronym || a.opp.t1.name} vs ${a.opp.t2.acronym || a.opp.t2.name}`,
          league: a.opp.match.league?.name || "",
          format: a.opp.match.number_of_games || 1,
          placedAt: now.toISOString(),
          matchTime: a.opp.match.scheduled_at,
          formA: a.pred.recordA,
          formB: a.pred.recordB,
          thesis: a.pred.thesis || "",
          polyUrl: a.opp.polyOdds.polyUrl || null,
          polyLiquidity: a.opp.polyOdds.liquidity,
          matchStatus: "upcoming",
        };

        state.openPositions.push(position);
        state.bankroll -= betSize;
        betsPlaced.push(position);

        push(`💰 BET PLACED: ${pick} in ${position.event} | Model: ${position.ourProb}% | Market: ${position.marketProb}% | Edge: +${position.edge}% | Size: $${betSize} | Liq: $${position.polyLiquidity.toFixed(0)}`);

        const polyLink = position.polyUrl ? `\n🔗 <a href="${position.polyUrl}">View on Polymarket</a>` : "";

        await sendTG(
          `💰 <b>NEW PAPER BET</b>\n\n` +
          `🎮 ${a.opp.match._game.toUpperCase()}\n` +
          `📋 ${position.event}\n` +
          `🏆 ${position.league} · BO${position.format}\n\n` +
          `<b>Pick: ${pick}</b>\n` +
          `Our model: <b>${position.ourProb}%</b>\n` +
          `Market: <b>${position.marketProb}%</b>\n` +
          `Edge: <b>+${position.edge}%</b>\n` +
          `Confidence: ${position.confidence}\n` +
          `Liquidity: $${position.polyLiquidity.toFixed(0)}\n\n` +
          `📝 <i>${position.thesis}</i>\n\n` +
          `💵 Bet: <b>$${betSize}</b> (${position.betPercent}% of bankroll)\n` +
          `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n` +
          `📊 Open positions: ${state.openPositions.length}/${MAX_POSITIONS}\n\n` +
          `⏰ Match: ${new Date(position.matchTime).toLocaleString()}` +
          polyLink
        );
      }

      // ─── Market Confirmation Bets ───────────────────────────────────────
      // When model AND market both agree on a heavy favorite, take a position.
      // These BYPASS the circuit breaker — we're riding the market, not fighting it.
      // Thesis: esports markets slightly underprice favorites (degen bettors love underdogs).
      if (CONFIRM_ENABLED && state.openPositions.length < MAX_POSITIONS) {
        let confirmBets = 0;

        // Use allPredictions (already computed above) — no extra API calls needed
        for (const ap of allPredictions) {
          if (confirmBets >= CONFIRM_MAX_PER_RUN) break;
          if (state.openPositions.length >= MAX_POSITIONS) break;
          if (state.openPositions.some(p => p.matchId === ap.opp.match.id)) continue;
          if ((ap.opp.polyOdds.liquidity || 0) < CONFIRM_MIN_LIQUIDITY) continue;

          // Already placed an edge bet on this match?
          if (betsPlaced.some(b => b.matchId === ap.opp.match.id)) continue;

          const { pred, pickSide, ourProb, marketProb } = ap;

          // Both model and market must agree this is a heavy favorite
          if (marketProb < CONFIRM_MIN_MARKET_PROB) continue;
          if (ourProb < CONFIRM_MIN_OUR_PROB) continue;
          if (pred.confidence === "low") continue;  // Need decent data

          const confirmSize = Math.max(MIN_BET, Math.round(state.bankroll * CONFIRM_MAX_BET_PCT / 100));
          const currentDeployed = state.openPositions.reduce((s, p) => s + p.betSize, 0);
          if (confirmSize > state.bankroll - currentDeployed) continue;

          const opp = ap.opp;
          const pick = pickSide === "A" ? (opp.t1.acronym || opp.t1.name) : (opp.t2.acronym || opp.t2.name);
          const edge = ourProb - marketProb;

          const position = {
            id: `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            matchId: opp.match.id,
            game: opp.match._game,
            teamA: opp.t1.acronym || opp.t1.name,
            teamB: opp.t2.acronym || opp.t2.name,
            teamAId: opp.t1.id,
            teamBId: opp.t2.id,
            pick, pickSide,
            ourProb: +ourProb.toFixed(1),
            marketProb: +marketProb.toFixed(1),
            edge: +edge.toFixed(1),
            betSize: confirmSize,
            betPercent: +(confirmSize / state.bankroll * 100).toFixed(1),
            confidence: pred.confidence,
            betType: "confirmation",  // Tag it so we can track performance separately
            event: `${opp.t1.acronym || opp.t1.name} vs ${opp.t2.acronym || opp.t2.name}`,
            league: opp.match.league?.name || "",
            format: opp.match.number_of_games || 1,
            placedAt: now.toISOString(),
            matchTime: opp.match.scheduled_at,
            formA: pred.recordA,
            formB: pred.recordB,
            thesis: `CONFIRMATION BET: Model (${ourProb.toFixed(0)}%) and market (${marketProb.toFixed(0)}%) both agree — heavy favorite. ${pred.thesis || ""}`,
            polyUrl: opp.polyOdds.polyUrl || null,
            polyLiquidity: opp.polyOdds.liquidity,
            matchStatus: "upcoming",
          };

          state.openPositions.push(position);
          state.bankroll -= confirmSize;
          confirmBets++;

          push(`🎯 CONFIRM BET: ${pick} in ${position.event} | Model: ${ourProb.toFixed(1)}% | Market: ${marketProb.toFixed(1)}% | Size: $${confirmSize} (small grind)`);

          const polyLink = position.polyUrl ? `\n🔗 <a href="${position.polyUrl}">View on Polymarket</a>` : "";
          await sendTG(
            `🎯 <b>CONFIRMATION BET</b>\n\n` +
            `🎮 ${opp.match._game.toUpperCase()}\n` +
            `📋 ${position.event}\n` +
            `🏆 ${position.league} · BO${position.format}\n\n` +
            `<b>Pick: ${pick} (heavy favorite)</b>\n` +
            `Our model: <b>${ourProb.toFixed(1)}%</b>\n` +
            `Market: <b>${marketProb.toFixed(1)}%</b>\n` +
            `Both agree — taking the chalk.\n\n` +
            `💵 Bet: <b>$${confirmSize}</b> (${position.betPercent}% — small grind)\n` +
            `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>` +
            polyLink
          );
        }
      }
    } else {
      if (state.openPositions.length >= MAX_POSITIONS) push("⏸️ Max positions reached");
      else if (deployedPct >= MAX_DEPLOYED_PCT) push("⏸️ Max deployment reached");
      else if (state.bankroll <= MIN_BET) push("⏸️ Bankroll too low");
    }

    // 4. Update match status on open positions
    for (const pos of state.openPositions) {
      const matchTime = new Date(pos.matchTime);
      if (now > matchTime) pos.matchStatus = "live";
      else pos.matchStatus = "upcoming";
    }

    // 5. Save state
    state.lastRunAt = now.toISOString();
    state.totalRuns = (state.totalRuns || 0) + 1;
    state.closedPositions = (state.closedPositions || []).slice(0, 500);

    // 6. Daily summary — send once per day around midnight UTC
    const lastSummary = state.lastDailySummary ? new Date(state.lastDailySummary) : null;
    const hourUTC = now.getUTCHours();
    if (hourUTC === 23 && (!lastSummary || now.toDateString() !== lastSummary.toDateString())) {
      const todayClosed = (state.closedPositions || []).filter(p => {
        const d = new Date(p.resolvedAt);
        return d.toDateString() === now.toDateString();
      });
      const todayPnl = todayClosed.reduce((s, p) => s + (p.pnl || 0), 0);
      const todayWins = todayClosed.filter(p => p.result === "win").length;
      const todayLosses = todayClosed.filter(p => p.result === "loss").length;
      const totalPnl = state.bankroll - state.initialBankroll;
      const allClosed = state.closedPositions || [];
      const allWins = allClosed.filter(p => p.result === "win").length;
      const allLosses = allClosed.filter(p => p.result === "loss").length;

      await sendTG(
        `📊 <b>DAILY SUMMARY</b> — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}\n\n` +
        `<b>Today:</b>\n` +
        `   ${todayWins}W - ${todayLosses}L | P&L: ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(2)}\n` +
        (todayClosed.length > 0 ? todayClosed.map(p => `   ${p.result === "win" ? "✅" : "❌"} ${p.pick} (${p.event}) ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}`).join("\n") + "\n" : "   No bets resolved today\n") +
        `\n<b>All-Time:</b>\n` +
        `   ${allWins}W - ${allLosses}L (${allWins + allLosses > 0 ? (allWins / (allWins + allLosses) * 100).toFixed(0) : 0}% hit rate)\n` +
        `   P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${(totalPnl / state.initialBankroll * 100).toFixed(1)}% ROI)\n` +
        `   Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n` +
        `   Open: ${state.openPositions.length} positions\n\n` +
        `🔄 ${state.totalRuns} total runs today`
      );
      state.lastDailySummary = now.toISOString();
    }

    saveState(state);

    const pnl = state.bankroll - state.initialBankroll;
    push(`\n📈 Bankroll: $${state.bankroll.toFixed(2)} | P&L: $${pnl.toFixed(2)} | Open: ${state.openPositions.length} | Closed: ${state.closedPositions.length} | Run #${state.totalRuns}`);

    return { ok: true, log };

  } catch (e) {
    push(`❌ Fatal error: ${e.message}`);
    return { ok: false, error: e.message, log };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP SERVER — Serves bot state to the dashboard + manual trigger
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = CFG.PORT || 3069;

const server = createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-bot-secret");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const secret = url.searchParams.get("secret") || req.headers["x-bot-secret"];

  // Auth check
  if (secret !== CFG.BOT_SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // GET /state — return current bot state
  if (url.pathname === "/state" || url.pathname === "/") {
    const state = loadState();
    if (!state) {
      res.writeHead(200);
      res.end(JSON.stringify({
        bankroll: 1000, initialBankroll: 1000,
        openPositions: [], closedPositions: [],
        modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
        calibration: { totalPredictions: 0, correctPredictions: 0, bins: {} },
        lastRunAt: null, totalRuns: 0,
      }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify(state));
    }
    return;
  }

  // GET /run — manually trigger bot run
  if (url.pathname === "/run") {
    console.log("🔧 Manual bot run triggered");
    const result = await runBot();
    res.writeHead(result.ok ? 200 : 500);
    res.end(JSON.stringify(result));
    return;
  }

  // GET /log — return last 100 lines of bot.log
  if (url.pathname === "/log") {
    try {
      const logContent = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf-8") : "";
      const lines = logContent.trim().split("\n").slice(-100);
      res.writeHead(200);
      res.end(JSON.stringify({ lines }));
    } catch {
      res.writeHead(200);
      res.end(JSON.stringify({ lines: [] }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found. Use /state, /run, or /log" }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM COMMAND LISTENER — /trades, /status, /run
// ═══════════════════════════════════════════════════════════════════════════════

const GAME_LABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL" };

async function handleTelegramCommand(text) {
  const state = loadState();
  if (!state) return "Bot hasn't run yet. No state available.";

  const cmd = text.trim().toLowerCase();

  if (cmd === "/trades" || cmd === "/positions") {
    const open = state.openPositions || [];
    if (open.length === 0) return "📭 No open trades right now.";

    // Fetch live Polymarket prices
    let polyMarkets = [];
    try { polyMarkets = await fetchAllPolymarketEsports(); } catch {}

    let msg = `📊 <b>OPEN TRADES (${open.length})</b>\n`;
    const deployed = open.reduce((s, p) => s + p.betSize, 0);
    msg += `💰 $${deployed.toFixed(0)} deployed of $${(state.bankroll + deployed).toFixed(0)} bankroll\n\n`;

    for (let i = 0; i < open.length; i++) {
      const p = open[i];
      const game = GAME_LABEL[p.game] || p.game;
      const matchDate = new Date(p.matchTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      const link = p.polyUrl || `https://polymarket.com/markets/esports`;

      // Get live Polymarket price for this position
      const liveOdds = matchPolymarket(polyMarkets, p.teamA, p.teamB);
      const liveProb = liveOdds ? (p.pickSide === "A" ? liveOdds.probA : liveOdds.probB) : null;

      // Calculate unrealized P&L based on current market price vs entry
      let livePnl = null;
      let livePnlStr = "";
      if (liveProb !== null) {
        // If we bought at marketProb and current price is liveProb
        // P&L = betSize * (liveProb - entryProb) / entryProb
        livePnl = p.betSize * ((liveProb / p.marketProb) - 1);
        const sign = livePnl >= 0 ? "+" : "";
        livePnlStr = `${sign}$${livePnl.toFixed(2)}`;
      }

      const statusEmoji = p.matchStatus === "live" ? "🔴 LIVE" : "⏰ Upcoming";
      msg += `${i + 1}. <b>${game}</b> — ${p.event} [${statusEmoji}]\n`;
      msg += `   Pick: <b>${p.pick}</b> | $${p.betSize} bet\n`;
      msg += `   Entry: ${p.marketProb}%`;
      if (liveProb !== null) {
        const arrow = liveProb > p.marketProb ? "📈" : liveProb < p.marketProb ? "📉" : "➡️";
        msg += ` → Now: <b>${liveProb.toFixed(1)}%</b> ${arrow}`;
      }
      msg += `\n`;
      msg += `   Model: ${p.ourProb}% | Edge: +${p.edge}%\n`;
      if (livePnlStr) msg += `   Live P&L: <b>${livePnlStr}</b>\n`;
      msg += `   ${p.league} · BO${p.format} · ${matchDate} UTC\n`;
      if (p.polyLiquidity) msg += `   💧 Liquidity: $${p.polyLiquidity.toFixed(0)}\n`;
      if (p.thesis) msg += `   📝 <i>${p.thesis}</i>\n`;
      msg += `   🔗 <a href="${link}">View on Polymarket</a>\n\n`;
    }

    // Total unrealized P&L
    if (polyMarkets.length > 0) {
      let totalLivePnl = 0;
      let counted = 0;
      for (const p of open) {
        const lo = matchPolymarket(polyMarkets, p.teamA, p.teamB);
        if (lo) {
          const lp = p.pickSide === "A" ? lo.probA : lo.probB;
          totalLivePnl += p.betSize * ((lp / p.marketProb) - 1);
          counted++;
        }
      }
      if (counted > 0) {
        const sign = totalLivePnl >= 0 ? "+" : "";
        msg += `💹 <b>Total Unrealized: ${sign}$${totalLivePnl.toFixed(2)}</b>`;
      }
    }

    return msg;
  }

  if (cmd === "/status" || cmd === "/stats") {
    const pnl = state.bankroll - (state.initialBankroll || 1000);
    const closed = state.closedPositions || [];
    const open = state.openPositions || [];
    const wins = closed.filter(p => p.result === "win").length;
    const losses = closed.filter(p => p.result === "loss").length;
    const total = wins + losses;
    const hitRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
    const deployed = open.reduce((s, p) => s + p.betSize, 0);
    const totalPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
    const avgEdge = closed.length > 0 ? (closed.reduce((s, p) => s + (p.edge || 0), 0) / closed.length).toFixed(1) : "0.0";

    const w = state.modelWeights || {};

    let msg = `📈 <b>BOT STATUS</b>\n\n`;
    msg += `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n`;
    msg += `💰 P&L: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b> (${pnl >= 0 ? "+" : ""}${((pnl / (state.initialBankroll || 1000)) * 100).toFixed(1)}%)\n`;
    msg += `📊 Deployed: $${deployed.toFixed(0)} (${(deployed / state.bankroll * 100).toFixed(0)}%)\n\n`;
    msg += `🎯 <b>RECORD</b>\n`;
    msg += `   ${wins}W - ${losses}L (${hitRate}% hit rate)\n`;
    msg += `   Avg edge: ${avgEdge}%\n`;
    msg += `   Closed P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}\n\n`;
    msg += `📋 Open: ${open.length}/${MAX_POSITIONS} | Closed: ${closed.length}\n`;
    msg += `🧠 Weights: Form ${(w.form * 100 || 45).toFixed(0)}% · Overall ${(w.overall * 100 || 35).toFixed(0)}% · H2H ${(w.h2h * 100 || 15).toFixed(0)}%\n`;
    msg += `🔄 Run #${state.totalRuns || 0}`;
    if (state.lastRunAt) msg += ` · Last: ${new Date(state.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

    return msg;
  }

  if (cmd === "/run") {
    await sendTG("⚡ Manual bot run starting...");
    const result = await runBot();
    return result.ok ? "✅ Bot run complete." : `❌ Bot run failed: ${result.error}`;
  }

  if (cmd === "/reset") {
    const freshState = {
      bankroll: INITIAL_BANKROLL,
      initialBankroll: INITIAL_BANKROLL,
      openPositions: [],
      closedPositions: [],
      modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
      calibration: { totalPredictions: 0, correctPredictions: 0, bins: {} },
      lastRunAt: null,
      totalRuns: 0,
    };
    saveState(freshState);
    return `🔄 <b>BOT RESET</b>\n\nAll positions cleared.\nBankroll reset to $${INITIAL_BANKROLL}.\nReady for fresh start.`;
  }

  if (cmd === "/cancel") {
    if (!state.openPositions.length) return "📭 No open positions to cancel.";
    const refund = state.openPositions.reduce((s, p) => s + p.betSize, 0);
    state.bankroll += refund;
    const count = state.openPositions.length;
    state.openPositions = [];
    saveState(state);
    return `🚫 <b>CANCELED ${count} POSITIONS</b>\n\n$${refund} returned to bankroll.\nBankroll: <b>$${state.bankroll.toFixed(2)}</b>\n\nPrevious closed trades preserved.`;
  }

  if (cmd === "/deploy") {
    try {
      const repoDir = join(__dirname, "..");
      const pullResult = execSync("git pull", { cwd: repoDir, timeout: 30000 }).toString().trim();
      if (pullResult.includes("Already up to date")) {
        return "✅ Already up to date. No changes to deploy.";
      }
      await sendTG(`🚀 <b>DEPLOYING</b>\n\n<code>${pullResult}</code>\n\nRestarting bot in 2 seconds...`);
      // Give Telegram time to send the message, then exit — systemd will auto-restart us
      setTimeout(() => process.exit(0), 2000);
      return null; // Don't send another message
    } catch (e) {
      return `❌ Deploy failed: ${e.message}`;
    }
  }

  if (cmd === "/summary") {
    const closed = state.closedPositions || [];
    const open = state.openPositions || [];
    const totalPnl = state.bankroll - (state.initialBankroll || 1000);
    const allWins = closed.filter(p => p.result === "win").length;
    const allLosses = closed.filter(p => p.result === "loss").length;

    // Bot vs Market accuracy
    let botRight = 0, mktRight = 0;
    closed.forEach(p => {
      const botSaysWin = p.ourProb > 50;
      const mktSaysWin = p.marketProb > 50;
      const actualWin = p.result === "win";
      if (botSaysWin === actualWin) botRight++;
      if (mktSaysWin === actualWin) mktRight++;
    });

    // Loss reasons breakdown
    const reasons = {};
    closed.filter(p => p.lossReason).forEach(p => {
      reasons[p.lossReason] = (reasons[p.lossReason] || 0) + 1;
    });

    let msg = `📊 <b>FULL SUMMARY</b>\n\n`;
    msg += `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n`;
    msg += `💰 P&L: <b>${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</b> (${(totalPnl / (state.initialBankroll || 1000) * 100).toFixed(1)}% ROI)\n`;
    msg += `🎯 Record: <b>${allWins}W - ${allLosses}L</b> (${allWins + allLosses > 0 ? (allWins / (allWins + allLosses) * 100).toFixed(0) : 0}%)\n\n`;

    if (closed.length > 0) {
      msg += `🤖 <b>BOT vs MARKET</b>\n`;
      msg += `   Bot correct: ${botRight}/${closed.length} (${(botRight / closed.length * 100).toFixed(0)}%)\n`;
      msg += `   Market correct: ${mktRight}/${closed.length} (${(mktRight / closed.length * 100).toFixed(0)}%)\n\n`;
    }

    if (Object.keys(reasons).length > 0) {
      msg += `📝 <b>LOSS REASONS</b>\n`;
      Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
        msg += `   ${count}x — ${reason}\n`;
      });
      msg += "\n";
    }

    // Recent trades
    const recent5 = closed.slice(0, 5);
    if (recent5.length > 0) {
      msg += `📋 <b>LAST 5 TRADES</b>\n`;
      recent5.forEach(p => {
        const emoji = p.result === "win" ? "✅" : "❌";
        msg += `   ${emoji} ${p.pick} (${p.event}) ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}\n`;
      });
    }

    return msg;
  }

  if (cmd === "/help") {
    return `🤖 <b>Edge Terminal Bot</b>\n\n` +
      `/trades — Open positions with live prices + thesis\n` +
      `/status — Bankroll, P&L, win rate\n` +
      `/summary — Full analytics + bot vs market\n` +
      `/run — Trigger a bot run now\n` +
      `/deploy — Pull latest code + restart\n` +
      `/cancel — Cancel all open positions\n` +
      `/reset — Full reset (clears everything)\n` +
      `/help — This message`;
  }

  return null; // Not a recognized command
}

let tgOffset = 0;

async function pollTelegram() {
  if (!CFG.TELEGRAM_BOT_TOKEN || !CFG.TELEGRAM_CHAT_ID) return;

  try {
    const r = await fetch(`https://api.telegram.org/bot${CFG.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=30`);
    const data = await r.json();

    if (data.ok && data.result?.length > 0) {
      for (const update of data.result) {
        tgOffset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(CFG.TELEGRAM_CHAT_ID)) continue;

        const reply = await handleTelegramCommand(msg.text);
        if (reply) await sendTG(reply);
      }
    }
  } catch (e) {
    console.error("TG poll error:", e.message);
  }

  // Poll again
  setTimeout(pollTelegram, 1000);
}

// ─── Startup Mode ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--run")) {
  // One-shot mode: run the bot once and exit (for cron)
  console.log("⚡ Running bot (one-shot mode)...\n");
  runBot().then(result => {
    console.log(`\n${result.ok ? "✅ Done" : "❌ Failed"}`);
    process.exit(result.ok ? 0 : 1);
  });
} else {
  // Server mode: start HTTP server + Telegram listener + run bot immediately
  server.listen(PORT, () => {
    console.log(`\n🚀 Edge Terminal Bot Server running on port ${PORT}`);
    console.log(`   State:   http://localhost:${PORT}/state?secret=${CFG.BOT_SECRET}`);
    console.log(`   Trigger: http://localhost:${PORT}/run?secret=${CFG.BOT_SECRET}`);
    console.log(`   Logs:    http://localhost:${PORT}/log?secret=${CFG.BOT_SECRET}\n`);
  });

  // Start Telegram command listener
  console.log("📱 Starting Telegram command listener...");
  pollTelegram();

  // Run bot immediately on startup
  runBot().then(result => {
    console.log(`\n${result.ok ? "✅ Initial run complete" : "❌ Initial run failed"}\n`);
  });
}
