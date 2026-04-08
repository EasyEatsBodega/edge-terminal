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
const MAX_DEPLOYED_PCT = 25;
const MAX_POSITIONS = 8;
const MIN_EDGE = 4;
const MAX_BET_PCT = 8;
const MIN_BET = 10;
const BET_WINDOW_MIN_H = 0.25;
const BET_WINDOW_MAX_H = 8;          // Only bet matches starting within 8 hours
const MIN_LIQUIDITY = 1000;       // Skip markets with < $1k liquidity (no real price discovery)
const MIN_OUR_PROB = 55;          // Only bet teams we give 55%+ to win
const BETS_PER_RUN = 3;           // Take up to 3 best bets per run

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

// ─── Prediction Model (v2 — opponent strength + aggressive recency) ─────────

function computePrediction(teamAId, teamBId, histA, histB, format, weights) {
  // Extract results with opponent info and match metadata
  const getResults = (history, teamId) =>
    history.map(m => ({
      won: m.winner?.id === teamId,
      oppId: m.opponents?.find(o => o.opponent?.id !== teamId)?.opponent?.id,
      oppName: m.opponents?.find(o => o.opponent?.id !== teamId)?.opponent?.name || "?",
      date: m.scheduled_at || m.begin_at,
      bo: m.number_of_games || 1,
      league: m.league?.name || "",
      tournamentTier: m.tournament?.tier || "unranked",
    })).filter(r => r.oppId !== undefined);

  // Aggressive recency — last 5 matches weighted MUCH heavier than 6-10
  const recentFormWR = (results, n = 10) => {
    const recent = results.slice(0, n);
    if (!recent.length) return 50;
    let tw = 0, ww = 0;
    recent.forEach((r, i) => {
      // Exponential decay — match 0 has weight 1.0, match 9 has weight ~0.13
      const w = Math.pow(0.8, i);
      tw += w;
      if (r.won) ww += w;
    });
    return tw > 0 ? (ww / tw) * 100 : 50;
  };

  // Opponent-strength-adjusted win rate — wins vs tough opponents count more
  const strengthAdjustedWR = (results) => {
    if (!results.length) return 50;
    // Count how many of each opponent's other results were wins (proxy for strength)
    let tw = 0, ww = 0;
    results.forEach(r => {
      // Tier-based strength multiplier
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

  // Hot/cold streak detection — last 3 matches
  const streakFactor = (results) => {
    const last3 = results.slice(0, 3);
    if (last3.length < 3) return 0;
    const wins = last3.filter(r => r.won).length;
    if (wins === 3) return 4;   // Hot streak bonus
    if (wins === 0) return -4;  // Cold streak penalty
    return 0;
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

  const fw = weights.form || 0.40;
  const sw = 0.20; // opponent strength weight
  const ow = weights.overall || 0.25;
  const hw = h2h.n >= 3 ? (weights.h2h || 0.15) : 0.05;
  const owAdj = ow + ((weights.h2h || 0.15) - hw);

  const sA = fw * formA + sw * strengthA + owAdj * allA + hw * h2h.wr;
  const sB = fw * formB + sw * strengthB + owAdj * allB + hw * (100 - h2h.wr);

  let prob = (sA + sB) > 0 ? (sA / (sA + sB)) * 100 : 50;

  // Apply streak adjustment
  prob += (streakA - streakB) * 0.5;

  // BO format adjustment — BO1 is volatile, BO3+ rewards better team
  const bo = format || 1;
  if (bo === 1) prob = prob * 0.82 + 50 * 0.18;  // Stronger pull to 50% for BO1
  else if (bo >= 5) prob = 50 + (prob - 50) * 1.12;

  prob = Math.max(5, Math.min(95, prob));
  const confidence = Math.min(rA.length, rB.length) >= 8 ? "high" : Math.min(rA.length, rB.length) >= 4 ? "medium" : "low";

  // Build thesis (plain English reasoning)
  const thesis = buildThesis(
    rA, rB, formA, formB, strengthA, strengthB, allA, allB,
    h2h, streakA, streakB, bo, prob,
    teamAId, teamBId
  );

  return {
    probA: prob, probB: 100 - prob, confidence, thesis,
    formA: recentFormWR(rA, 10), formB: recentFormWR(rB, 10),
    strengthA, strengthB,
    overallA: allA, overallB: allB,
    h2hWR: h2h.wr, h2hN: h2h.n,
    streakA, streakB,
    recordA: `${rA.filter(r => r.won).length}-${rA.filter(r => !r.won).length}`,
    recordB: `${rB.filter(r => r.won).length}-${rB.filter(r => !r.won).length}`,
    dataPointsA: rA.length, dataPointsB: rB.length,
  };
}

// ─── Thesis Generator — plain English reasoning for each bet ────────────────

function buildThesis(rA, rB, formA, formB, strA, strB, allA, allB, h2h, streakA, streakB, bo, prob, teamAId, teamBId) {
  const parts = [];
  const fav = prob > 50 ? "A" : "B";
  const favForm = fav === "A" ? formA : formB;
  const dogForm = fav === "A" ? formB : formA;
  const favStr = fav === "A" ? strA : strB;

  // Form analysis
  const formDiff = Math.abs(formA - formB);
  if (formDiff > 15) {
    parts.push(`Strong form gap — ${favForm.toFixed(0)}% vs ${dogForm.toFixed(0)}% weighted recent`);
  } else if (formDiff > 8) {
    parts.push(`Moderate form edge (${favForm.toFixed(0)}% vs ${dogForm.toFixed(0)}%)`);
  } else {
    parts.push(`Similar form (${formA.toFixed(0)}% vs ${formB.toFixed(0)}%)`);
  }

  // Strength-adjusted
  if (Math.abs(strA - strB) > 10) {
    const betterStr = strA > strB ? "A" : "B";
    parts.push(`${betterStr === "A" ? "Team A" : "Team B"} wins against tougher opponents`);
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

// ─── Bet Sizing ─────────────────────────────────────────────────────────────

function calcBetSize(edge, bankroll, confidence, format = 3) {
  const kellyFull = edge / 100 * bankroll;
  let fraction;
  if (edge >= 8) fraction = 1.0;
  else if (edge >= 5) fraction = 0.75;
  else fraction = 0.5;

  if (confidence === "low") fraction *= 0.5;
  else if (confidence === "medium") fraction *= 0.75;

  // BO1 penalty — half the bet size due to high variance
  if (format === 1) fraction *= 0.5;

  let size = Math.round(kellyFull * fraction);
  size = Math.max(MIN_BET, size);
  size = Math.min(Math.round(bankroll * MAX_BET_PCT / 100), size);
  return Math.round(size);
}

// ─── Self-Improving Model ───────────────────────────────────────────────────

function adjustWeights(state) {
  const closed = state.closedPositions || [];
  if (closed.length < 10) return state.modelWeights;

  const recent = closed.slice(0, 30);
  let overconfident = 0;

  recent.forEach(p => {
    const predicted = p.pickSide === "A" ? p.ourProb : 100 - p.ourProb;
    if (predicted > 60 && p.result === "loss") overconfident++;
  });

  const total = recent.length;
  const wins = recent.filter(p => p.result === "win").length;
  const actualHitRate = wins / total;
  const weights = { ...state.modelWeights };

  if (overconfident / total > 0.3) {
    weights.form = Math.max(0.25, weights.form - 0.03);
    weights.overall = Math.min(0.45, weights.overall + 0.02);
    weights.h2h = Math.min(0.25, weights.h2h + 0.01);
  }

  if (actualHitRate > 0.6) {
    weights.form = Math.min(0.55, weights.form + 0.01);
  }

  const sum = weights.form + weights.overall + weights.h2h;
  if (sum > 0) {
    const scale = 0.95 / sum;
    weights.form *= scale;
    weights.overall *= scale;
    weights.h2h *= scale;
  }

  return weights;
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
      // Fetch MORE matches per game to scan wider
      const [csgo, dota2, lol, polyMarkets] = await Promise.all([
        pandaFetch("csgo/matches/upcoming?per_page=50&sort=scheduled_at").catch(() => []),
        pandaFetch("dota2/matches/upcoming?per_page=50&sort=scheduled_at").catch(() => []),
        pandaFetch("lol/matches/upcoming?per_page=50&sort=scheduled_at").catch(() => []),
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

        // FILTER: Skip markets where both sides are 40-60% — no real price discovery
        const maxProb = Math.max(polyOdds.probA, polyOdds.probB);
        if (maxProb < 60) {
          skippedLowLiq++;
          continue;
        }

        opportunities.push({ match: m, t1, t2, polyOdds });
      }

      push(`🎯 ${opportunities.length} quality matches (skipped ${skippedLowLiq} low-liquidity/no-edge markets)`);

      // Analyze ALL matched opportunities, not just first 8
      const analyzed = [];

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

          if (ourProb < MIN_OUR_PROB) continue;   // Must strongly believe team wins
          if (edge < MIN_EDGE) continue;           // Must have real edge vs market
          if (pred.confidence === "low" && edge < 10) continue;  // Low confidence needs BIG edge

          analyzed.push({ opp, pred, pickSide, ourProb, marketProb, edge });
        } catch (e) {
          push(`⚠️ Error analyzing ${opp.t1.name} vs ${opp.t2.name}: ${e.message}`);
        }
      }

      // RANK by win probability (highest first) — we want the BEST chance to WIN
      analyzed.sort((a, b) => b.ourProb - a.ourProb);

      if (analyzed.length > 0) {
        push(`🏆 ${analyzed.length} opportunities pass filters — top picks:`);
        for (let i = 0; i < Math.min(analyzed.length, 5); i++) {
          const a = analyzed[i];
          const pick = a.pickSide === "A" ? (a.opp.t1.acronym || a.opp.t1.name) : (a.opp.t2.acronym || a.opp.t2.name);
          push(`   ${i + 1}. ${pick} (${a.opp.t1.acronym || a.opp.t1.name} vs ${a.opp.t2.acronym || a.opp.t2.name}) — Model: ${a.ourProb.toFixed(1)}% | Market: ${a.marketProb.toFixed(1)}% | Edge: +${a.edge.toFixed(1)}% | Liq: $${a.opp.polyOdds.liquidity.toFixed(0)}`);
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
        const betSize = calcBetSize(a.edge, state.bankroll, a.pred.confidence, a.opp.match.number_of_games || 1);

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
