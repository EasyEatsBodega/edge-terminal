#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// EDGE TERMINAL — Paper Trading Bot (VPS Standalone)
// Runs on cron. Stores state in a local JSON file. No Redis needed.
// Also runs a tiny HTTP server so the dashboard can read bot state.
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { getHltvRankDelta, rankDeltaToProbAdjust } from "./hltv.mjs";
import { checkMatchRosters } from "./liquipedia.mjs";
import { fetchPinnacleAllEsports, matchPinnacle } from "./pinnacle.mjs";
import { getOpenDotaRating, getOpenDotaRatingDelta, ratingDeltaToProbAdjust as odRatingToProbAdjust } from "./opendota.mjs";
import { getVlrRank, getVlrRankDelta, vlrRankDeltaToProbAdjust } from "./vlr.mjs";
import { getCurrentLolPatch, filterToCurrentPatch, patchBreakdown } from "./lol.mjs";

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
const MAX_DEPLOYED_PCT = 35;         // Allow more deployment for volume
const MAX_POSITIONS = 10;            // More concurrent positions for action
const MIN_EDGE = 4;                  // Raised from 3: Polymarket vig inflates perceived edge
const MIN_EDGE_PINNACLE_BONUS = 1;   // +1% required when betting against sharp Pinnacle price
const MAX_EDGE = 25;                 // SANITY CHECK: edges >25% indicate wrong market matched
const MAX_BET_PCT = 5;               // Smaller max bet — survival first
const MIN_BET = 5;
const BET_WINDOW_MIN_H = -1.5;       // Allow live betting up to 90min into match
const BET_WINDOW_MAX_H = 8;          // 8h max window — more matches in scope
const PRIORITY_WINDOW_H = 3;         // Matches within 3h get priority ranking
const LIVE_ONLY_THRESHOLD_H = 0;     // Matches with hoursUntil < 0 are "live"
const LIVE_MIN_MARKET_PROB = 75;     // Live bets: must still be 75%+ favorite
const LIVE_SIZE_MULTIPLIER = 0.5;    // Live bets: half-size due to variance
const MIN_LIQUIDITY = 1500;          // Lowered from $2k — esports markets can be thinner
const MIN_OUR_PROB = 55;             // Lowered — catch more confident picks
const BETS_PER_RUN = 3;              // Up to 3 edge bets per run
const PRICE_DISCOVERY_MIN = 55;      // Lowered from 58 — catch slight favorites

// ─── Market Confirmation Mode ──────────────────────────────────────────────
// When model AND market agree on a favorite, take a position sized by tier.
// Esports markets tend to underprice favorites (degen bettors love underdogs).
// TIERED: heavy consensus = bigger bet, slight consensus = tiny grind bet.
const CONFIRM_ENABLED = true;
const CONFIRM_MIN_MARKET_PROB = 65;  // Market must see team as 65%+ favorite (lowered from 72)
const CONFIRM_MIN_OUR_PROB = 63;     // Our model must also agree (lowered from 70)
const CONFIRM_MIN_LIQUIDITY = 2000;  // Match edge filter (lowered from 3000)
const CONFIRM_MAX_PER_RUN = 4;       // Up to 4 confirmation bets per run (raised from 3)

// Tiered sizing — stronger consensus = bigger position
const CONFIRM_TIERS = [
  { minMarket: 85, minModel: 82, pct: 8, label: "LOCK" },     // 85%+ market + 82%+ model = 8% bankroll
  { minMarket: 78, minModel: 76, pct: 6, label: "STRONG" },   // 78%+ = 6%
  { minMarket: 72, minModel: 70, pct: 4, label: "LEAN" },     // 72%+ = 4%
  { minMarket: 65, minModel: 63, pct: 2, label: "MICRO" },    // 65%+ = 2% (slight favorites grind)
];

// ─── FADE Strategy (Live Betting) ──────────────────────────────────────────
// When a pre-match heavy favorite drops significantly mid-match, the market
// is often overreacting to early losses. A team that was 80% pre-match and
// is now 60% mid-BO3 after losing game 1 might still have a 65-70% true
// probability — we can buy the favorite at a live discount.
const FADE_ENABLED = true;
const FADE_MIN_PREMATCH_PROB = 75;   // Was a heavy favorite pre-match
const FADE_MIN_DROP_PCT = 12;        // Price dropped at least 12% live.
                                     // (Raised from 8%: an 8% drop on a 75% fav
                                     //  is often the market being *correct*
                                     //  about new info — not overreacting.)
const FADE_MIN_CURRENT_PROB = 50;    // Still at least a coin flip (not a total collapse)
const FADE_MAX_CURRENT_PROB = 60;    // Need a genuine discount, not just a dip.
                                     // (Tightened from 72% — fading a fav still
                                     //  priced at 70% is buying chalk at a full
                                     //  price, not a discount.)
const FADE_BET_PCT = 3;              // 3% of bankroll per fade bet
const FADE_MAX_PER_RUN = 2;          // Up to 2 fade bets per run
const FADE_MIN_LIQUIDITY = 2500;     // Need real liquidity for live bets

// ─── Game-Specific Adjustments ─────────────────────────────────────────────
// Each game plays very differently. One model doesn't fit all.
const GAME_TUNING = {
  csgo: {
    bo1Penalty: 0.30,    // CS2 BO1 is extremely volatile (pistol rounds, eco stacks)
    formWeight: 1.1,     // Recent form matters more in CS2 (map pool meta shifts)
    minEdge: 5,          // Sharp book (HLTV-followed) — need real edge
    recencyDays: 21,     // ~3 weeks of CS2 form before treating it as stale
  },
  dota2: {
    bo1Penalty: 0.20,    // Dota BO1 less volatile than CS2 (draft matters more)
    formWeight: 0.9,     // Patches shake up Dota form — overall matters more
    minEdge: 5,          // Standard edge threshold
    recencyDays: 21,     // Dota patch cycle roughly every 3-4 weeks
  },
  lol: {
    bo1Penalty: 0.22,    // LoL BO1 moderate volatility
    formWeight: 1.0,     // Standard form weight
    minEdge: 5,          // Standard edge threshold
    recencyDays: 21,     // LoL has its own patch filter in lol.mjs; this is a fallback
  },
  valorant: {
    bo1Penalty: 0.28,    // Valorant BO1 is volatile (agent picks, map bans matter)
    formWeight: 1.0,     // Standard
    minEdge: 5,          // Standard edge threshold
    recencyDays: 14,     // Val patch cadence ~2 weeks, agent meta shifts fast
  },
  r6siege: {
    bo1Penalty: 0.30,    // R6 BO1 is extremely volatile (one round swings it)
    formWeight: 1.0,     // Standard
    minEdge: 5,          // Standard — R6 markets are thinner so edges are real
    recencyDays: 28,     // R6 seasons are longer, meta moves slower
  },
};

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

// Atomic save: write to .tmp then rename. Readers never see partial data.
function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ─── Cross-Process Run Lock ────────────────────────────────────────────────
// Prevents duplicate resolution messages when service + cron fire at the same
// time. Also prevents HTTP /run + Telegram /run from racing each other within
// the service. Stale locks (>5 min old) are considered abandoned and cleared.
const LOCK_PATH = join(__dirname, "run.lock");
const LOCK_STALE_MS = 5 * 60 * 1000;

function acquireRunLock() {
  // Clean up stale lock first
  if (existsSync(LOCK_PATH)) {
    try {
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (age >= LOCK_STALE_MS) {
        console.log(`⚠️ Stale run lock (${Math.round(age / 1000)}s old), clearing.`);
        unlinkSync(LOCK_PATH);
      }
    } catch {}
  }
  // Atomic create — "wx" uses O_CREAT | O_EXCL so only one process wins.
  // If another process already owns the lock, this throws EEXIST.
  try {
    writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    console.error("Lock acquire failed:", e.message);
    return false;
  }
}

function releaseRunLock() {
  try { if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH); } catch {}
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

// Tag IDs for esports games on Polymarket. Valorant ID might need adjustment
// — if Valorant matches aren't being found, Polymarket's actual tag ID differs.
// The fetchAllPolymarketEsports also does a general esports sweep as fallback.
const POLY_TAG = { csgo: 100780, dota2: 102366, lol: 65, valorant: 102370 };

async function fetchPolymarketByGame(game) {
  const tagId = POLY_TAG[game];
  if (!tagId) return [];
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?sports_market_types=moneyline&closed=false&tag_id=${tagId}&limit=50`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Fallback: fetch all active moneyline sports markets with no tag filter.
// This catches Valorant (and any other esports) markets we might miss if
// our tag IDs are wrong or if Polymarket adds new categories.
async function fetchAllPolymarketMoneyline() {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?sports_market_types=moneyline&closed=false&limit=200`);
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function fetchAllPolymarketEsports() {
  const [csgo, dota2, lol, valorant, general] = await Promise.all([
    fetchPolymarketByGame("csgo"),
    fetchPolymarketByGame("dota2"),
    fetchPolymarketByGame("lol"),
    fetchPolymarketByGame("valorant"),
    fetchAllPolymarketMoneyline(),
  ]);
  // Dedupe by market id/slug — the general fetch overlaps with game-specific ones
  const seen = new Set();
  const all = [...csgo, ...dota2, ...lol, ...valorant, ...general];
  const deduped = [];
  for (const mkt of all) {
    const key = mkt.id || mkt.conditionId || mkt.slug || JSON.stringify(mkt.outcomes);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mkt);
  }
  return deduped;
}

// How well does a candidate string match a target string?
// Returns 0-100 score. Handles exact, prefix, suffix, substring matches.
function nameMatchScore(target, candidate) {
  if (!target || !candidate) return 0;
  if (target === candidate) return 100;

  // Normalize lengths for proportional scoring
  const shorter = Math.min(target.length, candidate.length);
  const longer = Math.max(target.length, candidate.length);
  // Both must be at least 3 chars for fuzzy matches (avoid "te" matching "team")
  if (shorter < 3) return 0;
  // Shorter must be a meaningful fraction of longer (at least 30%)
  if (shorter / longer < 0.30) return 0;

  // Prefix match — "nova" is prefix of "novaesports". This is a very strong
  // signal because teams are typically listed by their core brand name first.
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 85;

  // Suffix match — less common but still strong
  if (candidate.endsWith(target) || target.endsWith(candidate)) return 75;

  // Substring match — one contains the other (not as prefix/suffix)
  if (candidate.includes(target) || target.includes(candidate)) return 60;

  return 0;
}

// Score how well a Polymarket market matches a given team pair.
// Returns 0 if not a real match-winner market, higher scores for better matches.
function scoreMarketMatch(mkt, teamA, teamB) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(teamA);
  const b = norm(teamB);
  if (!a || !b || a.length < 2 || b.length < 2) return 0;

  const rawOutcomes = typeof mkt.outcomes === "string" ? JSON.parse(mkt.outcomes) : (mkt.outcomes || []);
  const outcomes = rawOutcomes.map(o => norm(String(o)));

  // Reject markets that aren't "Team A vs Team B" style moneylines.
  // Look for disqualifying keywords in the question — these indicate prop/specialty markets.
  const rawQ = (mkt.question || "").toLowerCase();
  const badKeywords = ["2-0", "2-1", "3-0", "3-1", "3-2", "total maps", "will any", "any map", "first blood", "first kill", "first to", "number of maps", "correct score", "exact score", "over under", "over/under", "parlay"];
  if (badKeywords.some(kw => rawQ.includes(kw))) return 0;
  // "map " is a specific disqualifier — but be careful not to match "mapping" etc.
  if (/\bmap\s/.test(rawQ) && !/vs.*?in\b/.test(rawQ)) return 0;

  // Must have exactly 2 outcomes for a head-to-head moneyline
  if (outcomes.length !== 2) return 0;

  // Score each team against each outcome, take the best
  const scoreA0 = nameMatchScore(a, outcomes[0]);
  const scoreA1 = nameMatchScore(a, outcomes[1]);
  const scoreB0 = nameMatchScore(b, outcomes[0]);
  const scoreB1 = nameMatchScore(b, outcomes[1]);

  // Best pairing: A matches one outcome, B matches the other
  const pairing1 = scoreA0 + scoreB1; // A=outcome0, B=outcome1
  const pairing2 = scoreA1 + scoreB0; // A=outcome1, B=outcome0
  const bestPairing = Math.max(pairing1, pairing2);

  // Require a minimum combined score — both teams must have some match
  // 100 = one exact + unmatched OR two decent partials (50+50)
  // Lowered from previous strict requirement so prefix matches work
  if (bestPairing < 100) return 0;

  // Need BOTH teams to match at least partially (not just one team scoring 100)
  const aBestScore = Math.max(scoreA0, scoreA1);
  const bBestScore = Math.max(scoreB0, scoreB1);
  if (aBestScore < 50 || bBestScore < 50) return 0;

  return bestPairing;
}

function matchPolymarket(polyMarkets, teamA, teamB) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(teamA);
  const b = norm(teamB);
  if (!a || !b) return null;

  // Score every market and pick the best-matching one.
  let best = null;
  let bestScore = 99; // require > 99 (minimum from scoreMarketMatch)

  for (const mkt of polyMarkets) {
    if (!mkt.outcomePrices) continue;
    const score = scoreMarketMatch(mkt, teamA, teamB);
    if (score > bestScore) {
      bestScore = score;
      best = mkt;
    }
  }

  if (!best) return null;

  const rawOutcomes = typeof best.outcomes === "string" ? JSON.parse(best.outcomes) : (best.outcomes || []);
  const outcomes = rawOutcomes.map(o => norm(String(o)));
  const prices = typeof best.outcomePrices === "string" ? JSON.parse(best.outcomePrices) : best.outcomePrices;
  if (prices.length < 2) return null;

  // Figure out which outcome is team A based on best match score
  const aScore0 = nameMatchScore(a, outcomes[0] || "");
  const aScore1 = nameMatchScore(a, outcomes[1] || "");
  const aIsFirst = aScore0 >= aScore1;

  const probFirst = parseFloat(prices[0]) * 100;
  const probSecond = parseFloat(prices[1]) * 100;
  const liquidity = parseFloat(best.liquidity) || 0;
  const volume = parseFloat(best.volume) || 0;
  const slug = best.slug || "";
  const polyUrl = slug ? `https://polymarket.com/event/${slug}` : null;

  const spread = Math.abs(probFirst - probSecond);
  const updatedAt = best.updated_at || best.lastTradeTimestamp || null;
  const hoursSinceUpdate = updatedAt ? (Date.now() - new Date(updatedAt).getTime()) / 3600000 : null;
  const volumePerLiq = liquidity > 0 ? volume / liquidity : 0;

  return {
    probA: aIsFirst ? probFirst : probSecond,
    probB: aIsFirst ? probSecond : probFirst,
    liquidity,
    volume,
    spread,
    hoursSinceUpdate,
    volumePerLiq,
    slug,
    polyUrl,
    question: best.question || "",
    matchScore: bestScore,
  };
}

// ─── Prediction Model (v3 — game scores, margins, dominance + recency) ─────

async function computePrediction(teamAId, teamBId, histA, histB, format, weights, game = null, teamAName = null, teamBName = null) {
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

  let rA = getResults(histA, teamAId);
  let rB = getResults(histB, teamBId);

  // ─── LoL Patch Filter ─────────────────────────────────────────────────
  // LoL meta shifts every ~2 weeks on patch day. Matches from prior patches
  // are on different champion balance and shouldn't count as equal evidence.
  // Filter team history to current patch (with previous-patch fallback if
  // data is thin). LoL has a precise patch signal via ddragon; other games
  // fall back to a simpler game-specific recency window below.
  let lolPatch = null, patchBreakdownA = null, patchBreakdownB = null;
  if (game === "lol") {
    try {
      lolPatch = await getCurrentLolPatch();
      patchBreakdownA = patchBreakdown(rA, lolPatch);
      patchBreakdownB = patchBreakdown(rB, lolPatch);
      rA = filterToCurrentPatch(rA, lolPatch.releaseDate, 4);
      rB = filterToCurrentPatch(rB, lolPatch.releaseDate, 4);
    } catch (e) {
      // ddragon unreachable — use full history
    }
  } else if (game && GAME_TUNING[game]?.recencyDays) {
    // ─── Form recency filter (CS2 / Dota / Val / R6) ──────────────────
    // Historically we treated a 30-day-old match as equal evidence to
    // last week's. That misses meta shifts, roster changes, and patch
    // resets. Keep only matches inside the game's recency window; if a
    // team has fewer than 4 matches in window, fall back to their full
    // history so the model isn't starved.
    const window = GAME_TUNING[game].recencyDays;
    const filterRecent = (rs) => {
      const recent = rs.filter(r => r.daysAgo <= window);
      return recent.length >= 4 ? recent : rs;
    };
    rA = filterRecent(rA);
    rB = filterRecent(rB);
  }

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

  // Rustiness — if a team hasn't played recently, pull their form toward 50%
  // A team with no matches in 14+ days is an unknown quantity
  const rustA = rA.length > 0 && rA[0].daysAgo > 14 ? Math.min((rA[0].daysAgo - 14) / 14, 1) * 0.15 : 0;
  const rustB = rB.length > 0 && rB[0].daysAgo > 14 ? Math.min((rB[0].daysAgo - 14) / 14, 1) * 0.15 : 0;

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

  // Rustiness penalty — pull toward 50% if team hasn't played recently
  // rustA/B range 0 to 0.15. If A is rusty, their predicted strength fades toward 50%.
  if (rustA > 0) prob = prob * (1 - rustA) + 50 * rustA;
  if (rustB > 0) prob = prob * (1 - rustB) + 50 * rustB;  // Rusty opponent = pull our edge back

  // ─── Blend a ranking-implied probability into the model ──────────────
  // NOTE: Earlier versions added rank-based adjustments directly to `prob`
  // (e.g. prob += 15). That stacks on top of an already-confident model and
  // produces overconfidence: a 70% pred + strong rank signal → 85% pred,
  // when in reality the model already captures much of the same info.
  //
  // Instead, treat the rank source as an independent estimate of the true
  // win probability and blend it with the base model as a weighted average.
  // The blend weight scales with signal strength: no signal → no shrinkage,
  // strong signal → meaningful pull toward the rank-implied prob.
  //
  //   signal   = |adjust| / maxAdjust     (0..1)
  //   rankProb = 50 + adjust              (rank source's point estimate)
  //   w        = maxWeight * signal       (0..maxWeight)
  //   prob'    = (1 - w) * prob + w * rankProb
  //
  // This produces the right behavior in each regime:
  //  - Rank neutral  → w ≈ 0, prob unchanged.
  //  - Rank agrees   → minor re-centering, never overshoots the rank.
  //  - Rank disagrees → prob is pulled toward the sharper third-party view.
  function blendRankSignal(baseProb, adjust, maxAdjust, maxWeight) {
    if (!adjust || !Number.isFinite(adjust)) return baseProb;
    const signal = Math.min(1, Math.abs(adjust) / maxAdjust);
    const rankProb = 50 + adjust;
    const w = maxWeight * signal;
    return baseProb * (1 - w) + rankProb * w;
  }

  // ─── HLTV Ranking Adjustment (CS2 only) ───────────────────────────────
  // HLTV rankings capture roster strength, map pool, and consistency that
  // our W/L-based model can miss. Max 35% blend weight when the signal is
  // at its strongest (±15 adjust).
  let hltvRankA = null, hltvRankB = null, hltvAdjust = 0;
  if (game === "csgo" && teamAName && teamBName) {
    try {
      const delta = await getHltvRankDelta(teamAName, teamBName);
      hltvAdjust = rankDeltaToProbAdjust(delta);
      prob = blendRankSignal(prob, hltvAdjust, 15, 0.35);
    } catch (e) {
      // HLTV unavailable — just skip the adjustment
    }
  }

  // ─── OpenDota Rating Adjustment (Dota 2 only) ─────────────────────────
  // OpenDota's Elo-style ratings capture cross-league strength our W/L
  // model can't see. Max 30% blend weight (slightly less than HLTV —
  // Dota form shifts hard on patch, so historical Elo is noisier).
  let odRatingA = null, odRatingB = null, odAdjust = 0;
  if (game === "dota2" && teamAName && teamBName) {
    try {
      const [aRating, bRating, delta] = await Promise.all([
        getOpenDotaRating(teamAName),
        getOpenDotaRating(teamBName),
        getOpenDotaRatingDelta(teamAName, teamBName),
      ]);
      odRatingA = aRating;
      odRatingB = bRating;
      odAdjust = odRatingToProbAdjust(delta);
      prob = blendRankSignal(prob, odAdjust, 12, 0.30);
    } catch (e) {
      // OpenDota unavailable — skip
    }
  }

  // ─── VLR.gg Ranking Adjustment (Valorant only) ────────────────────────
  // VLR regional rankings merged by points. Max 30% blend weight — VLR
  // mixes regions with different skill floors so signal is noisier.
  let vlrRankA = null, vlrRankB = null, vlrAdjust = 0;
  if (game === "valorant" && teamAName && teamBName) {
    try {
      const [aRank, bRank, delta] = await Promise.all([
        getVlrRank(teamAName),
        getVlrRank(teamBName),
        getVlrRankDelta(teamAName, teamBName),
      ]);
      vlrRankA = aRank;
      vlrRankB = bRank;
      vlrAdjust = vlrRankDeltaToProbAdjust(delta);
      prob = blendRankSignal(prob, vlrAdjust, 12, 0.30);
    } catch (e) {
      // VLR unavailable — skip
    }
  }

  // BO format adjustment — game-specific volatility
  const bo = format || 1;
  const gt = game ? GAME_TUNING[game] : null;
  const bo1Pull = gt ? gt.bo1Penalty : 0.25;  // How much to pull BO1 toward 50%
  if (bo === 1) prob = prob * (1 - bo1Pull) + 50 * bo1Pull;
  else if (bo >= 5) prob = 50 + (prob - 50) * 1.08;

  prob = Math.max(5, Math.min(95, prob));

  // Confidence: downgrade if either team is rusty
  const maxRust = Math.max(rustA, rustB);
  let confidence = Math.min(rA.length, rB.length) >= 8 ? "high" : Math.min(rA.length, rB.length) >= 4 ? "medium" : "low";
  if (maxRust > 0.05 && confidence === "high") confidence = "medium";  // Rusty team = less certain

  let thesis = buildThesis(
    rA, rB, formA, formB, strengthA, strengthB, allA, allB,
    h2h, streakA, streakB, bo, prob,
    teamAId, teamBId, domA, domB, clutchA, clutchB, trajA, trajB, rustA, rustB
  );

  // Append OpenDota context if available (Dota 2 only)
  if (odRatingA && odRatingB) {
    const ratingGap = odRatingA.rating - odRatingB.rating;
    const whoLead = ratingGap > 0 ? teamAName : teamBName;
    thesis += ` OpenDota rating: ${teamAName} ${odRatingA.rating} vs ${teamBName} ${odRatingB.rating} (${Math.abs(ratingGap)}-pt edge to ${whoLead}).`;
  }

  // Append VLR context if available (Valorant only)
  if (vlrRankA && vlrRankB) {
    thesis += ` VLR.gg: ${teamAName} #${vlrRankA.rank} (${vlrRankA.points} pts) vs ${teamBName} #${vlrRankB.rank} (${vlrRankB.points} pts).`;
  } else if (vlrRankA && !vlrRankB) {
    thesis += ` VLR.gg: ${teamAName} ranked #${vlrRankA.rank}, ${teamBName} unranked.`;
  } else if (!vlrRankA && vlrRankB) {
    thesis += ` VLR.gg: ${teamBName} ranked #${vlrRankB.rank}, ${teamAName} unranked.`;
  }

  // Append LoL patch context (LoL only)
  if (lolPatch && patchBreakdownA && patchBreakdownB) {
    thesis += ` Patch ${lolPatch.minor}: ${teamAName} ${patchBreakdownA.currentPatchWins}-${patchBreakdownA.currentPatchGames - patchBreakdownA.currentPatchWins} vs ${teamBName} ${patchBreakdownB.currentPatchWins}-${patchBreakdownB.currentPatchGames - patchBreakdownB.currentPatchWins}.`;
  }

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
    hltvRankA, hltvRankB, hltvAdjust,
    odRatingA, odRatingB, odAdjust,
    vlrRankA, vlrRankB, vlrAdjust,
    lolPatch, patchBreakdownA, patchBreakdownB,
  };
}

// ─── Thesis Generator — plain English reasoning for each bet ────────────────

function buildThesis(rA, rB, formA, formB, strA, strB, allA, allB, h2h, streakA, streakB, bo, prob, teamAId, teamBId, domA = 0, domB = 0, clutchA = 0, clutchB = 0, trajA = 0, trajB = 0, rustA = 0, rustB = 0) {
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

  // Rustiness
  if (rustA > 0.05) parts.push(`Team A hasn't played in ${rA[0]?.daysAgo?.toFixed(0) || "14+"}d — rust factor`);
  if (rustB > 0.05) parts.push(`Team B hasn't played in ${rB[0]?.daysAgo?.toFixed(0) || "14+"}d — rust factor`);

  // Format
  if (bo === 1) parts.push("BO1 increases upset risk significantly");
  else if (bo >= 3) parts.push(`BO${bo} favors the better team`);

  return parts.join(". ") + ".";
}

// ─── Drawdown Detection ────────────────────────────────────────────────────

function getDrawdownState(state) {
  const deployed = (state.openPositions || []).reduce((s, p) => s + p.betSize, 0);
  const totalBankroll = state.bankroll + deployed; // cash + money in open bets
  const bankrollPct = (totalBankroll / state.initialBankroll) * 100;
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

// ─── Daily Reset (EST) ──────────────────────────────────────────────────────
// Returns a YYYY-MM-DD string for a Date, interpreted in America/New_York.
// Handles DST automatically. Used to bucket closedPositions into "today" vs
// "yesterday" with midnight EST as the reset point.
function estDayKey(date) {
  // en-CA gives YYYY-MM-DD ordering natively
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

// Summary stats for all bets resolved on the current EST day.
function getTodayStats(closedPositions, now = new Date()) {
  const today = estDayKey(now);
  const todays = (closedPositions || []).filter(p => {
    const when = p.resolvedAt || p.placedAt;
    return when && estDayKey(new Date(when)) === today;
  });
  const wins = todays.filter(p => p.result === "win").length;
  const losses = todays.filter(p => p.result === "loss").length;
  const pnl = todays.reduce((s, p) => s + (p.pnl || 0), 0);
  return { wins, losses, pnl, count: todays.length, date: today };
}

// ─── Loss Diagnostic ───────────────────────────────────────────────────────
// Generates a human-readable explanation of WHY a bet lost. Uses the full
// data we have on the position — ourProb, rawProb (pre-calibration),
// marketProb (Polymarket), pinnacleProb (sharp book), edge, format,
// confidence — to pick the most informative story, not a tautology.
//
// Priority order: sharpest signal first. Pinnacle disagreement > calibration
// overreach > format variance > thin-edge > expected variance.
function diagnoseLoss(pos) {
  const ourProb = Number(pos.ourProb) || 50;
  const marketProb = Number(pos.marketProb) || 50;
  const pinnacleProb = pos.pinnacleProb != null ? Number(pos.pinnacleProb) : null;
  const edge = Number(pos.edge) || 0;
  const rawProb = pos.rawProb != null ? Number(pos.rawProb) : null;
  const format = pos.format;
  const confidence = pos.confidence;
  const lossOdds = 100 - ourProb; // implied % this bet would lose

  // 1. Sharp book strongly disagreed — Pinnacle is the smartest money.
  //    If Pinnacle had us as an underdog OR materially below our prob, the
  //    sharp book saw something we missed. Most actionable signal.
  if (pinnacleProb != null) {
    if (pinnacleProb < 50) {
      return `Sharp fade: Pinnacle had this pick at ${pinnacleProb}% (underdog) — sharp book disagreed with us, we should have listened`;
    }
    if (pinnacleProb < ourProb - 8) {
      return `Overrated by model: Pinnacle ${pinnacleProb}% vs our ${ourProb}% — sharp book saw it much closer than we did`;
    }
  }

  // 2. Calibration didn't temper a hot model — raw prediction was extreme
  //    and we didn't have enough historical calibration data to shrink it.
  if (rawProb != null && rawProb >= 78 && Math.abs(rawProb - ourProb) < 3) {
    return `Untempered model: raw prediction was ${rawProb}% — calibration data too sparse to shrink it to a realistic number`;
  }

  // 3. BO1 is a coinflip format no matter how strong the favorite.
  if (format === 1) {
    return `BO1 variance: single-map format — even a ${ourProb}% favorite loses ~${Math.round(lossOdds)}% of the time here`;
  }

  // 4. Genuinely close match — we shouldn't have placed this bet.
  if (edge < 5 && ourProb < 65) {
    return `Should have passed: only ${edge.toFixed(1)}% edge on a ${ourProb}% pick — too close to bet`;
  }

  // 5. Thin data going in.
  if (confidence === "low") {
    return `Thin history: confidence was "low" at bet time — not enough recent matches to trust the model`;
  }

  // 6. High-conviction loss is just the math. 80% means 1-in-5 loses.
  if (ourProb >= 75) {
    const frac = Math.max(2, Math.round(100 / lossOdds));
    return `Variance loss: ${ourProb}% pick still loses 1-in-${frac}; the math always catches up eventually`;
  }
  if (ourProb >= 65) {
    return `Expected variance: ${ourProb}% pick carries a ${Math.round(lossOdds)}% base loss rate — this was in that band`;
  }

  // 7. Marginal fav where market was closer to right than we were.
  return `Marginal call: we had ${ourProb}%, market had ${marketProb}% — market was closer to reality`;
}

// ─── Bet Sizing ─────────────────────────────────────────────────────────────

// Shrink a model probability toward empirical win rate in its calibration bin.
// Fixes "model overestimated" loss mode: if 70-75% bin has historically only
// hit 58%, pull our prob down toward 58% before computing edge.
//
// Tuning: a 70% cap with a 5-sample floor left too much miscalibrated prob
// through in early bins. We now start shrinking at 3 samples and cap the
// shrinkage at 85%, so once a bin has ~20 resolved bets the empirical
// number dominates. This is intentional — if our model has been wrong 20
// times in a row in a bin, the next prediction in that bin should mostly
// reflect the empirical rate, not the model's stated confidence.
function calibrateProb(modelProb, calibration) {
  if (!calibration || !calibration.bins) return modelProb;
  const lo = Math.floor(modelProb / 5) * 5;
  const binKey = `${lo}-${lo + 5}`;
  const bin = calibration.bins[binKey];
  if (!bin || bin.total < 3) return modelProb; // not enough samples — trust model
  const empirical = (bin.wins / bin.total) * 100;
  const w = Math.min(0.85, bin.total / 25); // sample-size weight, capped
  return +(modelProb * (1 - w) + empirical * w).toFixed(1);
}

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

// League-level blacklist — which leagues are we losing in repeatedly?
// Returns a Set of league names to skip entirely.
function getBlacklistedLeagues(state) {
  const closed = state.closedPositions || [];
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  const recent = closed.filter(p => (p.resolvedAt || p.placedAt) > fourteenDaysAgo);

  const byLeague = {};
  recent.forEach(p => {
    const lg = p.league || "";
    if (!lg) return;
    if (!byLeague[lg]) byLeague[lg] = { w: 0, l: 0 };
    if (p.result === "win") byLeague[lg].w++;
    else byLeague[lg].l++;
  });

  const blacklist = new Set();
  Object.entries(byLeague).forEach(([lg, d]) => {
    const total = d.w + d.l;
    // Blacklist if 8+ trades AND win rate below 35%.
    // Previously (3 trades, <25%) fired on pure variance — a 1-3 run in a
    // profitable league was killing future entries. Requiring 8+ trades and
    // 35% floor means we only cut leagues that are genuinely unprofitable.
    if (total >= 8 && d.w / total < 0.35) {
      blacklist.add(lg);
    }
  });
  return blacklist;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BOT RUN
// ═══════════════════════════════════════════════════════════════════════════════

// In-process mutex — guards against HTTP /run + Telegram /run + startup all
// calling runBot() concurrently within the service process.
let _runInFlight = false;

async function runBot() {
  const log = [];
  const push = (msg) => { log.push(msg); console.log(msg); appendLog(msg); };

  // In-process guard
  if (_runInFlight) {
    console.log("⏭️  Bot run already in progress (in-process), skipping.");
    return { ok: true, log: ["Run already in progress — skipped."], skipped: true };
  }
  // Cross-process guard (service vs cron)
  if (!acquireRunLock()) {
    console.log("⏭️  Bot run locked by another process, skipping.");
    return { ok: true, log: ["Run locked by another process — skipped."], skipped: true };
  }
  _runInFlight = true;

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

    // Resolve matches started 30+ min ago, BUT for live/fade bets wait longer
    // (BO3 matches take 60-90 min, we don't want to resolve before they finish)
    const toResolve = state.openPositions.filter(p => {
      const matchStart = new Date(p.matchTime);
      const resolveDelayMin = (p.betType === "fade" || p.isLive) ? 90 : 30;
      return matchStart < new Date(now - resolveDelayMin * 60000);
    });
    const stillOpen = [];
    let resolvedCount = 0;
    const resolvedForTG = []; // collect all resolutions for a single summary TG

    // Build a set of already-resolved position IDs for O(1) idempotency check.
    // Defends against a race where two processes both see the position as open
    // and both try to resolve it. The second will skip.
    const resolvedIds = new Set(state.closedPositions.map(p => p.id));
    // Also track matchIds ever resolved — if a stale open position's matchId
    // is in here but its ID isn't (e.g. old broken state with divergent IDs),
    // we still know the match resolved and should drop it. Fixes bots stuck
    // in a bad state from earlier concurrency bugs.
    const resolvedMatchIds = new Set(state.closedPositions.map(p => p.matchId).filter(Boolean));

    for (const pos of state.openPositions) {
      if (!toResolve.includes(pos)) { stillOpen.push(pos); continue; }

      // Idempotency: if this position was already resolved (e.g. in a
      // concurrent run that saved first), drop it silently — no duplicate
      // Telegram, no double P&L accounting.
      if (resolvedIds.has(pos.id)) {
        push(`⏭️  ${pos.pick} (${pos.event}) already resolved — skipping duplicate.`);
        continue;
      }
      // Matchup-level idempotency: if this match already has a resolved
      // position (possibly under a different ID from an earlier buggy run),
      // drop without resolving. Prevents the "stuck in a loop" pattern where
      // an old concurrency bug left positions in openPositions that keep
      // re-resolving on every run.
      if (pos.matchId && resolvedMatchIds.has(pos.matchId)) {
        push(`⏭️  ${pos.pick} (${pos.event}) match already resolved under another ID — purging.`);
        continue;
      }

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

        // Loss analysis — figure out WHY we lost. Uses all 3 probability
        // sources (model, Polymarket, Pinnacle) + calibration data to tell a
        // real story instead of tautologies like "model was wrong."
        const lossReason = won ? null : diagnoseLoss(pos);

        // ─── CLV (Closing Line Value) ────────────────────────────────────
        // The closing line is the market's best estimate of true probability
        // (it has all information up to match start). Positive CLV = we got
        // a better price than the market settled on → our picks are on the
        // right side of market moves, regardless of the match result. This
        // is the single best leading indicator of long-run profitability,
        // since actual W/L is dominated by variance over small samples.
        //
        // We use `lastProbA/lastProbB` from prematchPrices — the most recent
        // pre-match observation, i.e. the closest we have to the true close.
        // CLV is measured on OUR side: positive = we bought at a discount.
        let closingMarketProb = null;
        let clv = null;
        const prematch = state.prematchPrices?.[pos.matchId];
        if (prematch && prematch.lastProbA != null && prematch.lastProbB != null) {
          closingMarketProb = pos.pickSide === "A" ? prematch.lastProbA : prematch.lastProbB;
          clv = +(closingMarketProb - pos.marketProb).toFixed(2);
        }

        // ─── Brier-score contribution ────────────────────────────────────
        // Per-bet squared error between our stated probability and the
        // actual outcome (0 or 1). Lower is better; 0.25 is a coin flip.
        // Stored so we can average daily/per-game and track model skill
        // independent of P&L variance.
        const brier = +Math.pow(pos.ourProb / 100 - (won ? 1 : 0), 2).toFixed(4);

        const closed = {
          ...pos, result, pnl: +pnl.toFixed(2), resolvedAt: now.toISOString(),
          lossReason: won ? null : lossReason,
          closingMarketProb,
          clv,
          brier,
        };
        state.closedPositions.unshift(closed);
        resolvedCount++;

        // Aggregate Brier into a per-game / per-day log so we can see if the
        // model is actually getting sharper over time (vs. getting lucky).
        if (!state.brierLog) state.brierLog = {};
        const dayKey = estDayKey(now);
        const gameKey = pos.game || "unknown";
        if (!state.brierLog[dayKey]) state.brierLog[dayKey] = {};
        if (!state.brierLog[dayKey][gameKey]) {
          state.brierLog[dayKey][gameKey] = { n: 0, sum: 0 };
        }
        state.brierLog[dayKey][gameKey].n += 1;
        state.brierLog[dayKey][gameKey].sum += brier;

        const bin = `${Math.floor(pos.ourProb / 5) * 5}-${Math.floor(pos.ourProb / 5) * 5 + 5}`;
        if (!state.calibration.bins[bin]) state.calibration.bins[bin] = { total: 0, wins: 0 };
        state.calibration.bins[bin].total++;
        if (won) state.calibration.bins[bin].wins++;
        state.calibration.totalPredictions++;
        if (won) state.calibration.correctPredictions++;

        const emoji = won ? "✅" : "❌";
        push(`${emoji} Resolved: ${pos.pick} (${pos.event}) → ${result} | P&L: $${pnl.toFixed(2)}${lossReason ? ` | ${lossReason}` : ""}`);
        // Collect for a single summary Telegram at end of run (avoids spam
        // when multiple matches finish in the same scan window).
        resolvedForTG.push({ emoji, pos, result, pnl, lossReason });
      } else {
        stillOpen.push(pos);
      }
    }
    state.openPositions = stillOpen;

    // CRITICAL: persist resolution state IMMEDIATELY. If any later step in
    // runBot throws (bet-finding, Polymarket, Pinnacle, etc.), we do NOT want
    // to replay resolutions on the next run — that's what was causing the
    // "same 5 bets resolved every 5 minutes" spam. Resolution is the point
    // of no return: once sent, save it and never look back.
    if (resolvedForTG.length > 0) {
      saveState(state);
    }

    // Send ONE summary Telegram for all resolutions this run. Much better UX
    // than spamming N messages when a BO3 tournament day has 5 matches finish
    // at once, and dramatically limits the damage if a concurrency bug ever
    // slips past the locks (one dupe summary instead of N dupe messages).
    if (resolvedForTG.length > 0) {
      const wins = resolvedForTG.filter(r => r.result === "win").length;
      const losses = resolvedForTG.length - wins;
      const totalPnl = resolvedForTG.reduce((s, r) => s + r.pnl, 0);
      const headerEmoji = totalPnl >= 0 ? "📈" : "📉";
      const pnlSign = totalPnl >= 0 ? "+" : "";

      // Day-to-date tally (resets midnight EST). Covers this run's bets
      // since they're already in closedPositions after saveState above.
      const today = getTodayStats(state.closedPositions, now);
      const todaySign = today.pnl >= 0 ? "+" : "";

      let msg = `${headerEmoji} <b>${resolvedForTG.length} BET${resolvedForTG.length === 1 ? "" : "S"} RESOLVED</b> — ${wins}W/${losses}L · ${pnlSign}$${totalPnl.toFixed(2)}\n`;
      msg += `📅 <b>Today (EST)</b>: ${today.wins}W/${today.losses}L · ${todaySign}$${today.pnl.toFixed(2)}\n`;
      msg += `💰 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n`;
      for (const r of resolvedForTG) {
        const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(2)}` : `-$${Math.abs(r.pnl).toFixed(2)}`;
        msg += `\n${r.emoji} <b>${r.pos.pick}</b> (${r.pos.event}) ${pnlStr}`;
        if (r.lossReason) msg += `\n   <i>${r.lossReason}</i>`;
      }
      await sendTG(msg);
    }

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
      const [csgo, dota2, lol, valorant, r6siege, polyMarkets, pinData] = await Promise.all([
        pandaFetch("csgo/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("dota2/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("lol/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("valorant/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("r6siege/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        fetchAllPolymarketEsports(),
        fetchPinnacleAllEsports().catch(() => ({ matchups: [], odds: new Map() })),
      ]);

      const allMatches = [
        ...csgo.map(m => ({ ...m, _game: "csgo" })),
        ...dota2.map(m => ({ ...m, _game: "dota2" })),
        ...lol.map(m => ({ ...m, _game: "lol" })),
        ...valorant.map(m => ({ ...m, _game: "valorant" })),
        ...r6siege.map(m => ({ ...m, _game: "r6siege" })),
      ];

      push(`📊 Found ${allMatches.length} upcoming matches, ${polyMarkets.length} Polymarket moneyline markets, ${pinData.odds?.size || 0} Pinnacle matchups`);

      // Compute league blacklist — leagues where we've been losing recently
      const blacklistedLeagues = getBlacklistedLeagues(state);
      if (blacklistedLeagues.size > 0) {
        push(`🚫 Blacklisted leagues: ${[...blacklistedLeagues].join(", ")}`);
      }

      const opportunities = [];
      const rejections = {
        outOfWindow: 0,
        alreadyBetting: 0,
        noPolyOdds: 0,
        lowLiquidity: 0,
        staleMarket: 0,
        coinFlip: 0,
        blacklisted: 0,
      };

      for (const m of allMatches) {
        const t1 = m.opponents?.[0]?.opponent;
        const t2 = m.opponents?.[1]?.opponent;
        if (!t1 || !t2) continue;

        const matchTime = new Date(m.scheduled_at);
        const hoursUntil = (matchTime - now) / 3600000;
        if (hoursUntil < BET_WINDOW_MIN_H || hoursUntil > BET_WINDOW_MAX_H) {
          rejections.outOfWindow++;
          continue;
        }
        if (state.openPositions.some(p => p.matchId === m.id)) {
          rejections.alreadyBetting++;
          continue;
        }

        const polyOdds = matchPolymarket(polyMarkets, t1.name, t2.name) ||
                         matchPolymarket(polyMarkets, t1.acronym || t1.name, t2.acronym || t2.name);
        if (!polyOdds) {
          rejections.noPolyOdds++;
          continue;
        }

        // Pinnacle odds (sharp book) — optional third data point. We don't
        // reject matches that lack Pinnacle coverage; it's a signal enhancer,
        // not a gate. When present, it's stored on the opportunity and flows
        // through to the position for display and analysis.
        const pinOdds = matchPinnacle(pinData, t1.name, t2.name) ||
                        matchPinnacle(pinData, t1.acronym || t1.name, t2.acronym || t2.name);

        // ─── Pre-match price capture ───────────────────────────────────
        // Two purposes, two different aggregations:
        //   1. probA / probB: the FIRST/HIGHEST price we observed — that's
        //      the pre-match peak, used by the FADE strategy to detect
        //      significant drops during live play.
        //   2. lastProbA / lastProbB / lastSeenAt: the MOST RECENT price
        //      observed before the match goes live — that's our best
        //      approximation of the closing line, used later for CLV
        //      (closing line value) analysis on resolved bets.
        const hoursUntilMatch = (matchTime - now) / 3600000;
        if (hoursUntilMatch > 0) {
          if (!state.prematchPrices) state.prematchPrices = {};
          const existing = state.prematchPrices[m.id];
          const maxProb = Math.max(polyOdds.probA, polyOdds.probB);
          const prevMaxProb = existing ? Math.max(existing.probA, existing.probB) : -1;

          state.prematchPrices[m.id] = {
            // Peak (preserve if we've already seen a higher print)
            probA: !existing || maxProb > prevMaxProb ? polyOdds.probA : existing.probA,
            probB: !existing || maxProb > prevMaxProb ? polyOdds.probB : existing.probB,
            capturedAt: existing?.capturedAt || now.toISOString(),
            // Latest observation — overwritten every run so the final value
            // before `hoursUntilMatch` goes negative is the "closing" line.
            lastProbA: polyOdds.probA,
            lastProbB: polyOdds.probB,
            lastSeenAt: now.toISOString(),
            teamA: t1.name,
            teamB: t2.name,
          };
        }

        // FILTER: Skip low-liquidity markets — prices are meaningless without real money behind them
        if (polyOdds.liquidity < MIN_LIQUIDITY) {
          rejections.lowLiquidity++;
          continue;
        }

        // FILTER: Skip stale markets. Polymarket moves fast around news and
        // match start. A 3h-old price is often post-news and pre-resolution
        // stale. Tighter cutoff: 1.5h for pre-match, 0.5h for live (live prices
        // should be updating constantly, anything older is broken liquidity).
        const staleCutoffH = hoursUntilMatch <= 0 ? 0.5 : 1.5;
        if (polyOdds.hoursSinceUpdate !== null && polyOdds.hoursSinceUpdate > staleCutoffH) {
          rejections.staleMarket++;
          continue;
        }

        // FILTER: Skip coin-flip markets — need real price discovery signal
        const maxProb = Math.max(polyOdds.probA, polyOdds.probB);
        if (maxProb < PRICE_DISCOVERY_MIN) {
          rejections.coinFlip++;
          continue;
        }

        // FILTER: Skip blacklisted leagues — places we've been losing
        const leagueName = m.league?.name || "";
        if (leagueName && blacklistedLeagues.has(leagueName)) {
          rejections.blacklisted++;
          continue;
        }

        opportunities.push({ match: m, t1, t2, polyOdds, pinOdds });
      }

      // Sort opportunities by time (soonest first) so we prioritize imminent action
      opportunities.sort((a, b) => new Date(a.match.scheduled_at) - new Date(b.match.scheduled_at));

      // Detailed breakdown of why matches were rejected
      push(`🎯 ${opportunities.length} quality matches`);
      push(`   Rejections: ${rejections.outOfWindow} out-of-window · ${rejections.noPolyOdds} no-polymarket · ${rejections.lowLiquidity} low-liq · ${rejections.staleMarket} stale · ${rejections.coinFlip} coin-flip · ${rejections.blacklisted} blacklisted · ${rejections.alreadyBetting} already-open`);

      // Analyze ALL matched opportunities — needed for both edge + confirmation bets
      const analyzed = [];
      const allPredictions = [];  // Store all predictions for confirmation bet scan
      const edgeRejects = {
        circuitBroken: 0,
        lowModelProb: 0,
        lowEdge: 0,
        lowConfidence: 0,
        underdog: 0,
      };

      for (const opp of opportunities) {
        try {
          const [histA, histB] = await Promise.all([
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t1.id}&per_page=25&sort=-scheduled_at`),
            pandaFetch(`${opp.match._game}/matches/past?filter[opponent_id]=${opp.t2.id}&per_page=25&sort=-scheduled_at`),
          ]);

          const pred = await computePrediction(opp.t1.id, opp.t2.id, histA, histB, opp.match.number_of_games, state.modelWeights, opp.match._game, opp.t1.name, opp.t2.name);

          // Check for recent roster changes (Liquipedia) — skip if either team
          // changed a player in the last 7 days (stand-ins wreck historical form)
          const rosterCheck = await checkMatchRosters(opp.t1.name, opp.t2.name, opp.match._game);
          if (rosterCheck.skip) {
            push(`⚠️ Skipping ${opp.t1.name} vs ${opp.t2.name}: ${rosterCheck.reason}`);
            continue;
          }

          const pickSide = pred.probA >= pred.probB ? "A" : "B";
          const rawProb = pickSide === "A" ? pred.probA : pred.probB;
          const ourProb = calibrateProb(rawProb, state.calibration);
          const marketProb = pickSide === "A" ? opp.polyOdds.probA : opp.polyOdds.probB;
          const pinnacleProb = opp.pinOdds ? (pickSide === "A" ? opp.pinOdds.probA : opp.pinOdds.probB) : null;
          // Use Pinnacle devigged price as the baseline when available — it's the
          // sharpest signal of true probability. Polymarket has ~2-3% vig baked
          // in so every edge computed against it is inflated. Fall back to
          // Polymarket only when Pinnacle has no coverage for this matchup.
          const baseProb = pinnacleProb != null ? pinnacleProb : marketProb;
          const edge = ourProb - baseProb;

          allPredictions.push({ opp, pred, pickSide, ourProb, rawProb, marketProb, pinnacleProb, baseProb, edge });

          // Edge bet filters — only if circuit breaker is NOT active
          if (circuitBroken) { edgeRejects.circuitBroken++; continue; }
          if (ourProb < MIN_OUR_PROB) { edgeRejects.lowModelProb++; continue; }
          // Game-specific minimum edge. When betting against a sharp book
          // (Pinnacle), require an extra +1% buffer — sharp prices are already
          // close to true, so thinner edges there are usually noise.
          let gameMinEdge = GAME_TUNING[opp.match._game]?.minEdge || MIN_EDGE;
          if (pinnacleProb != null) gameMinEdge += MIN_EDGE_PINNACLE_BONUS;
          if (edge < gameMinEdge) { edgeRejects.lowEdge++; continue; }
          if (pred.confidence === "low" && ourProb < 60) { edgeRejects.lowConfidence++; continue; }

          // SANITY CHECK: absurd edges mean the market matcher found the WRONG market.
          // A legitimate moneyline never has >25% mispricing. Reject and log.
          if (edge > MAX_EDGE) {
            push(`⚠️ REJECTED ${opp.t1.name} vs ${opp.t2.name}: absurd edge +${edge.toFixed(1)}% (market matcher likely found wrong market: "${opp.polyOdds.question || "?"}")`);
            continue;
          }

          // UNDERDOG GUARD — never bet a team the market considers an underdog
          // unless our model has STRONG conviction (65%+).
          // 50% model conviction on a 30% market dog is NOT an edge, it's a coin flip.
          if (marketProb < 45 && ourProb < 65) { edgeRejects.underdog++; continue; }
          // Market-disagrees-hard guard — if market thinks <40%, require near-certainty
          if (marketProb < 40 && ourProb < 70) continue;

          analyzed.push({ opp, pred, pickSide, ourProb, rawProb, marketProb, pinnacleProb, edge });
        } catch (e) {
          push(`⚠️ Error analyzing ${opp.t1.name} vs ${opp.t2.name}: ${e.message}`);
        }
      }

      // Show edge bet rejection breakdown so we can see why nothing passes
      const totalEdgeRejects = Object.values(edgeRejects).reduce((a, b) => a + b, 0);
      if (totalEdgeRejects > 0) {
        push(`   Edge rejects: ${edgeRejects.circuitBroken} breaker · ${edgeRejects.lowModelProb} low-prob · ${edgeRejects.lowEdge} low-edge · ${edgeRejects.lowConfidence} low-conf · ${edgeRejects.underdog} underdog`);
      }

      // RANK by composite score: edge + time-proximity bonus
      // Matches within the priority window (3h) get a boost so we prefer imminent action
      const scoreOpp = (x) => {
        const hoursUntil = (new Date(x.opp.match.scheduled_at) - now) / 3600000;
        // Time bonus: 2 points if within 1h, 1 point if 1-3h, 0 if 3h+
        const timeBonus = hoursUntil <= 1 ? 2 : hoursUntil <= PRIORITY_WINDOW_H ? 1 : 0;
        return x.edge + timeBonus;
      };
      analyzed.sort((a, b) => scoreOpp(b) - scoreOpp(a));

      if (analyzed.length > 0) {
        push(`🏆 ${analyzed.length} opportunities pass filters — ranked by edge+time:`);
        for (let i = 0; i < Math.min(analyzed.length, 5); i++) {
          const a = analyzed[i];
          const pick = a.pickSide === "A" ? (a.opp.t1.acronym || a.opp.t1.name) : (a.opp.t2.acronym || a.opp.t2.name);
          const hoursUntil = ((new Date(a.opp.match.scheduled_at) - now) / 3600000).toFixed(1);
          push(`   ${i + 1}. ${pick} (${a.opp.t1.acronym || a.opp.t1.name} vs ${a.opp.t2.acronym || a.opp.t2.name}) — Edge: +${a.edge.toFixed(1)}% | Model: ${a.ourProb.toFixed(1)}% | Market: ${a.marketProb.toFixed(1)}% | In ${hoursUntil}h | Liq: $${a.opp.polyOdds.liquidity.toFixed(0)}`);
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
          ourProb: +Number(a.ourProb || 0).toFixed(1),
          rawProb: a.rawProb != null ? +Number(a.rawProb).toFixed(1) : null,
          marketProb: +Number(a.marketProb || 0).toFixed(1),
          pinnacleProb: a.pinnacleProb != null ? +Number(a.pinnacleProb).toFixed(1) : null,
          baseProb: a.baseProb != null ? +Number(a.baseProb).toFixed(1) : null,
          edge: +Number(a.edge || 0).toFixed(1),
          betSize,
          betPercent: +(betSize / state.bankroll * 100).toFixed(1),
          confidence: a.pred.confidence,
          betType: "edge",  // Explicit tag — segmenting against confirm/fade in /summary
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

        const calibNote = position.rawProb && Math.abs(position.rawProb - position.ourProb) >= 1 ? ` (raw ${position.rawProb}% → cal ${position.ourProb}%)` : "";
        const pinNote = position.pinnacleProb != null ? ` | Pinnacle: ${position.pinnacleProb}%` : "";
        push(`💰 BET PLACED: ${pick} in ${position.event} | Model: ${position.ourProb}%${calibNote} | Market: ${position.marketProb}%${pinNote} | Edge: +${position.edge}% | Size: $${betSize} | Liq: $${position.polyLiquidity.toFixed(0)}`);

        const polyLink = position.polyUrl ? `\n🔗 <a href="${position.polyUrl}">View on Polymarket</a>` : "";

        const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const polyQuestion = a.opp.polyOdds.question ? `\n🔖 <i>${escHtml(a.opp.polyOdds.question)}</i>\n` : "";
        await sendTG(
          `💰 <b>NEW PAPER BET</b>\n\n` +
          `🎮 ${a.opp.match._game.toUpperCase()}\n` +
          `📋 ${position.event}\n` +
          `🏆 ${position.league} · BO${position.format}` +
          polyQuestion + `\n` +
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
        const confirmRejects = {
          alreadyPositioned: 0,
          lowLiq: 0,
          dupEdgeBet: 0,
          modelDisagrees: 0,  // our model is picking the OTHER team
          belowMarketThreshold: 0,  // market prob < 65%
          insufficientSize: 0,
        };

        // Sort confirmation candidates by time (soonest first) so we prioritize
        // imminent action. allPredictions was already ordered by time from
        // opportunities.sort() above, but do it explicitly here to be safe.
        const confirmCandidates = [...allPredictions].sort(
          (a, b) => new Date(a.opp.match.scheduled_at) - new Date(b.opp.match.scheduled_at)
        );

        // Use allPredictions (already computed above) — no extra API calls needed
        for (const ap of confirmCandidates) {
          if (confirmBets >= CONFIRM_MAX_PER_RUN) break;
          if (state.openPositions.length >= MAX_POSITIONS) break;
          if (state.openPositions.some(p => p.matchId === ap.opp.match.id)) { confirmRejects.alreadyPositioned++; continue; }
          if ((ap.opp.polyOdds.liquidity || 0) < CONFIRM_MIN_LIQUIDITY) { confirmRejects.lowLiq++; continue; }

          // Already placed an edge bet on this match?
          if (betsPlaced.some(b => b.matchId === ap.opp.match.id)) { confirmRejects.dupEdgeBet++; continue; }

          // Detect if this is a LIVE bet (match has already started)
          const hoursUntilMatch = (new Date(ap.opp.match.scheduled_at) - now) / 3600000;
          const isLive = hoursUntilMatch < LIVE_ONLY_THRESHOLD_H;

          // For confirmation bets, we need to pick the MARKET favorite, not our model's pick.
          // The thesis is "ride the market consensus" — so we bet whichever side the market favors.
          const marketFavSide = ap.opp.polyOdds.probA >= ap.opp.polyOdds.probB ? "A" : "B";
          const marketFavProb = marketFavSide === "A" ? ap.opp.polyOdds.probA : ap.opp.polyOdds.probB;
          const rawProbForFav = marketFavSide === "A" ? ap.pred.probA : ap.pred.probB;
          const ourProbForFav = calibrateProb(rawProbForFav, state.calibration);

          // SANITY CHECK: if the two market probs don't roughly sum to 100%, the market
          // matcher found a weird prop market (like "will team win 2-0?"). Skip it.
          const sumProb = ap.opp.polyOdds.probA + ap.opp.polyOdds.probB;
          if (sumProb < 90 || sumProb > 110) {
            confirmRejects.belowMarketThreshold++;
            continue;
          }

          // Live bets have a higher threshold — need the market to still strongly favor
          // our pick EVEN AFTER the game has started. This filters out upset scenarios
          // where the favorite went down and odds shifted.
          const requiredMarketProb = isLive ? LIVE_MIN_MARKET_PROB : CONFIRM_MIN_MARKET_PROB;
          if (marketFavProb < requiredMarketProb) { confirmRejects.belowMarketThreshold++; continue; }

          // Our model must not STRONGLY disagree. We allow slight disagreement — we're
          // trusting the market here, not our own model. But if our model thinks it's a
          // coin flip or the other team's winning, skip it.
          if (ourProbForFav < 50) { confirmRejects.modelDisagrees++; continue; }

          // Tiered sizing — stronger consensus = bigger position.
          // Tier is determined by MARKET probability primarily (since we're riding the market).
          // Model threshold is relaxed — just "doesn't disagree".
          const tier = CONFIRM_TIERS.find(t => marketFavProb >= t.minMarket) || CONFIRM_TIERS[CONFIRM_TIERS.length - 1];
          // Live bets get half-size due to higher variance
          const sizeMultiplier = isLive ? LIVE_SIZE_MULTIPLIER : 1.0;
          const confirmSize = Math.max(MIN_BET, Math.round(state.bankroll * tier.pct / 100 * sizeMultiplier));
          const currentDeployed = state.openPositions.reduce((s, p) => s + p.betSize, 0);
          if (confirmSize > state.bankroll - currentDeployed) { confirmRejects.insufficientSize++; continue; }

          const opp = ap.opp;
          const pickSide = marketFavSide;
          const ourProb = ourProbForFav;
          const marketProb = marketFavProb;
          const pinnacleProb = opp.pinOdds ? (pickSide === "A" ? opp.pinOdds.probA : opp.pinOdds.probB) : null;
          const baseProb = pinnacleProb != null ? pinnacleProb : marketProb;
          const pick = pickSide === "A" ? (opp.t1.acronym || opp.t1.name) : (opp.t2.acronym || opp.t2.name);
          const edge = ourProb - baseProb;

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
            pinnacleProb: pinnacleProb != null ? +pinnacleProb.toFixed(1) : null,
            baseProb: +baseProb.toFixed(1),
            edge: +edge.toFixed(1),
            betSize: confirmSize,
            betPercent: +(confirmSize / state.bankroll * 100).toFixed(1),
            confidence: ap.pred.confidence,
            betType: "confirmation",  // Tag it so we can track performance separately
            confirmTier: tier.label,
            isLive,
            event: `${opp.t1.acronym || opp.t1.name} vs ${opp.t2.acronym || opp.t2.name}`,
            league: opp.match.league?.name || "",
            format: opp.match.number_of_games || 1,
            placedAt: now.toISOString(),
            matchTime: opp.match.scheduled_at,
            formA: ap.pred.recordA,
            formB: ap.pred.recordB,
            thesis: `CONFIRMATION BET: Model (${ourProb.toFixed(0)}%) and market (${marketProb.toFixed(0)}%) both agree — heavy favorite. ${ap.pred.thesis || ""}`,
            polyUrl: opp.polyOdds.polyUrl || null,
            polyLiquidity: opp.polyOdds.liquidity,
            matchStatus: "upcoming",
          };

          state.openPositions.push(position);
          state.bankroll -= confirmSize;
          confirmBets++;

          push(`🎯 CONFIRM [${tier.label}${isLive ? " LIVE" : ""}]: ${pick} in ${position.event} | Model: ${ourProb.toFixed(1)}% | Market: ${marketProb.toFixed(1)}% | Size: $${confirmSize}`);

          const polyLink = position.polyUrl ? `\n🔗 <a href="${position.polyUrl}">View on Polymarket</a>` : "";
          const liveTag = isLive ? " 🔴 LIVE" : "";
          const liveNote = isLive ? `\n<i>Live bet — match in progress, half sizing applied</i>\n` : "";
          const escHtml = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const polyQuestion = opp.polyOdds.question ? `\n🔖 <i>${escHtml(opp.polyOdds.question)}</i>\n` : "";
          await sendTG(
            `🎯 <b>CONFIRMATION BET [${tier.label}]${liveTag}</b>\n\n` +
            `🎮 ${opp.match._game.toUpperCase()}\n` +
            `📋 ${position.event}\n` +
            `🏆 ${position.league} · BO${position.format}` +
            polyQuestion + `\n` +
            `<b>Pick: ${pick} (heavy favorite)</b>\n` +
            `Our model: <b>${ourProb.toFixed(1)}%</b>\n` +
            `Market: <b>${marketProb.toFixed(1)}%</b>\n` +
            `Both agree — taking the chalk.${liveNote}\n` +
            `💵 Bet: <b>$${confirmSize}</b> (${tier.pct}% bankroll — ${tier.label}${isLive ? " × 0.5 live" : ""})\n` +
            `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>` +
            polyLink
          );
        }

        // Log confirmation bet rejections so we can see why nothing fires
        const totalConfRejects = Object.values(confirmRejects).reduce((a, b) => a + b, 0);
        if (totalConfRejects > 0) {
          push(`   Confirm rejects: ${confirmRejects.belowMarketThreshold} below-65% · ${confirmRejects.modelDisagrees} model-disagrees · ${confirmRejects.lowLiq} low-liq · ${confirmRejects.alreadyPositioned} already-open · ${confirmRejects.dupEdgeBet} dup-edge-bet · ${confirmRejects.insufficientSize} no-room`);
        }
        if (confirmBets === 0 && allPredictions.length > 0) {
          push(`   📭 No confirmation bets placed this run`);
        }
      }

      // ─── FADE Bets (Live, Discounted Former Favorites) ──────────────────
      // A team that was a heavy pre-match favorite but has dropped significantly
      // live (because they're losing early games in a BO3) is often underpriced.
      // Market overreacts. Take the former favorite at a discount.
      if (FADE_ENABLED && state.openPositions.length < MAX_POSITIONS) {
        let fadeBets = 0;
        for (const ap of allPredictions) {
          if (fadeBets >= FADE_MAX_PER_RUN) break;
          if (state.openPositions.length >= MAX_POSITIONS) break;

          const opp = ap.opp;
          const hoursUntilMatch = (new Date(opp.match.scheduled_at) - now) / 3600000;
          // Only live matches (started already, within our live window)
          if (hoursUntilMatch >= 0) continue;

          // Must have pre-match data to compare
          const prematch = state.prematchPrices?.[opp.match.id];
          if (!prematch) continue;

          // Skip if we already have a position on this match
          if (state.openPositions.some(p => p.matchId === opp.match.id)) continue;
          if (betsPlaced.some(b => b.matchId === opp.match.id)) continue;
          if ((opp.polyOdds.liquidity || 0) < FADE_MIN_LIQUIDITY) continue;

          // Find which side was the pre-match favorite
          const prematchFavSide = prematch.probA >= prematch.probB ? "A" : "B";
          const prematchFavProb = prematchFavSide === "A" ? prematch.probA : prematch.probB;
          const currentFavProb = prematchFavSide === "A" ? opp.polyOdds.probA : opp.polyOdds.probB;

          // Pre-match must have been a heavy favorite
          if (prematchFavProb < FADE_MIN_PREMATCH_PROB) continue;

          // Price must have dropped significantly
          const drop = prematchFavProb - currentFavProb;
          if (drop < FADE_MIN_DROP_PCT) continue;

          // Current price must be in the "discount" zone (not a total collapse)
          if (currentFavProb < FADE_MIN_CURRENT_PROB || currentFavProb > FADE_MAX_CURRENT_PROB) continue;

          // Place the fade bet — bet on the former favorite at the discounted price
          const fadeSize = Math.max(MIN_BET, Math.round(state.bankroll * FADE_BET_PCT / 100));
          const currentDeployed = state.openPositions.reduce((s, p) => s + p.betSize, 0);
          if (fadeSize > state.bankroll - currentDeployed) continue;

          const pick = prematchFavSide === "A" ? (opp.t1.acronym || opp.t1.name) : (opp.t2.acronym || opp.t2.name);
          const rawProb = prematchFavSide === "A" ? ap.pred.probA : ap.pred.probB;
          const ourProb = calibrateProb(rawProb, state.calibration);

          const position = {
            id: `fade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            matchId: opp.match.id,
            game: opp.match._game,
            teamA: opp.t1.acronym || opp.t1.name,
            teamB: opp.t2.acronym || opp.t2.name,
            teamAId: opp.t1.id,
            teamBId: opp.t2.id,
            pick, pickSide: prematchFavSide,
            ourProb: +ourProb.toFixed(1),
            marketProb: +currentFavProb.toFixed(1),
            pinnacleProb: opp.pinOdds ? +(prematchFavSide === "A" ? opp.pinOdds.probA : opp.pinOdds.probB).toFixed(1) : null,
            prematchProb: +prematchFavProb.toFixed(1),
            edge: +(prematchFavProb - currentFavProb).toFixed(1),
            betSize: fadeSize,
            betPercent: +(fadeSize / state.bankroll * 100).toFixed(1),
            confidence: ap.pred.confidence,
            betType: "fade",
            isLive: true,
            event: `${opp.t1.acronym || opp.t1.name} vs ${opp.t2.acronym || opp.t2.name}`,
            league: opp.match.league?.name || "",
            format: opp.match.number_of_games || 1,
            placedAt: now.toISOString(),
            matchTime: opp.match.scheduled_at,
            thesis: `FADE BET: ${pick} was ${prematchFavProb.toFixed(0)}% pre-match, now ${currentFavProb.toFixed(0)}% live. Market overreacting to early game loss — buying the former favorite at a ${drop.toFixed(0)}% discount.`,
            polyUrl: opp.polyOdds.polyUrl || null,
            polyLiquidity: opp.polyOdds.liquidity,
            matchStatus: "live",
          };

          state.openPositions.push(position);
          state.bankroll -= fadeSize;
          fadeBets++;

          push(`🔄 FADE: ${pick} in ${position.event} | Prematch: ${prematchFavProb.toFixed(0)}% → Live: ${currentFavProb.toFixed(0)}% (−${drop.toFixed(0)}%) | Size: $${fadeSize}`);

          const polyLink = position.polyUrl ? `\n🔗 <a href="${position.polyUrl}">View on Polymarket</a>` : "";
          await sendTG(
            `🔄 <b>FADE BET 🔴 LIVE</b>\n\n` +
            `🎮 ${opp.match._game.toUpperCase()}\n` +
            `📋 ${position.event}\n` +
            `🏆 ${position.league} · BO${position.format}\n\n` +
            `<b>Pick: ${pick}</b> (former favorite)\n` +
            `Pre-match: <b>${prematchFavProb.toFixed(0)}%</b>\n` +
            `Live now: <b>${currentFavProb.toFixed(0)}%</b>\n` +
            `Drop: <b>−${drop.toFixed(0)}%</b> — market overreacting\n\n` +
            `💵 Bet: <b>$${fadeSize}</b> (${FADE_BET_PCT}% bankroll)\n` +
            `🏦 Bankroll: <b>$${state.bankroll.toFixed(2)}</b>\n` +
            `📝 <i>${position.thesis}</i>` +
            polyLink
          );
        }
        if (fadeBets > 0) push(`🔄 Placed ${fadeBets} fade bet${fadeBets > 1 ? "s" : ""} on discounted former favorites`);
      }

      // Clean up stale pre-match price cache (keep only last 7 days)
      if (state.prematchPrices) {
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
        for (const id of Object.keys(state.prematchPrices)) {
          if (state.prematchPrices[id].capturedAt < cutoff) {
            delete state.prematchPrices[id];
          }
        }
      }

      // Prune Brier-score log beyond 90 days — long enough to see monthly
      // trends, short enough to keep state.json small.
      if (state.brierLog) {
        const brierCutoff = estDayKey(new Date(Date.now() - 90 * 86400000));
        for (const day of Object.keys(state.brierLog)) {
          if (day < brierCutoff) delete state.brierLog[day];
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
  } finally {
    _runInFlight = false;
    releaseRunLock();
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

const GAME_LABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL", valorant: "Valorant" };

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
      const matchDate = new Date(p.matchTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: true }) + " ET";
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
      msg += `   ${p.league} · BO${p.format} · 📅 ${matchDate}\n`;
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
    const closed = state.closedPositions || [];
    const open = state.openPositions || [];
    const wins = closed.filter(p => p.result === "win").length;
    const losses = closed.filter(p => p.result === "loss").length;
    const total = wins + losses;
    const hitRate = total > 0 ? (wins / total * 100).toFixed(1) : "0.0";
    const deployed = open.reduce((s, p) => s + p.betSize, 0);
    const totalBankroll = state.bankroll + deployed; // cash + money in open bets
    const pnl = totalBankroll - (state.initialBankroll || 1000);
    const totalPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
    const avgEdge = closed.length > 0 ? (closed.reduce((s, p) => s + (p.edge || 0), 0) / closed.length).toFixed(1) : "0.0";

    const w = state.modelWeights || {};

    let msg = `📈 <b>BOT STATUS</b>\n\n`;
    msg += `🏦 Bankroll: <b>$${totalBankroll.toFixed(2)}</b> ($${state.bankroll.toFixed(2)} cash + $${deployed.toFixed(2)} in bets)\n`;
    msg += `💰 P&L: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b> (${pnl >= 0 ? "+" : ""}${((pnl / (state.initialBankroll || 1000)) * 100).toFixed(1)}%)\n`;
    msg += `📊 Deployed: $${deployed.toFixed(0)} across ${open.length} open bet${open.length !== 1 ? "s" : ""}\n\n`;
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
      const alreadyUpToDate = pullResult.includes("Already up to date");
      const msg = alreadyUpToDate
        ? "✅ Already up to date — forcing restart to pick up any uncommitted changes."
        : `🚀 <b>DEPLOYING</b>\n\n<code>${pullResult}</code>\n\nRestarting bot in 2 seconds...`;
      await sendTG(msg);
      // ALWAYS restart — even if no code changes. This ensures the bot is running latest code.
      setTimeout(() => process.exit(0), 2000);
      return null; // Don't send another message
    } catch (e) {
      return `❌ Deploy failed: ${e.message}`;
    }
  }

  if (cmd === "/version") {
    try {
      const repoDir = join(__dirname, "..");
      const hash = execSync("git rev-parse --short HEAD", { cwd: repoDir }).toString().trim();
      const msg = execSync("git log -1 --pretty=%s", { cwd: repoDir }).toString().trim();
      const date = execSync("git log -1 --pretty=%ci", { cwd: repoDir }).toString().trim();
      return `🔖 <b>VERSION</b>\n\nCommit: <code>${hash}</code>\n${msg}\n${date}`;
    } catch (e) {
      return `❌ ${e.message}`;
    }
  }

  if (cmd === "/summary") {
    const closed = state.closedPositions || [];
    const open = state.openPositions || [];
    const deployed = open.reduce((s, p) => s + p.betSize, 0);
    const totalBankroll = state.bankroll + deployed;
    const totalPnl = totalBankroll - (state.initialBankroll || 1000);
    const allWins = closed.filter(p => p.result === "win").length;
    const allLosses = closed.filter(p => p.result === "loss").length;

    // Split by bet type — edge, confirmation, fade each tracked separately
    // so we can see which strategy is actually driving P&L vs. bleeding it.
    // ROI% = PnL / staked, more honest than raw dollars which ignore size.
    const typeStats = (filterFn) => {
      const bets = closed.filter(filterFn);
      const wins = bets.filter(p => p.result === "win").length;
      const losses = bets.filter(p => p.result === "loss").length;
      const pnl = bets.reduce((s, p) => s + (p.pnl || 0), 0);
      const staked = bets.reduce((s, p) => s + (p.betSize || 0), 0);
      const roi = staked > 0 ? (pnl / staked) * 100 : 0;
      return { n: bets.length, wins, losses, pnl, staked, roi, bets };
    };
    const edge = typeStats(p => !p.betType || p.betType === "edge");
    const confirm = typeStats(p => p.betType === "confirmation");
    const fade = typeStats(p => p.betType === "fade");

    // CLV + Brier — calibration metrics that are independent of P&L variance.
    const withClv = closed.filter(p => typeof p.clv === "number");
    const avgClv = withClv.length > 0
      ? withClv.reduce((s, p) => s + p.clv, 0) / withClv.length
      : null;
    const clvPositive = withClv.filter(p => p.clv > 0).length;

    const withBrier = closed.filter(p => typeof p.brier === "number");
    const avgBrier = withBrier.length > 0
      ? withBrier.reduce((s, p) => s + p.brier, 0) / withBrier.length
      : null;

    // By game
    const games = {};
    closed.forEach(p => {
      const g = p.game || "unknown";
      if (!games[g]) games[g] = { wins: 0, losses: 0, pnl: 0 };
      if (p.result === "win") games[g].wins++;
      else games[g].losses++;
      games[g].pnl += p.pnl || 0;
    });

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
    msg += `🏦 Bankroll: <b>$${totalBankroll.toFixed(2)}</b> ($${state.bankroll.toFixed(2)} cash + $${deployed.toFixed(2)} in bets)\n`;
    msg += `💰 P&L: <b>${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}</b> (${(totalPnl / (state.initialBankroll || 1000) * 100).toFixed(1)}% ROI)\n`;
    msg += `🎯 Record: <b>${allWins}W - ${allLosses}L</b> (${allWins + allLosses > 0 ? (allWins / (allWins + allLosses) * 100).toFixed(0) : 0}%)\n\n`;

    // Strategy breakdown — W/L, win rate, ROI%, and P&L per bet type.
    // ROI% is the most honest comparison across strategies since confirm
    // bets run at bigger sizes than edge bets; raw P&L can mislead.
    const fmtStrat = (label, s) => {
      const wl = `${s.wins}W-${s.losses}L`;
      const wr = s.wins + s.losses > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) : "0";
      const pnlSign = s.pnl >= 0 ? "+" : "";
      const roiSign = s.roi >= 0 ? "+" : "";
      return `   ${label}: ${wl} (${wr}%) | ${pnlSign}$${s.pnl.toFixed(2)} · ROI ${roiSign}${s.roi.toFixed(1)}%\n`;
    };
    msg += `📈 <b>BY STRATEGY</b>\n`;
    if (edge.n > 0) msg += fmtStrat("Edge", edge);
    if (confirm.n > 0) msg += fmtStrat("Confirm", confirm);
    if (fade.n > 0) msg += fmtStrat("Fade", fade);
    msg += "\n";

    // Model-skill metrics — CLV (closing line value) and Brier score.
    // Both are independent of result variance, so they surface genuine
    // improvement (or deterioration) much faster than W/L alone.
    if (withClv.length > 0 || withBrier.length > 0) {
      msg += `🧪 <b>MODEL SKILL</b>\n`;
      if (withClv.length > 0 && avgClv != null) {
        const clvSign = avgClv >= 0 ? "+" : "";
        const clvHit = withClv.length > 0 ? (clvPositive / withClv.length * 100).toFixed(0) : "0";
        msg += `   Avg CLV: <b>${clvSign}${avgClv.toFixed(2)}%</b> over ${withClv.length} bets · ${clvHit}% beat close\n`;
      }
      if (withBrier.length > 0 && avgBrier != null) {
        // Brier benchmarks: 0.25 = coin flip, <0.20 = skilled, <0.15 = very sharp.
        const grade = avgBrier < 0.18 ? "sharp" : avgBrier < 0.22 ? "solid" : avgBrier < 0.25 ? "marginal" : "worse than coin flip";
        msg += `   Avg Brier: <b>${avgBrier.toFixed(3)}</b> over ${withBrier.length} bets (${grade})\n`;
      }
      // Today's Brier per game — lets us see which game is mispredicting today.
      const todayKey = estDayKey(new Date());
      const todayBrier = state.brierLog?.[todayKey];
      if (todayBrier) {
        const parts = [];
        const GL = { csgo: "CS2", dota2: "Dota", lol: "LoL", valorant: "Val", r6siege: "R6" };
        for (const [g, rec] of Object.entries(todayBrier)) {
          if (rec.n > 0) parts.push(`${GL[g] || g} ${(rec.sum / rec.n).toFixed(3)} (n=${rec.n})`);
        }
        if (parts.length) msg += `   Today: ${parts.join(" · ")}\n`;
      }
      msg += "\n";
    }

    // By game
    if (Object.keys(games).length > 0) {
      const GLABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL", valorant: "Valorant", r6siege: "R6" };
      msg += `🎮 <b>BY GAME</b>\n`;
      Object.entries(games).forEach(([g, d]) => {
        const label = GLABEL[g] || g;
        const total = d.wins + d.losses;
        msg += `   ${label}: ${d.wins}W-${d.losses}L (${total > 0 ? (d.wins / total * 100).toFixed(0) : 0}%) | ${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(2)}\n`;
      });
      msg += "\n";
    }

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

    // Open positions with match times
    if (open.length > 0) {
      msg += `⏳ <b>OPEN POSITIONS (${open.length})</b>\n`;
      const sortedOpen = [...open].sort((a, b) => new Date(a.matchTime) - new Date(b.matchTime));
      sortedOpen.forEach(p => {
        const typeTag = p.betType === "confirmation" ? " [C]" : p.betType === "fade" ? " [F]" : " [E]";
        const matchStr = p.matchTime ? new Date(p.matchTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: true }) + " ET" : "?";
        const statusEmoji = p.matchStatus === "live" ? "🔴" : "⏰";
        const game = GAME_LABEL[p.game] || p.game || "";
        msg += `   ${statusEmoji}${typeTag} <b>${p.pick}</b> — ${game} · ${p.event}\n`;
        msg += `      📅 ${matchStr} | $${(p.betSize || p.size || 0).toFixed(2)} @ ${p.marketProb}% | Edge: +${p.edge}%\n`;
      });
      msg += "\n";
    }

    // Recent trades
    const recent5 = closed.slice(0, 5);
    if (recent5.length > 0) {
      msg += `📋 <b>LAST 5 TRADES</b>\n`;
      recent5.forEach(p => {
        const emoji = p.result === "win" ? "✅" : "❌";
        const typeTag = p.betType === "confirmation" ? " [C]" : " [E]";
        const placedStr = p.placedAt ? new Date(p.placedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: true }) + " ET" : "?";
        const matchStr = p.matchTime ? new Date(p.matchTime).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York", hour12: true }) + " ET" : "?";
        msg += `   ${emoji}${typeTag} ${p.pick} (${p.event}) ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}\n`;
        msg += `      Bet: ${placedStr} | Match: ${matchStr}\n`;
      });
    }

    return msg;
  }

  if (cmd === "/scan") {
    // Escape HTML chars that would break Telegram parse mode
    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Dry-run scan: show all matches in window and why each would be rejected.
    // Does NOT place any bets.
    try {
      const now = new Date();
      const [csgo, dota2, lol, valorant, r6siege, polyMarkets] = await Promise.all([
        pandaFetch("csgo/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("dota2/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("lol/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("valorant/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        pandaFetch("r6siege/matches/upcoming?per_page=25&sort=scheduled_at").catch(() => []),
        fetchAllPolymarketEsports(),
      ]);
      const allMatches = [
        ...csgo.map(m => ({ ...m, _game: "csgo" })),
        ...dota2.map(m => ({ ...m, _game: "dota2" })),
        ...lol.map(m => ({ ...m, _game: "lol" })),
        ...valorant.map(m => ({ ...m, _game: "valorant" })),
        ...r6siege.map(m => ({ ...m, _game: "r6siege" })),
      ];

      const GLABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL", valorant: "Valorant", r6siege: "R6" };
      const inWindow = [];
      for (const m of allMatches) {
        const t1 = m.opponents?.[0]?.opponent;
        const t2 = m.opponents?.[1]?.opponent;
        if (!t1 || !t2) continue;
        const hoursUntil = (new Date(m.scheduled_at) - now) / 3600000;
        if (hoursUntil < BET_WINDOW_MIN_H || hoursUntil > BET_WINDOW_MAX_H) continue;
        const polyOdds = matchPolymarket(polyMarkets, t1.name, t2.name) ||
                         matchPolymarket(polyMarkets, t1.acronym || t1.name, t2.acronym || t2.name);
        inWindow.push({ m, t1, t2, hoursUntil, polyOdds });
      }

      let msg = `🔎 <b>LIVE SCAN</b>\n`;
      msg += `${allMatches.length} total upcoming · ${inWindow.length} in ${BET_WINDOW_MIN_H}-${BET_WINDOW_MAX_H}h window\n`;
      msg += `${polyMarkets.length} Polymarket markets loaded\n\n`;

      if (inWindow.length === 0) {
        msg += `❌ <b>No matches in window.</b>\n\nWindow is ${BET_WINDOW_MIN_H}h to ${BET_WINDOW_MAX_H}h from now.\n\n`;
        const next = allMatches.filter(m => m.opponents?.length === 2 && new Date(m.scheduled_at) > now)
          .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
        if (next) {
          const h = ((new Date(next.scheduled_at) - now) / 3600000).toFixed(1);
          const t1name = esc(next.opponents[0].opponent?.name || "?");
          const t2name = esc(next.opponents[1].opponent?.name || "?");
          msg += `Next match: ${t1name} vs ${t2name} in <b>${h}h</b>`;
        }
        return msg;
      }

      // Show each match in window with its status
      msg += `<b>MATCHES IN WINDOW (sorted by time):</b>\n`;
      inWindow.sort((a, b) => a.hoursUntil - b.hoursUntil);
      for (let i = 0; i < Math.min(inWindow.length, 10); i++) {
        const x = inWindow[i];
        const game = GLABEL[x.m._game] || x.m._game;
        const teams = `${esc(x.t1.acronym || x.t1.name)} vs ${esc(x.t2.acronym || x.t2.name)}`;
        const h = x.hoursUntil.toFixed(1);
        let status = "";
        if (!x.polyOdds) {
          status = "❌ no Polymarket match";
        } else {
          const liq = x.polyOdds.liquidity;
          const maxProb = Math.max(x.polyOdds.probA, x.polyOdds.probB);
          const staleCutoffH = x.hoursUntil <= 0 ? 0.5 : 1.5;
          const stale = x.polyOdds.hoursSinceUpdate !== null && x.polyOdds.hoursSinceUpdate > staleCutoffH;
          if (liq < MIN_LIQUIDITY) status = `❌ liq $${liq.toFixed(0)} &lt; $${MIN_LIQUIDITY}`;
          else if (stale) status = `❌ stale (${x.polyOdds.hoursSinceUpdate.toFixed(1)}h &gt; ${staleCutoffH}h)`;
          else if (maxProb < PRICE_DISCOVERY_MIN) status = `❌ coin-flip (${maxProb.toFixed(0)}%)`;
          else status = `✅ ${maxProb.toFixed(0)}% fav · $${liq.toFixed(0)} liq`;
        }
        msg += `${i + 1}. [${game}] ${teams} · ${h}h\n   ${status}\n`;
      }
      if (inWindow.length > 10) msg += `\n... and ${inWindow.length - 10} more\n`;

      // Stats
      const withOdds = inWindow.filter(x => x.polyOdds).length;
      const passedLiq = inWindow.filter(x => x.polyOdds && x.polyOdds.liquidity >= MIN_LIQUIDITY).length;
      const notStale = inWindow.filter(x => {
        if (!x.polyOdds || x.polyOdds.liquidity < MIN_LIQUIDITY) return false;
        const cutoff = x.hoursUntil <= 0 ? 0.5 : 1.5;
        return x.polyOdds.hoursSinceUpdate === null || x.polyOdds.hoursSinceUpdate <= cutoff;
      }).length;
      const hasSignal = inWindow.filter(x => x.polyOdds && x.polyOdds.liquidity >= MIN_LIQUIDITY && Math.max(x.polyOdds.probA, x.polyOdds.probB) >= PRICE_DISCOVERY_MIN).length;

      msg += `\n<b>FUNNEL:</b>\n`;
      msg += `   In window: ${inWindow.length}\n`;
      msg += `   With Polymarket odds: ${withOdds}\n`;
      msg += `   Pass liquidity ($${MIN_LIQUIDITY}): ${passedLiq}\n`;
      msg += `   Not stale: ${notStale}\n`;
      msg += `   Pass price discovery (${PRICE_DISCOVERY_MIN}%): ${hasSignal}\n`;

      // Truncate if over Telegram limit
      if (msg.length > 3800) msg = msg.slice(0, 3800) + "\n\n[truncated]";

      return msg;
    } catch (e) {
      return `❌ Scan failed: ${esc(e.message)}`;
    }
  }

  if (cmd === "/analyze" || cmd === "/losses") {
    const closed = state.closedPositions || [];
    const losses = closed.filter(p => p.result === "loss");
    const wins = closed.filter(p => p.result === "win");

    if (losses.length === 0) return "No losses yet — either a fresh start or we're 100%!";

    // Group losses by dimensions
    const byGame = {};
    const byLeague = {};
    const byFormat = {};
    const byConfidence = {};
    const byType = { edge: { w: 0, l: 0, pnl: 0 }, confirmation: { w: 0, l: 0, pnl: 0 } };
    const byMarketRange = {
      "50-55": { w: 0, l: 0 },   // coin flip territory
      "55-65": { w: 0, l: 0 },   // slight favorite
      "65-75": { w: 0, l: 0 },   // clear favorite
      "75-85": { w: 0, l: 0 },   // heavy favorite
      "85+":   { w: 0, l: 0 },   // lock
    };
    const byEdgeRange = {
      "<3":  { w: 0, l: 0 },
      "3-5": { w: 0, l: 0 },
      "5-8": { w: 0, l: 0 },
      "8+":  { w: 0, l: 0 },
    };

    const bucket = (p) => {
      const g = p.game || "unknown";
      const lg = p.league || "(unknown)";
      const fmt = `BO${p.format || "?"}`;
      const conf = p.confidence || "?";
      const typ = p.betType === "confirmation" ? "confirmation" : "edge";
      const isWin = p.result === "win";
      const inc = (obj, key) => {
        if (!obj[key]) obj[key] = { w: 0, l: 0, pnl: 0 };
        if (isWin) obj[key].w++;
        else obj[key].l++;
        obj[key].pnl += p.pnl || 0;
      };
      inc(byGame, g);
      inc(byLeague, lg);
      inc(byFormat, fmt);
      inc(byConfidence, conf);
      byType[typ] = byType[typ] || { w: 0, l: 0, pnl: 0 };
      if (isWin) byType[typ].w++;
      else byType[typ].l++;
      byType[typ].pnl += p.pnl || 0;

      // Market prob bucket
      const m = p.marketProb || 50;
      let mb;
      if (m < 55) mb = "50-55";
      else if (m < 65) mb = "55-65";
      else if (m < 75) mb = "65-75";
      else if (m < 85) mb = "75-85";
      else mb = "85+";
      if (isWin) byMarketRange[mb].w++;
      else byMarketRange[mb].l++;

      // Edge bucket
      const e = p.edge || 0;
      let eb;
      if (e < 3) eb = "<3";
      else if (e < 5) eb = "3-5";
      else if (e < 8) eb = "5-8";
      else eb = "8+";
      if (isWin) byEdgeRange[eb].w++;
      else byEdgeRange[eb].l++;
    };
    closed.forEach(bucket);

    const fmtRow = (name, d) => {
      const total = d.w + d.l;
      const pct = total > 0 ? (d.w / total * 100).toFixed(0) : 0;
      const pnl = d.pnl !== undefined ? ` | ${d.pnl >= 0 ? "+" : ""}$${d.pnl.toFixed(0)}` : "";
      return `   ${name}: ${d.w}W-${d.l}L (${pct}%)${pnl}`;
    };

    const GLABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL", valorant: "Valorant", r6siege: "R6" };
    let msg = `🔍 <b>LOSS ANALYSIS</b>\n`;
    msg += `${wins.length}W - ${losses.length}L over ${closed.length} trades\n\n`;

    msg += `<b>BY GAME</b>\n`;
    Object.entries(byGame).sort((a, b) => b[1].l - a[1].l).forEach(([k, d]) => {
      msg += fmtRow(GLABEL[k] || k, d) + "\n";
    });

    msg += `\n<b>BY LEAGUE (worst first)</b>\n`;
    Object.entries(byLeague)
      .filter(([, d]) => d.w + d.l >= 1)
      .sort((a, b) => (b[1].l - b[1].w) - (a[1].l - a[1].w))
      .slice(0, 5)
      .forEach(([k, d]) => {
        msg += fmtRow(k.slice(0, 30), d) + "\n";
      });

    msg += `\n<b>BY FORMAT</b>\n`;
    Object.entries(byFormat).forEach(([k, d]) => {
      msg += fmtRow(k, d) + "\n";
    });

    msg += `\n<b>BY CONFIDENCE</b>\n`;
    Object.entries(byConfidence).forEach(([k, d]) => {
      msg += fmtRow(k, d) + "\n";
    });

    msg += `\n<b>BY MARKET PROB (higher = safer)</b>\n`;
    Object.entries(byMarketRange).forEach(([k, d]) => {
      if (d.w + d.l > 0) msg += fmtRow(`${k}%`, d) + "\n";
    });

    msg += `\n<b>BY EDGE SIZE</b>\n`;
    Object.entries(byEdgeRange).forEach(([k, d]) => {
      if (d.w + d.l > 0) msg += fmtRow(`${k}%`, d) + "\n";
    });

    // Smart insights
    const insights = [];
    const worstLeague = Object.entries(byLeague)
      .filter(([, d]) => d.w + d.l >= 2 && d.l > d.w)
      .sort((a, b) => (b[1].l - b[1].w) - (a[1].l - a[1].w))[0];
    if (worstLeague) {
      insights.push(`⚠️ Losing streak in <b>${worstLeague[0]}</b> — consider skipping this league`);
    }

    const coinFlipLosses = byMarketRange["50-55"].l;
    if (coinFlipLosses >= 2) {
      insights.push(`⚠️ ${coinFlipLosses} losses on 50-55% coin-flip markets — these are traps`);
    }

    const smallEdgeLosses = (byEdgeRange["<3"].l) + (byEdgeRange["3-5"].l);
    const smallEdgeTotal = (byEdgeRange["<3"].l + byEdgeRange["<3"].w) + (byEdgeRange["3-5"].l + byEdgeRange["3-5"].w);
    if (smallEdgeTotal > 0 && smallEdgeLosses / smallEdgeTotal > 0.5) {
      insights.push(`⚠️ Small edges (<5%) are mostly losing — need bigger edge threshold`);
    }

    const lowConfLosses = byConfidence["low"]?.l || 0;
    if (lowConfLosses >= 2) {
      insights.push(`⚠️ Low-confidence bets losing — model needs more data before betting`);
    }

    if (insights.length > 0) {
      msg += `\n<b>🧠 INSIGHTS</b>\n`;
      insights.forEach(i => { msg += `${i}\n`; });
    }

    return msg;
  }

  if (cmd === "/help") {
    return `🤖 <b>Edge Terminal Bot</b>\n\n` +
      `/trades — Open positions with live prices + thesis\n` +
      `/status — Bankroll, P&L, win rate\n` +
      `/summary — Full analytics + bot vs market\n` +
      `/analyze — Deep-dive loss analysis + insights\n` +
      `/scan — Dry-run scan: show why matches are/aren't passing\n` +
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
