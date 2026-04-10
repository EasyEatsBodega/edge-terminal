import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell } from "recharts";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const PAL = {
  bg: "#09090b", panel: "#111114", card: "#18181b", hover: "#1f1f23",
  border: "#27272a", borderLit: "#3f3f46",
  text: "#fafafa", sub: "#a1a1aa", dim: "#52525b", faint: "#27272a",
  green: "#22c55e", red: "#ef4444", yellow: "#eab308", blue: "#3b82f6",
  purple: "#a855f7", orange: "#f97316",
};
const GAME_COLOR = { csgo: "#f97316", dota2: "#ef4444", lol: "#3b82f6" };
const GAME_LABEL = { csgo: "CS2", dota2: "Dota 2", lol: "LoL" };
const GAME_SLUG = { csgo: "csgo", dota2: "dota2", lol: "lol" };

const save = (k, v) => { try { localStorage.setItem(`et2_${k}`, JSON.stringify(v)); } catch(e){} };
const load = (k, fb) => { try { const v = localStorage.getItem(`et2_${k}`); return v ? JSON.parse(v) : fb; } catch(e){ return fb; } };

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG — day-by-day bot updates for YouTube content
// ═══════════════════════════════════════════════════════════════════════════════

const BOT_CHANGELOG = {
  "2026-04-05": {
    title: "Day 0 — Project Launch",
    updates: [
      { type: "launch", text: "Built Edge Terminal from scratch — esports prediction engine for CS2, Dota 2, and LoL" },
      { type: "feature", text: "Paper trading bot with $1,000 starting bankroll" },
      { type: "feature", text: "Polymarket API integration for real market odds" },
      { type: "feature", text: "PandaScore API for match data, team histories, head-to-head records" },
      { type: "feature", text: "Prediction model v1: weighted win rate (form 45%, overall 35%, H2H 15%)" },
      { type: "infra", text: "Dashboard deployed on Vercel, bot deployed on VPS with cron" },
    ],
  },
  "2026-04-06": {
    title: "Day 1 — Bot Goes Live",
    updates: [
      { type: "feature", text: "Standalone VPS bot — no Redis dependency, file-based state" },
      { type: "feature", text: "Telegram bot with /trades, /status, /run, /help commands" },
      { type: "fix", text: "Fixed Polymarket outcomes parsing (was breaking on string JSON)" },
      { type: "fix", text: "Fixed edge logic — was accidentally betting underdogs instead of predicted winners" },
    ],
  },
  "2026-04-07": {
    title: "Day 2 — First Bets + Major Overhaul",
    updates: [
      { type: "result", text: "First 3 bets placed: CRASH, ZOMB, InC — all 3 lost (0-3 record)" },
      { type: "lesson", text: "Losses exposed problems: low-liquidity markets, no quality filters, betting garbage tier matches" },
      { type: "feature", text: "Quality filter overhaul — $1k min liquidity, ranked picks by win probability" },
      { type: "feature", text: "Direct Polymarket links on every bet" },
      { type: "feature", text: "Smart cron with lock file + auto git sync (no more SSH needed)" },
      { type: "feature", text: "/deploy command for instant VPS updates via Telegram" },
      { type: "model", text: "Model v2 — opponent strength weighting by tournament tier (S/A/B)" },
      { type: "model", text: "Exponential recency decay (0.8^i) instead of linear" },
      { type: "model", text: "Hot/cold streak detection (last 3 matches)" },
      { type: "model", text: "BO1 penalty — 50% bet size reduction + probability pull toward 50%" },
      { type: "feature", text: "Loss analysis system — categorizes every loss (BO1 upset, thin edge, model overestimate, etc.)" },
      { type: "feature", text: "Thesis generator — plain English reasoning for every pick" },
      { type: "feature", text: "Dashboard overhaul — bankroll chart, P&L by game, bot vs market accuracy, LIVE badges" },
      { type: "strategy", text: "Switched to aggressive mode — MIN_PROB 60%, bigger bets on 70%+ plays, 12hr scan window" },
    ],
  },
  "2026-04-08": {
    title: "Day 3 — Defense + Market Confirmation",
    updates: [
      { type: "result", text: "More losses — record at 1W-5L, bankroll down to ~$544" },
      { type: "lesson", text: "Model was overconfident on low-tier matches. Market was right more often than us." },
      { type: "model", text: "Model v3 — added game score analysis, dominance factor, clutch performance" },
      { type: "strategy", text: "Defensive overhaul — drawdown protection, conservative sizing, circuit breaker on losing streaks" },
      { type: "strategy", text: "Market confirmation strategy — only bet when model AND market agree on favorite" },
      { type: "feature", text: "Tiered confirmation bets with game-specific tuning (CS2/Dota2/LoL)" },
      { type: "feature", text: "Split performance tracking — regular bets vs confirmation bets" },
      { type: "fix", text: "Fixed circuit breaker to stop Telegram spam + time-aware reset" },
      { type: "feature", text: "Polymarket staleness filter — skip markets with old data" },
      { type: "model", text: "Rustiness penalty for teams that haven't played recently" },
      { type: "feature", text: "Daily Recap view — day-by-day breakdown with talking points for YouTube" },
    ],
  },
  "2026-04-09": {
    title: "Day 4 — Diagnostics + Volume Tuning",
    updates: [
      { type: "feature", text: "/analyze Telegram command — deep-dive loss breakdown by game, league, format, market range, edge size" },
      { type: "feature", text: "Smart insights engine — auto-detects losing patterns (worst leagues, coin-flip traps, small-edge losses)" },
      { type: "feature", text: "League auto-blacklist — leagues where we're 0-3+ over 14 days get skipped automatically" },
      { type: "strategy", text: "Underdog guard — NEVER bet a team the market sees <45% unless model is 65%+; <40% market requires 70%+ model" },
      { type: "lesson", text: "Discovered all historical losses were 100% CS2, 75% CCT South America, 100% on 50/50 markets, all small edges. Model was betting tier-3 regional coin-flips." },
      { type: "strategy", text: "Volume caps bumped — max positions 5→8, deployment 20%→30%, bets/run 2→3" },
      { type: "feature", text: "Time-based opportunity ranking — matches within 1h get +2 bonus, within 3h get +1. Soonest matches prioritized." },
      { type: "infra", text: "Vercel cron bumped from 4h to hourly — was missing ~75% of matches" },
    ],
  },
  "2026-04-10": {
    title: "Day 5 — The Recovery + MICRO Tier",
    updates: [
      { type: "result", text: "FIRST CONFIRMATION BET WIN — LYNX (STRONG tier) at 78.9% model / 93.5% market, +$3.20. Bankroll $725→$748" },
      { type: "lesson", text: "Confirmation bet strategy proven — riding market consensus on heavy favorites is generating wins where our edge model was losing" },
      { type: "feature", text: "/scan diagnostic command — dry-run shows every match in window, why each is passing/failing, and the full funnel" },
      { type: "feature", text: "/version command — verify exact commit deployed on VPS" },
      { type: "fix", text: "/deploy now force-restarts the bot even when already up to date (fixed stale-code-in-memory bug)" },
      { type: "fix", text: "/scan HTML-escapes team names (was silently failing on & < > chars)" },
      { type: "feature", text: "Detailed rejection logging in every run — tracks exactly which filter blocked each match" },
      { type: "strategy", text: "NEW MICRO confirmation tier — 65%+ market, 63%+ model, 2% bankroll. Catches slight favorites the old 72% threshold missed." },
      { type: "strategy", text: "Filter loosening for more volume: liquidity $2k→$1.5k (edge) and $3k→$2k (confirm), bet window 0.5-6h→0.25-8h, staleness 2h→3h, price discovery 58%→55%" },
      { type: "strategy", text: "Volume caps: max positions 8→10, deployment 30%→35%, confirmation bets/run 3→4" },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER — PandaScore API with caching
// ═══════════════════════════════════════════════════════════════════════════════

const _cache = {};
async function cachedPanda(path, token, ttl = 15 * 60 * 1000) {
  const key = path;
  if (_cache[key] && Date.now() - _cache[key].ts < ttl) return _cache[key].data;
  const r = await fetch(`/api/panda?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`);
  if (!r.ok) throw new Error(`PandaScore ${r.status}`);
  const data = await r.json();
  _cache[key] = { data, ts: Date.now() };
  return data;
}

async function fetchUpcoming(game, token) {
  return cachedPanda(`${game}/matches/upcoming?per_page=25&sort=scheduled_at`, token, 5 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// POLYMARKET — Live Moneyline Odds
// ═══════════════════════════════════════════════════════════════════════════════

const POLY_TAG = { csgo: 100780, dota2: 102366, lol: 65 };

async function fetchPolymarketOdds() {
  const results = await Promise.allSettled(
    Object.entries(POLY_TAG).map(([, tagId]) =>
      fetch(`https://gamma-api.polymarket.com/markets?sports_market_types=moneyline&closed=false&tag_id=${tagId}&limit=50`)
        .then(r => r.ok ? r.json() : [])
    )
  );
  return results.flatMap(r => r.status === "fulfilled" ? r.value : []);
}

function matchPolyOdds(polyMarkets, teamA, teamB) {
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
        const slug = mkt.slug || "";
        const polyUrl = slug ? `https://polymarket.com/event/${slug}` : null;
        return {
          probA: +(aIsFirst ? probFirst : probSecond).toFixed(1),
          probB: +(aIsFirst ? probSecond : probFirst).toFixed(1),
          liquidity, slug, polyUrl,
        };
      }
    }
  }
  return null;
}

async function fetchTeamHistory(game, teamId, token) {
  return cachedPanda(`${game}/matches/past?filter[opponent_id]=${teamId}&per_page=25&sort=-scheduled_at`, token, 15 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDICTION MODEL
// ═══════════════════════════════════════════════════════════════════════════════

function computePrediction(teamAId, teamBId, teamAHistory, teamBHistory, format) {
  const getTeamResults = (history, teamId) => {
    return history.map(m => {
      const won = m.winner?.id === teamId;
      const opp = m.opponents?.find(o => o.opponent?.id !== teamId)?.opponent;
      return { won, oppId: opp?.id, oppName: opp?.name, date: m.scheduled_at || m.begin_at, matchId: m.id, score: m.results };
    }).filter(r => r.oppId);
  };

  const resultsA = getTeamResults(teamAHistory, teamAId);
  const resultsB = getTeamResults(teamBHistory, teamBId);

  // Recent form (last 10, weighted by recency)
  const weightedWR = (results, n = 10) => {
    const recent = results.slice(0, n);
    if (recent.length === 0) return { winRate: 50, record: "0-0", matches: 0 };
    let totalWeight = 0, weightedWins = 0;
    recent.forEach((r, i) => {
      const w = 1 - (i / (n * 1.5)); // Linear decay
      totalWeight += w;
      if (r.won) weightedWins += w;
    });
    const wins = recent.filter(r => r.won).length;
    const losses = recent.length - wins;
    return {
      winRate: totalWeight > 0 ? (weightedWins / totalWeight) * 100 : 50,
      record: `${wins}-${losses}`,
      matches: recent.length,
      streak: getStreak(recent),
      results: recent.slice(0, 10).map(r => r.won ? "W" : "L"),
    };
  };

  const getStreak = (results) => {
    if (results.length === 0) return { type: "-", count: 0 };
    const first = results[0].won;
    let count = 0;
    for (const r of results) {
      if (r.won === first) count++;
      else break;
    }
    return { type: first ? "W" : "L", count };
  };

  // Overall win rate (all available data)
  const overallWR = (results) => {
    if (results.length === 0) return { winRate: 50, record: "0-0", matches: 0 };
    const wins = results.filter(r => r.won).length;
    return { winRate: (wins / results.length) * 100, record: `${wins}-${results.length - wins}`, matches: results.length };
  };

  // Head to head
  const h2h = (resultsA, teamBId) => {
    const meetings = resultsA.filter(r => r.oppId === teamBId);
    if (meetings.length === 0) return { winRate: 50, record: "0-0", matches: 0 };
    const wins = meetings.filter(r => r.won).length;
    return { winRate: (wins / meetings.length) * 100, record: `${wins}-${meetings.length - wins}`, matches: meetings.length };
  };

  const formA = weightedWR(resultsA, 10);
  const formB = weightedWR(resultsB, 10);
  const allA = overallWR(resultsA);
  const allB = overallWR(resultsB);
  const h2hData = h2h(resultsA, teamBId);

  // Confidence based on data volume
  const dataPoints = Math.min(formA.matches, formB.matches);
  const confidence = dataPoints >= 8 ? "high" : dataPoints >= 4 ? "medium" : "low";

  // Composite model
  const h2hWeight = h2hData.matches >= 3 ? 0.15 : 0.05;
  const formWeight = 0.45;
  const overallWeight = 0.40 - (h2hWeight - 0.05);

  const scoreA = (formWeight * formA.winRate) + (overallWeight * allA.winRate) + (h2hWeight * h2hData.winRate);
  const scoreB = (formWeight * formB.winRate) + (overallWeight * allB.winRate) + (h2hWeight * (100 - h2hData.winRate));

  let rawProb = (scoreA + scoreB) > 0 ? (scoreA / (scoreA + scoreB)) * 100 : 50;

  // BO format adjustment
  const bo = format || 1;
  if (bo === 1) {
    rawProb = rawProb * 0.88 + 50 * 0.12; // Pull toward 50% — BO1 is volatile
  } else if (bo >= 5) {
    const dist = rawProb - 50;
    rawProb = 50 + dist * 1.08; // Amplify — BO5 favors better team
  }

  rawProb = Math.max(5, Math.min(95, rawProb)); // Clamp

  return {
    probA: rawProb,
    probB: 100 - rawProb,
    confidence,
    factors: {
      formA, formB,
      overallA: allA, overallB: allB,
      h2h: h2hData,
      format: bo,
      weights: { form: formWeight, overall: overallWeight, h2h: h2hWeight },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// THESIS GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function generateThesis(teamA, teamB, pred, edge) {
  const { factors, probA } = pred;
  const parts = [];
  const fav = probA > 50 ? teamA : teamB;
  const favProb = Math.max(probA, 100 - probA);

  const formDiff = Math.abs(factors.formA.winRate - factors.formB.winRate);
  const betterForm = factors.formA.winRate > factors.formB.winRate ? teamA : teamB;
  const betterFormData = factors.formA.winRate > factors.formB.winRate ? factors.formA : factors.formB;
  const worseFormData = factors.formA.winRate > factors.formB.winRate ? factors.formB : factors.formA;

  if (formDiff > 20) {
    parts.push(`${betterForm}'s dominant form (${betterFormData.record} L${betterFormData.matches}) vs ${worseFormData.record} is the primary driver`);
  } else if (formDiff > 10) {
    parts.push(`${betterForm} holds a form edge at ${betterFormData.record} recent`);
  } else {
    parts.push(`Both teams in similar form (${factors.formA.record} vs ${factors.formB.record})`);
  }

  if (factors.h2h.matches >= 3) {
    const h2hLeader = factors.h2h.winRate > 55 ? teamA : factors.h2h.winRate < 45 ? teamB : null;
    if (h2hLeader) parts.push(`${h2hLeader} leads H2H ${h2hLeader === teamA ? factors.h2h.record : factors.h2h.record.split("-").reverse().join("-")}`);
  }

  if (factors.format === 1) parts.push("BO1 increases upset risk");
  else if (factors.format >= 5) parts.push(`BO${factors.format} favors the stronger side`);

  if (edge !== null) {
    if (Math.abs(edge) > 5) parts.push(`${Math.abs(edge).toFixed(1)}% edge — strong value`);
    else if (Math.abs(edge) > 2) parts.push(`${Math.abs(edge).toFixed(1)}% edge detected`);
    else parts.push("No significant edge vs market");
  }

  return parts.join(". ") + ".";
}

// ═══════════════════════════════════════════════════════════════════════════════
// ODDS MATH
// ═══════════════════════════════════════════════════════════════════════════════

const calcKelly = (prob, impliedProb) => {
  if (prob <= impliedProb) return 0;
  const p = prob / 100;
  const b = (1 / (impliedProb / 100)) - 1; // decimal odds - 1
  return Math.max(0, ((b * p) - (1 - p)) / b * 100);
};

// ═══════════════════════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [pandaKey, setPandaKey] = useState(() => load("pandaKey", ""));
  const [keyInput, setKeyInput] = useState(() => load("pandaKey", ""));
  const [view, setView] = useState("bot"); // bot | predictions | log | daily | settings
  const [gameFilter, setGameFilter] = useState("all"); // all | csgo | dota2 | lol
  const [sortBy, setSortBy] = useState("time"); // time | edge
  const [expandedMatch, setExpandedMatch] = useState(null);

  // Match data
  const [upcoming, setUpcoming] = useState([]); // unified list of upcoming matches across all games
  const [predictions, setPredictions] = useState({}); // matchId -> prediction
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [loadingPredictions, setLoadingPredictions] = useState({});
  const [marketOdds, setMarketOdds] = useState(() => load("marketOdds", {})); // matchId -> { probA }
  const [errors, setErrors] = useState({});

  // Bet log
  const [betLog, setBetLog] = useState(() => load("betLog2", []));

  // Bot state — connects to VPS bot server
  const [botState, setBotState] = useState(null);
  const [botLoading, setBotLoading] = useState(false);
  const [botError, setBotError] = useState(null);
  const [botSecret, setBotSecret] = useState(() => load("botSecret", "") || "edgeterminal2026");
  const [botSecretInput, setBotSecretInput] = useState(() => load("botSecret", "") || "edgeterminal2026");
  const [botUrl, setBotUrl] = useState(() => load("botUrl", "") || "http://142.93.228.49:3069");
  const [botUrlInput, setBotUrlInput] = useState(() => load("botUrl", "") || "http://142.93.228.49:3069");
  const [botRunning, setBotRunning] = useState(false);

  // Helper: build a request URL. On HTTPS (production) we MUST proxy through
  // /api/bot-proxy because browsers block HTTPS→HTTP mixed content. On HTTP
  // (local dev) we can fetch the bot directly.
  const buildBotUrl = useCallback((path) => {
    const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
    const botIsHttp = botUrl.startsWith("http://");
    if (isHttps && botIsHttp) {
      // Proxy through Vercel API route
      const params = new URLSearchParams({ path, secret: botSecret, botUrl });
      return `/api/bot-proxy?${params.toString()}`;
    }
    // Direct fetch — only works when both dashboard and bot are HTTP, or both HTTPS
    const base = botUrl.replace(/\/+$/, "");
    return `${base}/${path}?secret=${encodeURIComponent(botSecret)}`;
  }, [botUrl, botSecret]);

  const loadBotState = useCallback(async () => {
    if (!botSecret || !botUrl) return;
    setBotLoading(true);
    setBotError(null);
    try {
      const url = buildBotUrl("state");
      const r = await fetch(url);
      if (!r.ok) {
        let detail = "";
        try {
          const body = await r.json();
          detail = body?.detail || body?.error || "";
        } catch {}
        throw new Error(`HTTP ${r.status}${detail ? " — " + detail : ""}`);
      }
      const data = await r.json();
      setBotState(data);
    } catch (e) {
      console.error("Bot state fetch failed:", e);
      setBotError(e.message || String(e));
    } finally { setBotLoading(false); }
  }, [botSecret, botUrl, buildBotUrl]);

  const triggerBotRun = useCallback(async () => {
    if (!botSecret || !botUrl) return;
    setBotRunning(true);
    try {
      const r = await fetch(buildBotUrl("run"));
      const data = await r.json();
      if (data.ok) await loadBotState();
      return data;
    } catch (e) { console.error("Bot run failed:", e); return { ok: false, error: e.message }; }
    finally { setBotRunning(false); }
  }, [botSecret, botUrl, loadBotState, buildBotUrl]);

  useEffect(() => {
    // Load bot state when on any view that needs it
    if (botSecret && botUrl && (view === "bot" || view === "daily")) loadBotState();
  }, [botSecret, botUrl, view]);
  useEffect(() => { save("botSecret", botSecret); }, [botSecret]);
  useEffect(() => { save("botUrl", botUrl); }, [botUrl]);

  // Auto-refresh bot state every 30s when on bot view
  useEffect(() => {
    if (view !== "bot" || !botSecret || !botUrl) return;
    const t = setInterval(loadBotState, 30000);
    return () => clearInterval(t);
  }, [view, botSecret, botUrl, loadBotState]);

  // Clock
  const [clock, setClock] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);

  // Persist
  useEffect(() => { save("pandaKey", pandaKey); }, [pandaKey]);
  useEffect(() => { save("marketOdds", marketOdds); }, [marketOdds]);
  useEffect(() => { save("betLog2", betLog); }, [betLog]);

  // ─── Fetch Upcoming Matches ──────────────────────────────────────────────

  const loadUpcoming = useCallback(async () => {
    if (!pandaKey) return;
    setLoadingMatches(true);
    setErrors({});
    try {
      const games = ["csgo", "dota2", "lol"];
      const results = await Promise.allSettled(games.map(g => fetchUpcoming(g, pandaKey)));

      const all = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && Array.isArray(r.value)) {
          r.value.forEach(m => {
            const t1 = m.opponents?.[0]?.opponent;
            const t2 = m.opponents?.[1]?.opponent;
            if (t1 && t2) {
              all.push({
                id: m.id,
                game: games[i],
                teamA: { id: t1.id, name: t1.name, acronym: t1.acronym || t1.name, image: t1.image_url },
                teamB: { id: t2.id, name: t2.name, acronym: t2.acronym || t2.name, image: t2.image_url },
                league: m.league?.name || "",
                serie: m.serie?.full_name || "",
                tournament: m.tournament?.name || "",
                format: m.number_of_games || 1,
                scheduledAt: m.scheduled_at,
                streamUrl: m.streams_list?.[0]?.raw_url,
              });
            }
          });
        } else if (r.status === "rejected") {
          setErrors(prev => ({ ...prev, [games[i]]: r.reason.message }));
        }
      });

      all.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      setUpcoming(all);

      // Auto-fetch Polymarket odds
      try {
        const polyMarkets = await fetchPolymarketOdds();
        if (polyMarkets.length > 0) {
          const autoOdds = {};
          all.forEach(m => {
            if (marketOdds[m.id]) return; // Don't overwrite manual entries
            const odds = matchPolyOdds(polyMarkets, m.teamA.name, m.teamB.name) ||
                         matchPolyOdds(polyMarkets, m.teamA.acronym, m.teamB.acronym);
            if (odds) autoOdds[m.id] = odds;
          });
          if (Object.keys(autoOdds).length > 0) {
            setMarketOdds(prev => ({ ...autoOdds, ...prev }));
          }
        }
      } catch (e) { console.error("Polymarket fetch failed:", e); }

      // Kick off predictions for all matches
      all.forEach(m => loadPrediction(m));
    } catch (e) {
      setErrors({ general: e.message });
    } finally {
      setLoadingMatches(false);
    }
  }, [pandaKey]);

  // ─── Load Prediction for a Single Match ──────────────────────────────────

  const loadPrediction = useCallback(async (match) => {
    if (!pandaKey || predictions[match.id]) return;
    setLoadingPredictions(prev => ({ ...prev, [match.id]: true }));
    try {
      const [histA, histB] = await Promise.all([
        fetchTeamHistory(match.game, match.teamA.id, pandaKey),
        fetchTeamHistory(match.game, match.teamB.id, pandaKey),
      ]);

      const pred = computePrediction(match.teamA.id, match.teamB.id, histA, histB, match.format);
      setPredictions(prev => ({ ...prev, [match.id]: pred }));
    } catch (e) {
      console.error(`Prediction failed for match ${match.id}:`, e);
      setPredictions(prev => ({ ...prev, [match.id]: { error: e.message } }));
    } finally {
      setLoadingPredictions(prev => ({ ...prev, [match.id]: false }));
    }
  }, [pandaKey, predictions]);

  useEffect(() => {
    if (pandaKey) loadUpcoming();
  }, [pandaKey]);

  // ─── Filtered & Sorted Matches ───────────────────────────────────────────

  const displayMatches = useMemo(() => {
    let filtered = gameFilter === "all" ? upcoming : upcoming.filter(m => m.game === gameFilter);

    if (sortBy === "edge") {
      filtered = [...filtered].sort((a, b) => {
        const predA = predictions[a.id];
        const predB = predictions[b.id];
        const mktA = marketOdds[a.id];
        const mktB = marketOdds[b.id];
        const edgeA = predA && mktA ? Math.abs(predA.probA - mktA.probA) : 0;
        const edgeB = predB && mktB ? Math.abs(predB.probA - mktB.probA) : 0;
        return edgeB - edgeA;
      });
    }
    return filtered;
  }, [upcoming, gameFilter, sortBy, predictions, marketOdds]);

  // ─── Bet Log ─────────────────────────────────────────────────────────────

  const logBet = (match, side, marketProb) => {
    const pred = predictions[match.id];
    if (!pred || pred.error) return;
    const ourProb = side === "A" ? pred.probA : pred.probB;
    const team = side === "A" ? match.teamA : match.teamB;
    setBetLog(prev => [{
      id: Date.now(), matchId: match.id, game: match.game,
      team: team.name, ourProb: ourProb.toFixed(1), marketProb,
      edge: (ourProb - marketProb).toFixed(1),
      kelly: calcKelly(ourProb, marketProb).toFixed(1),
      result: "pending", ts: new Date().toISOString(),
      event: `${match.teamA.acronym} vs ${match.teamB.acronym}`,
      league: match.league,
    }, ...prev]);
  };

  const updateBetResult = (id, result) => setBetLog(p => p.map(b => b.id === id ? { ...b, result } : b));
  const clearBetLog = () => { if (confirm("Clear bet log?")) { setBetLog([]); save("betLog2", []); } };

  const betStats = useMemo(() => {
    const res = betLog.filter(b => b.result !== "pending");
    const w = res.filter(b => b.result === "win").length;
    const l = res.filter(b => b.result === "loss").length;
    return {
      total: betLog.length, wins: w, losses: l,
      pending: betLog.filter(b => b.result === "pending").length,
      hitRate: res.length > 0 ? (w / res.length) * 100 : 0,
    };
  }, [betLog]);

  // ─── Summary Stats ──────────────────────────────────────────────────────

  const summaryStats = useMemo(() => {
    let withEdge = 0;
    let bestEdge = 0;
    let bestEdgeMatch = null;

    upcoming.forEach(m => {
      const pred = predictions[m.id];
      const mkt = marketOdds[m.id];
      if (pred && !pred.error && mkt) {
        const edge = Math.abs(pred.probA - mkt.probA);
        if (edge > 3) withEdge++;
        if (edge > bestEdge) { bestEdge = edge; bestEdgeMatch = m; }
      }
    });

    return { total: upcoming.length, withPredictions: Object.keys(predictions).length, withEdge, bestEdge, bestEdgeMatch };
  }, [upcoming, predictions, marketOdds]);

  // ─── Styles ──────────────────────────────────────────────────────────────

  const inp = {
    padding: "9px 12px", background: PAL.bg, border: `1px solid ${PAL.border}`,
    borderRadius: 6, color: PAL.text, fontSize: 13, fontFamily: "inherit", outline: "none",
  };
  const btnSm = {
    padding: "6px 14px", fontSize: 12, fontWeight: 500, borderRadius: 6,
    border: `1px solid ${PAL.border}`, background: PAL.card, color: PAL.sub,
    cursor: "pointer", fontFamily: "inherit",
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: PAL.bg, color: PAL.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${PAL.faint};border-radius:2px}
        input::placeholder{color:${PAL.dim}}
        input:focus{border-color:${PAL.dim}!important}
      `}</style>

      {/* ═══════════ SIDEBAR ═══════════ */}
      <div style={{
        width: 200, flexShrink: 0, background: PAL.panel, borderRight: `1px solid ${PAL.border}`,
        display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh",
      }}>
        <div style={{ padding: "16px 14px", borderBottom: `1px solid ${PAL.border}` }}>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-0.03em" }}>EDGE</div>
          <div style={{ fontSize: 10, color: PAL.dim, letterSpacing: "0.1em" }}>TERMINAL v2</div>
        </div>

        {/* Game Filter */}
        <div style={{ padding: "10px 8px", borderBottom: `1px solid ${PAL.border}` }}>
          <div style={{ fontSize: 10, color: PAL.dim, fontWeight: 600, letterSpacing: "0.1em", padding: "0 8px", marginBottom: 6 }}>GAMES</div>
          {[
            { id: "all", label: "All Games", color: PAL.purple },
            { id: "csgo", label: "CS2", color: GAME_COLOR.csgo },
            { id: "dota2", label: "Dota 2", color: GAME_COLOR.dota2 },
            { id: "lol", label: "LoL", color: GAME_COLOR.lol },
          ].map(g => (
            <button key={g.id} onClick={() => setGameFilter(g.id)} style={{
              width: "100%", padding: "7px 8px", borderRadius: 6, border: "none",
              background: gameFilter === g.id ? `${g.color}15` : "transparent",
              color: gameFilter === g.id ? g.color : PAL.sub,
              cursor: "pointer", fontSize: 12, fontWeight: gameFilter === g.id ? 600 : 400,
              textAlign: "left", marginBottom: 1, display: "flex", alignItems: "center", gap: 8,
            }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: gameFilter === g.id ? g.color : PAL.dim }} />
              {g.label}
            </button>
          ))}
        </div>

        {/* Views */}
        <div style={{ padding: "10px 8px", flex: 1 }}>
          <div style={{ fontSize: 10, color: PAL.dim, fontWeight: 600, letterSpacing: "0.1em", padding: "0 8px", marginBottom: 6 }}>VIEWS</div>
          {[
            { id: "predictions", label: "Predictions" },
            { id: "log", label: `Bet Log${betLog.length ? ` (${betLog.length})` : ""}` },
            { id: "bot", label: `Bot${botState ? ` $${botState.bankroll?.toFixed(0)}` : ""}` },
            { id: "daily", label: "Daily Recap" },
          ].map(v => (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              width: "100%", padding: "7px 8px", borderRadius: 6, border: "none",
              background: view === v.id ? PAL.card : "transparent",
              color: view === v.id ? PAL.text : PAL.sub,
              cursor: "pointer", fontSize: 12, fontWeight: view === v.id ? 600 : 400,
              textAlign: "left", marginBottom: 1,
              borderLeft: view === v.id ? `2px solid ${PAL.purple}` : "2px solid transparent",
            }}>{v.label}</button>
          ))}
        </div>

        {/* Bottom */}
        <div style={{ padding: "10px 8px", borderTop: `1px solid ${PAL.border}` }}>
          <button onClick={() => setView("settings")} style={{
            width: "100%", padding: "7px 8px", borderRadius: 6,
            border: `1px solid ${pandaKey ? PAL.green + "30" : PAL.border}`,
            background: pandaKey ? `${PAL.green}08` : "transparent",
            color: pandaKey ? PAL.green : PAL.sub,
            cursor: "pointer", fontSize: 11, fontWeight: 500, textAlign: "left",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: pandaKey ? PAL.green : PAL.dim }} />
            {pandaKey ? "API Connected" : "Connect API"}
          </button>
          <div style={{ fontSize: 11, color: PAL.dim, padding: "6px 8px 0", fontFamily: "monospace" }}>
            {clock.toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* ═══════════ MAIN ═══════════ */}
      <div style={{ flex: 1, overflow: "auto", minHeight: "100vh" }}>
        <div style={{ padding: "20px 24px", maxWidth: 1000 }}>

          {/* ─── SETTINGS VIEW ─── */}
          {view === "settings" && (
            <div>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", marginBottom: 16 }}>Settings</h1>
              <div style={{ background: PAL.panel, borderRadius: 10, padding: 20, border: `1px solid ${PAL.border}`, maxWidth: 500 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>PandaScore API Key</div>
                <div style={{ fontSize: 12, color: PAL.sub, marginBottom: 12, lineHeight: 1.6 }}>
                  Free key from pandascore.co — required for all match data and predictions.
                  {pandaKey && <span style={{ color: PAL.green }}> Connected.</span>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="Paste token..." style={{ ...inp, flex: 1 }} />
                  <button onClick={() => { setPandaKey(keyInput); setView("predictions"); }} style={{ ...btnSm, background: `${PAL.green}15`, borderColor: `${PAL.green}30`, color: PAL.green, fontWeight: 600 }}>Save</button>
                </div>
                {pandaKey && (
                  <button onClick={() => { setPandaKey(""); setKeyInput(""); save("pandaKey", ""); }} style={{ ...btnSm, marginTop: 8, color: PAL.red, borderColor: `${PAL.red}25` }}>Disconnect</button>
                )}
              </div>
            </div>
          )}

          {/* ─── NO API KEY ─── */}
          {view === "predictions" && !pandaKey && (
            <div style={{ textAlign: "center", paddingTop: 80 }}>
              <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 8, letterSpacing: "-0.03em" }}>Edge Terminal</div>
              <div style={{ fontSize: 14, color: PAL.sub, marginBottom: 24 }}>Esports prediction engine for CS2, Dota 2, and LoL</div>
              <button onClick={() => setView("settings")} style={{
                padding: "10px 24px", background: `${PAL.purple}15`, border: `1px solid ${PAL.purple}30`,
                borderRadius: 8, color: PAL.purple, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}>Connect PandaScore API to Start</button>
            </div>
          )}

          {/* ─── PREDICTIONS VIEW ─── */}
          {view === "predictions" && pandaKey && (<>

            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", margin: 0 }}>Predictions</h1>
                <p style={{ fontSize: 13, color: PAL.sub, marginTop: 4 }}>
                  {summaryStats.total} upcoming
                  {summaryStats.withEdge > 0 && <span style={{ color: PAL.green }}>{" · "}{summaryStats.withEdge} with edge</span>}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setSortBy(sortBy === "time" ? "edge" : "time")} style={btnSm}>
                  Sort: {sortBy === "time" ? "Time" : "Edge"}
                </button>
                <button onClick={() => { _cache && Object.keys(_cache).forEach(k => delete _cache[k]); setPredictions({}); loadUpcoming(); }} style={btnSm}>
                  Refresh
                </button>
              </div>
            </div>

            {loadingMatches && <Spinner />}
            {errors.general && <ErrBox msg={errors.general} />}

            {!loadingMatches && displayMatches.length === 0 && upcoming.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: PAL.dim, fontSize: 14 }}>
                No upcoming matches found. Try refreshing.
              </div>
            )}

            {!loadingMatches && displayMatches.length === 0 && upcoming.length > 0 && (
              <div style={{ padding: 40, textAlign: "center", color: PAL.dim, fontSize: 14 }}>
                No matches for this game filter.
              </div>
            )}

            {/* Match List */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {displayMatches.map(match => {
                const pred = predictions[match.id];
                const isLoading = loadingPredictions[match.id];
                const isExpanded = expandedMatch === match.id;
                const mkt = marketOdds[match.id];
                const edge = pred && !pred.error && mkt ? pred.probA - mkt.probA : null;
                const gc = GAME_COLOR[match.game];

                return (
                  <div key={match.id}>
                    {/* ─── Match Row ─── */}
                    <div
                      onClick={() => setExpandedMatch(isExpanded ? null : match.id)}
                      style={{
                        display: "grid", gridTemplateColumns: "52px 1fr 200px 80px",
                        padding: "12px 14px", borderRadius: isExpanded ? "10px 10px 0 0" : 10,
                        background: isExpanded ? PAL.card : PAL.panel,
                        border: `1px solid ${isExpanded ? PAL.borderLit : PAL.border}`,
                        borderBottom: isExpanded ? "none" : undefined,
                        cursor: "pointer", alignItems: "center", gap: 12,
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = PAL.card; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = PAL.panel; }}
                    >
                      {/* Game Badge */}
                      <div style={{
                        fontSize: 10, fontWeight: 700, color: gc, background: `${gc}12`,
                        padding: "3px 8px", borderRadius: 4, textAlign: "center", letterSpacing: "0.04em",
                      }}>{GAME_LABEL[match.game]}</div>

                      {/* Teams */}
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>
                          {match.teamA.acronym} <span style={{ color: PAL.dim, fontWeight: 400, fontSize: 12, margin: "0 4px" }}>vs</span> {match.teamB.acronym}
                        </div>
                        <div style={{ fontSize: 11, color: PAL.dim, marginTop: 2 }}>
                          {match.league}{" · "}BO{match.format}
                          {match.scheduledAt && ` · ${new Date(match.scheduledAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                        </div>
                      </div>

                      {/* Prediction Bar */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {isLoading ? (
                          <div style={{ fontSize: 11, color: PAL.dim }}>Analyzing...</div>
                        ) : pred && !pred.error ? (
                          <>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                              <span style={{ fontWeight: 700, color: pred.probA > 50 ? PAL.green : PAL.sub }}>{pred.probA.toFixed(1)}%</span>
                              <span style={{ fontWeight: 700, color: pred.probB > 50 ? PAL.green : PAL.sub }}>{pred.probB.toFixed(1)}%</span>
                            </div>
                            <div style={{ height: 4, borderRadius: 2, background: `${PAL.red}40`, overflow: "hidden" }}>
                              <div style={{ width: `${pred.probA}%`, height: "100%", background: PAL.green, borderRadius: 2, transition: "width 0.3s" }} />
                            </div>
                          </>
                        ) : pred?.error ? (
                          <div style={{ fontSize: 11, color: PAL.red }}>Error</div>
                        ) : null}
                      </div>

                      {/* Edge */}
                      <div style={{ textAlign: "right" }}>
                        {edge !== null ? (
                          <div style={{
                            fontSize: 14, fontWeight: 800,
                            color: Math.abs(edge) > 5 ? PAL.green : Math.abs(edge) > 2 ? PAL.yellow : PAL.dim,
                          }}>
                            {edge > 0 ? "+" : ""}{edge.toFixed(1)}%
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: PAL.dim }}>Set odds</div>
                        )}
                        {edge !== null && Math.abs(edge) > 3 && (
                          <div style={{ fontSize: 9, color: PAL.green, fontWeight: 600, marginTop: 1 }}>EDGE</div>
                        )}
                      </div>
                    </div>

                    {/* ─── Expanded Analysis ─── */}
                    {isExpanded && (
                      <div style={{
                        background: PAL.card, border: `1px solid ${PAL.borderLit}`, borderTop: "none",
                        borderRadius: "0 0 10px 10px", padding: 18,
                      }}>
                        {isLoading && <Spinner />}
                        {pred && !pred.error && (<>

                          {/* Thesis */}
                          <div style={{
                            padding: "12px 14px", background: PAL.panel, borderRadius: 8,
                            borderLeft: `3px solid ${Math.abs(edge || 0) > 3 ? PAL.green : PAL.dim}`,
                            marginBottom: 16, fontSize: 13, color: PAL.sub, lineHeight: 1.6,
                          }}>
                            {generateThesis(match.teamA.acronym, match.teamB.acronym, pred, edge)}
                          </div>

                          {/* Market Odds Input */}
                          <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
                            <span style={{ fontSize: 12, color: PAL.sub }}>Market odds{mkt ? "" : " (no match found)"}:</span>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 11, color: PAL.dim }}>{match.teamA.acronym}</span>
                              <input
                                type="number" min="1" max="99"
                                value={mkt?.probA ?? ""}
                                onChange={e => {
                                  const v = parseFloat(e.target.value);
                                  if (v >= 1 && v <= 99) setMarketOdds(prev => ({ ...prev, [match.id]: { probA: v } }));
                                  else if (e.target.value === "") setMarketOdds(prev => { const n = { ...prev }; delete n[match.id]; return n; });
                                }}
                                placeholder="¢"
                                style={{ ...inp, width: 60, textAlign: "center", fontSize: 14, fontWeight: 700, padding: "6px 8px" }}
                              />
                              <span style={{ fontSize: 11, color: PAL.dim }}>{"¢"}</span>
                            </div>
                            {mkt && (
                              <div style={{ fontSize: 12, color: PAL.sub, marginLeft: 8 }}>
                                {match.teamB.acronym}: {(100 - mkt.probA).toFixed(0)}{"¢"}
                              </div>
                            )}
                          </div>

                          {/* Model Breakdown */}
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                            <TeamBreakdown label={match.teamA.acronym} data={pred.factors.formA} overall={pred.factors.overallA} prob={pred.probA} color={PAL.green} />
                            <TeamBreakdown label={match.teamB.acronym} data={pred.factors.formB} overall={pred.factors.overallB} prob={pred.probB} color={PAL.red} />
                          </div>

                          {/* H2H */}
                          {pred.factors.h2h.matches > 0 && (
                            <div style={{ background: PAL.panel, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
                              <div style={{ fontSize: 11, color: PAL.dim, fontWeight: 600, marginBottom: 6, letterSpacing: "0.06em" }}>HEAD TO HEAD ({pred.factors.h2h.matches} matches)</div>
                              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                <span style={{ fontSize: 14, fontWeight: 700, color: pred.factors.h2h.winRate > 55 ? PAL.green : PAL.sub }}>{match.teamA.acronym}</span>
                                <span style={{ fontSize: 20, fontWeight: 800 }}>{pred.factors.h2h.record}</span>
                                <span style={{ fontSize: 14, fontWeight: 700, color: pred.factors.h2h.winRate < 45 ? PAL.green : PAL.sub }}>{match.teamB.acronym}</span>
                                <div style={{ flex: 1, height: 4, borderRadius: 2, background: `${PAL.red}30`, overflow: "hidden", marginLeft: 12 }}>
                                  <div style={{ width: `${pred.factors.h2h.winRate}%`, height: "100%", background: PAL.green, borderRadius: 2 }} />
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Edge Summary + Bet */}
                          {mkt && (
                            <div style={{
                              display: "grid", gridTemplateColumns: "repeat(4, 1fr) auto", gap: 8,
                              background: PAL.panel, borderRadius: 8, padding: 14,
                            }}>
                              <MiniStat label="Our Model" value={`${pred.probA.toFixed(1)}%`} sub={match.teamA.acronym} color={PAL.text} />
                              <MiniStat label="Market" value={`${mkt.probA}¢`} sub={match.teamA.acronym} color={PAL.sub} />
                              <MiniStat label="Edge" value={`${edge > 0 ? "+" : ""}${edge.toFixed(1)}%`} color={Math.abs(edge) > 3 ? PAL.green : PAL.dim} />
                              <MiniStat label="Kelly" value={`${calcKelly(pred.probA > 50 ? pred.probA : pred.probB, pred.probA > 50 ? mkt.probA : 100 - mkt.probA).toFixed(1)}%`} color={PAL.yellow} />
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "center" }}>
                                {Math.abs(edge) > 2 && (
                                  <>
                                    <button onClick={(e) => { e.stopPropagation(); logBet(match, edge > 0 ? "A" : "B", edge > 0 ? mkt.probA : 100 - mkt.probA); }} style={{
                                      ...btnSm, background: `${PAL.green}15`, borderColor: `${PAL.green}30`,
                                      color: PAL.green, fontWeight: 600, fontSize: 11, padding: "5px 12px",
                                    }}>
                                      Log: {edge > 0 ? match.teamA.acronym : match.teamB.acronym}
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Model Weights */}
                          <div style={{ marginTop: 12, fontSize: 11, color: PAL.dim }}>
                            {"Model weights: Form "}{(pred.factors.weights.form * 100).toFixed(0)}%{" · Overall "}{(pred.factors.weights.overall * 100).toFixed(0)}%{" · H2H "}{(pred.factors.weights.h2h * 100).toFixed(0)}%
                            {pred.factors.format > 1 && ` · BO${pred.factors.format} adjustment applied`}
                            {` · Confidence: ${pred.confidence}`}
                          </div>
                        </>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>)}

          {/* ─── BOT DASHBOARD VIEW ─── */}
          {view === "bot" && (<>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", margin: 0 }}>Paper Trading Bot</h1>
                <p style={{ fontSize: 13, color: PAL.sub, marginTop: 4 }}>
                  {botState ? <>Live dashboard · Auto-refreshes every 30s · Run #{botState.totalRuns || 0}</> : "Connect bot to view dashboard"}
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {botSecret && (
                  <>
                    <button onClick={loadBotState} disabled={botLoading} style={{ ...btnSm, color: PAL.blue, borderColor: `${PAL.blue}30` }}>
                      {botLoading ? "Loading..." : "Refresh"}
                    </button>
                    <button onClick={triggerBotRun} disabled={botRunning} style={{ ...btnSm, background: `${PAL.green}15`, borderColor: `${PAL.green}30`, color: PAL.green, fontWeight: 600 }}>
                      {botRunning ? "Running..." : "Run Now"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Bot Connection */}
            {(!botSecret || !botUrl) && (
              <div style={{ background: PAL.panel, borderRadius: 10, padding: 20, border: `1px solid ${PAL.border}`, maxWidth: 500, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Connect to Bot</div>
                <div style={{ fontSize: 12, color: PAL.sub, marginBottom: 12 }}>
                  Enter your VPS bot URL and secret to view the dashboard.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input value={botUrlInput} onChange={e => setBotUrlInput(e.target.value)} placeholder="http://142.93.228.49:3069" style={{ ...inp }} />
                  <input value={botSecretInput} onChange={e => setBotSecretInput(e.target.value)} placeholder="Bot secret..." style={{ ...inp }} type="password" />
                  <button onClick={() => { setBotUrl(botUrlInput); setBotSecret(botSecretInput); }} style={{ ...btnSm, background: `${PAL.green}15`, borderColor: `${PAL.green}30`, color: PAL.green, fontWeight: 600, alignSelf: "flex-start" }}>Connect</button>
                </div>
              </div>
            )}

            {botSecret && botState && (() => {
              const closed = botState.closedPositions || [];
              const open = botState.openPositions || [];
              const initial = botState.initialBankroll || 1000;
              const pnl = botState.bankroll - initial;
              const roi = (pnl / initial * 100);
              const wins = closed.filter(p => p.result === "win").length;
              const losses = closed.filter(p => p.result === "loss").length;
              const totalResolved = wins + losses;
              const hitRate = totalResolved > 0 ? (wins / totalResolved * 100) : 0;
              const totalPnl = closed.reduce((s, p) => s + (p.pnl || 0), 0);
              const deployed = open.reduce((s, p) => s + p.betSize, 0);
              const avgEdge = closed.length > 0 ? (closed.reduce((s, p) => s + (p.edge || 0), 0) / closed.length) : 0;
              const avgBet = closed.length > 0 ? (closed.reduce((s, p) => s + p.betSize, 0) / closed.length) : 0;
              const bestTrade = closed.length > 0 ? closed.reduce((best, p) => (p.pnl || 0) > (best.pnl || 0) ? p : best, closed[0]) : null;
              const worstTrade = closed.length > 0 ? closed.reduce((worst, p) => (p.pnl || 0) < (worst.pnl || 0) ? p : worst, closed[0]) : null;

              // Current streak
              let streakType = null, streakCount = 0;
              for (const p of closed) {
                if (!streakType) { streakType = p.result; streakCount = 1; }
                else if (p.result === streakType) streakCount++;
                else break;
              }

              // Bankroll history for chart
              const bankrollHistory = (() => {
                const points = [{ label: "Start", bankroll: initial, pnl: 0 }];
                let running = initial;
                const reversed = [...closed].reverse();
                reversed.forEach((p, i) => {
                  running += (p.pnl || 0);
                  const date = p.resolvedAt || p.placedAt;
                  const label = date ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : `#${i + 1}`;
                  points.push({ label, bankroll: +running.toFixed(2), pnl: +(running - initial).toFixed(2), trade: `${p.pick} ${p.result}` });
                });
                // Add current state (includes deployed capital)
                if (open.length > 0) {
                  points.push({ label: "Now", bankroll: +(botState.bankroll + deployed).toFixed(2), pnl: +(botState.bankroll + deployed - initial).toFixed(2), trade: `${open.length} open` });
                }
                return points;
              })();

              // P&L by game
              const gameStats = {};
              closed.forEach(p => {
                const g = p.game || "unknown";
                if (!gameStats[g]) gameStats[g] = { wins: 0, losses: 0, pnl: 0 };
                if (p.result === "win") gameStats[g].wins++;
                else gameStats[g].losses++;
                gameStats[g].pnl += (p.pnl || 0);
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

              // Loss reasons
              const lossReasons = {};
              closed.filter(p => p.lossReason).forEach(p => {
                lossReasons[p.lossReason] = (lossReasons[p.lossReason] || 0) + 1;
              });

              return (<>
              {/* Hero Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 14 }}>
                <div style={{ background: PAL.panel, borderRadius: 10, padding: "16px 18px", border: `1px solid ${PAL.border}` }}>
                  <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 4 }}>Bankroll</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: pnl >= 0 ? PAL.green : PAL.red, lineHeight: 1 }}>${botState.bankroll?.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: PAL.dim, marginTop: 6 }}>${deployed.toFixed(0)} deployed · ${(botState.bankroll + deployed).toFixed(0)} total</div>
                </div>
                <div style={{ background: PAL.panel, borderRadius: 10, padding: "16px 18px", border: `1px solid ${PAL.border}` }}>
                  <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 4 }}>P&L</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: pnl >= 0 ? PAL.green : PAL.red, lineHeight: 1 }}>{pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: pnl >= 0 ? PAL.green : PAL.red, marginTop: 6 }}>{roi >= 0 ? "+" : ""}{roi.toFixed(1)}% ROI</div>
                </div>
                <div style={{ background: PAL.panel, borderRadius: 10, padding: "16px 18px", border: `1px solid ${PAL.border}` }}>
                  <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 4 }}>Record</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: PAL.text, lineHeight: 1 }}>{wins}W - {losses}L</div>
                  <div style={{ fontSize: 12, color: hitRate >= 50 ? PAL.green : PAL.red, marginTop: 6 }}>
                    {hitRate.toFixed(0)}% hit rate
                    {streakCount > 0 && <span style={{ color: PAL.dim }}> · {streakCount}{streakType === "win" ? "W" : "L"} streak</span>}
                  </div>
                </div>
              </div>

              {/* Secondary Stats */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 18 }}>
                <NumCard label="Avg Edge" value={`${avgEdge.toFixed(1)}%`} color={PAL.purple} />
                <NumCard label="Avg Bet" value={`$${avgBet.toFixed(0)}`} color={PAL.sub} />
                <NumCard label="Best Trade" value={bestTrade ? `+$${(bestTrade.pnl || 0).toFixed(0)}` : "-"} color={PAL.green} sub={bestTrade?.pick || ""} />
                <NumCard label="Worst Trade" value={worstTrade ? `$${(worstTrade.pnl || 0).toFixed(0)}` : "-"} color={PAL.red} sub={worstTrade?.pick || ""} />
                <NumCard label="Open" value={open.length} color={PAL.yellow} sub={`/ 5 max · ${(botState.totalRuns || 0)} runs`} />
              </div>

              {/* Bankroll Chart */}
              {bankrollHistory.length > 1 && (
                <div style={{ background: PAL.panel, borderRadius: 10, padding: "14px 14px 8px", border: `1px solid ${PAL.border}`, marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: PAL.sub }}>Bankroll Over Time</div>
                    <div style={{ fontSize: 11, color: PAL.dim }}>Starting: ${initial} · Current: ${(botState.bankroll + deployed).toFixed(0)}</div>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={bankrollHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke={PAL.faint} />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: PAL.dim }} />
                      <YAxis tick={{ fontSize: 10, fill: PAL.dim }} tickFormatter={v => `$${v}`} domain={["dataMin - 50", "dataMax + 50"]} />
                      <Tooltip
                        contentStyle={{ background: PAL.card, border: `1px solid ${PAL.border}`, borderRadius: 6, fontSize: 12 }}
                        formatter={(v, name) => [`$${v}`, name === "bankroll" ? "Bankroll" : "P&L"]}
                        labelFormatter={(label, payload) => payload?.[0]?.payload?.trade ? `${label} — ${payload[0].payload.trade}` : label}
                      />
                      <Area type="monotone" dataKey="bankroll" stroke={pnl >= 0 ? PAL.green : PAL.red} fill={pnl >= 0 ? `${PAL.green}15` : `${PAL.red}15`} strokeWidth={2} dot={{ r: 3, fill: PAL.card, stroke: pnl >= 0 ? PAL.green : PAL.red, strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* P&L by Game */}
              {Object.keys(gameStats).length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${Object.keys(gameStats).length}, 1fr)`, gap: 8, marginBottom: 16 }}>
                  {Object.entries(gameStats).map(([game, stats]) => (
                    <div key={game} style={{ background: PAL.panel, borderRadius: 8, padding: "12px 14px", border: `1px solid ${PAL.border}`, borderTop: `3px solid ${GAME_COLOR[game] || PAL.purple}` }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: GAME_COLOR[game] || PAL.sub, marginBottom: 6 }}>{GAME_LABEL[game] || game}</div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: stats.pnl >= 0 ? PAL.green : PAL.red }}>{stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: PAL.dim, marginTop: 4 }}>{stats.wins}W - {stats.losses}L · {(stats.wins + stats.losses > 0 ? stats.wins / (stats.wins + stats.losses) * 100 : 0).toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Bot vs Market + Loss Analysis */}
              {totalResolved > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                  <div style={{ background: PAL.panel, borderRadius: 10, padding: "14px 18px", border: `1px solid ${PAL.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: PAL.sub }}>Bot vs Market Accuracy</div>
                    <div style={{ display: "flex", gap: 20 }}>
                      <div>
                        <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 2 }}>Bot</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: botRight > mktRight ? PAL.green : PAL.sub }}>
                          {(botRight / totalResolved * 100).toFixed(0)}%
                        </div>
                        <div style={{ fontSize: 11, color: PAL.dim }}>{botRight}/{totalResolved} correct</div>
                      </div>
                      <div style={{ width: 1, background: PAL.border }} />
                      <div>
                        <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 2 }}>Market</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: mktRight > botRight ? PAL.green : PAL.sub }}>
                          {(mktRight / totalResolved * 100).toFixed(0)}%
                        </div>
                        <div style={{ fontSize: 11, color: PAL.dim }}>{mktRight}/{totalResolved} correct</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ background: PAL.panel, borderRadius: 10, padding: "14px 18px", border: `1px solid ${PAL.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: PAL.sub }}>Loss Analysis</div>
                    {Object.keys(lossReasons).length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {Object.entries(lossReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
                          <div key={reason} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontSize: 12, color: PAL.sub }}>{reason}</span>
                            <span style={{ fontSize: 12, fontWeight: 700, color: PAL.red }}>{count}x</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: PAL.dim }}>Loss reasons tracked on new bets</div>
                    )}
                  </div>
                </div>
              )}

              {/* Model Weights + Calibration Row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <div style={{ background: PAL.panel, borderRadius: 10, padding: 14, border: `1px solid ${PAL.border}` }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: PAL.sub }}>Model Weights</div>
                  <div style={{ display: "flex", gap: 16 }}>
                    {Object.entries(botState.modelWeights || {}).filter(([k]) => k !== "formN").map(([k, v]) => (
                      <div key={k} style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 4, textTransform: "capitalize" }}>{k}</div>
                        <div style={{ height: 6, background: PAL.bg, borderRadius: 3, overflow: "hidden" }}>
                          <div style={{ width: `${v * 100}%`, height: "100%", background: k === "form" ? PAL.orange : k === "overall" ? PAL.blue : PAL.purple, borderRadius: 3 }} />
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, color: PAL.text }}>{(v * 100).toFixed(0)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
                {botState.calibration?.totalPredictions > 0 ? (
                  <div style={{ background: PAL.panel, borderRadius: 10, padding: 14, border: `1px solid ${PAL.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: PAL.sub }}>Calibration</div>
                    <div style={{ display: "flex", gap: 16 }}>
                      <div>
                        <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 2 }}>Predictions</div>
                        <div style={{ fontSize: 18, fontWeight: 800 }}>{botState.calibration.totalPredictions}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 2 }}>Accuracy</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: botState.calibration.correctPredictions / botState.calibration.totalPredictions > 0.5 ? PAL.green : PAL.red }}>
                          {(botState.calibration.correctPredictions / botState.calibration.totalPredictions * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                    {Object.keys(botState.calibration.bins || {}).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <ResponsiveContainer width="100%" height={80}>
                          <BarChart data={Object.entries(botState.calibration.bins).map(([bin, d]) => ({ bin, actual: +(d.wins / d.total * 100).toFixed(0) }))}>
                            <XAxis dataKey="bin" tick={{ fontSize: 8, fill: PAL.dim }} />
                            <Bar dataKey="actual" radius={[3, 3, 0, 0]}>
                              {Object.entries(botState.calibration.bins).map(([, ], i) => (
                                <Cell key={i} fill={PAL.purple} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ background: PAL.panel, borderRadius: 10, padding: 14, border: `1px solid ${PAL.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: PAL.dim, fontSize: 12 }}>
                    Calibration data builds after 10+ resolved bets
                  </div>
                )}
              </div>

              {/* Open Positions */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Open Positions ({open.length})</div>
                {open.length === 0 ? (
                  <div style={{ padding: 24, background: PAL.panel, borderRadius: 10, textAlign: "center", color: PAL.dim, border: `1px dashed ${PAL.border}` }}>
                    No open positions. Bot scans every 5 minutes for new opportunities.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {open.map(p => (
                      <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "50px 1fr 70px 70px 60px 60px 80px 32px", padding: "10px 14px", borderRadius: p.thesis ? "8px 8px 0 0" : 8, background: PAL.panel, borderLeft: `3px solid ${p.matchStatus === "live" ? PAL.red : PAL.yellow}`, alignItems: "center", gap: 8, fontSize: 13 }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: GAME_COLOR[p.game] || PAL.sub }}>{GAME_LABEL[p.game] || p.game}</span>
                          {p.matchStatus === "live" && <span style={{ fontSize: 8, fontWeight: 700, color: PAL.red, background: `${PAL.red}20`, padding: "1px 4px", borderRadius: 3 }}>LIVE</span>}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{p.pick}</div>
                          <div style={{ fontSize: 11, color: PAL.dim }}>{p.event} · {p.league}{p.format > 1 ? ` · BO${p.format}` : ""}</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{p.ourProb}%</div>
                          <div style={{ fontSize: 10, color: PAL.dim }}>model</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 12, fontWeight: 700 }}>{p.marketProb}%</div>
                          <div style={{ fontSize: 10, color: PAL.dim }}>market</div>
                        </div>
                        <div style={{ textAlign: "center", fontWeight: 700, color: PAL.green }}>+{p.edge}%</div>
                        <div style={{ textAlign: "center", fontWeight: 600 }}>${p.betSize}</div>
                        <div style={{ fontSize: 10, color: PAL.dim, textAlign: "right" }}>
                          {new Date(p.matchTime).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                          {new Date(p.matchTime).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </div>
                        <div style={{ textAlign: "center" }}>
                          {p.polyUrl && <a href={p.polyUrl} target="_blank" rel="noopener noreferrer" style={{ color: PAL.blue, fontSize: 11, textDecoration: "none" }} title="View on Polymarket">PM</a>}
                        </div>
                      </div>
                      {p.thesis && (
                        <div style={{ padding: "6px 14px 8px", background: PAL.card, borderLeft: `3px solid ${p.matchStatus === "live" ? PAL.red : PAL.yellow}`, borderRadius: "0 0 8px 8px", fontSize: 11, color: PAL.dim, fontStyle: "italic" }}>
                          {p.thesis}
                        </div>
                      )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Trade History */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Trade History ({closed.length})</div>
                  {closed.length > 0 && (
                    <div style={{ fontSize: 11, color: PAL.dim }}>
                      Total P&L:{" "}
                      <span style={{ fontWeight: 700, color: totalPnl >= 0 ? PAL.green : PAL.red }}>
                        {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>
                {closed.length === 0 ? (
                  <div style={{ padding: 24, background: PAL.panel, borderRadius: 10, textAlign: "center", color: PAL.dim, border: `1px dashed ${PAL.border}` }}>
                    No resolved bets yet. The bot will auto-resolve when matches finish.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {/* Header row */}
                    <div style={{ display: "grid", gridTemplateColumns: "46px 1fr 55px 55px 50px 50px 60px 70px 32px", padding: "6px 14px", fontSize: 10, color: PAL.dim, fontWeight: 600, letterSpacing: "0.05em" }}>
                      <span>GAME</span><span>MATCH</span><span style={{ textAlign: "center" }}>MODEL</span><span style={{ textAlign: "center" }}>MKT</span><span style={{ textAlign: "center" }}>EDGE</span><span style={{ textAlign: "center" }}>BET</span><span style={{ textAlign: "center" }}>P&L</span><span style={{ textAlign: "right" }}>DATE</span><span></span>
                    </div>
                    {closed.map(p => (
                      <div key={p.id}>
                        <div style={{ display: "grid", gridTemplateColumns: "46px 1fr 55px 55px 50px 50px 60px 70px 32px", padding: "10px 14px", borderRadius: 8, background: PAL.panel, borderLeft: `3px solid ${p.result === "win" ? PAL.green : PAL.red}`, alignItems: "center", gap: 4, fontSize: 13 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: GAME_COLOR[p.game] || PAL.sub }}>{GAME_LABEL[p.game] || p.game}</span>
                          <div>
                            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                              {p.pick}
                              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: p.result === "win" ? `${PAL.green}20` : `${PAL.red}20`, color: p.result === "win" ? PAL.green : PAL.red }}>{p.result?.toUpperCase()}</span>
                            </div>
                            <div style={{ fontSize: 11, color: PAL.dim }}>{p.event}{p.league ? ` · ${p.league}` : ""}{p.format > 1 ? ` · BO${p.format}` : ""}</div>
                          </div>
                          <div style={{ textAlign: "center", fontSize: 12, fontWeight: 600 }}>{p.ourProb}%</div>
                          <div style={{ textAlign: "center", fontSize: 12, color: PAL.sub }}>{p.marketProb}%</div>
                          <div style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: PAL.green }}>+{p.edge}%</div>
                          <div style={{ textAlign: "center", fontSize: 12 }}>${p.betSize}</div>
                          <div style={{ textAlign: "center", fontWeight: 700, color: (p.pnl || 0) >= 0 ? PAL.green : PAL.red }}>
                            {(p.pnl || 0) >= 0 ? "+" : ""}${(p.pnl || 0).toFixed(2)}
                          </div>
                          <div style={{ fontSize: 10, color: PAL.dim, textAlign: "right" }}>
                            {p.resolvedAt ? new Date(p.resolvedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : p.placedAt ? new Date(p.placedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
                          </div>
                          <div style={{ textAlign: "center" }}>
                            {p.polyUrl && <a href={p.polyUrl} target="_blank" rel="noopener noreferrer" style={{ color: PAL.blue, fontSize: 11, textDecoration: "none" }} title="View on Polymarket">PM</a>}
                          </div>
                        </div>
                        {p.lossReason && (
                          <div style={{ padding: "4px 14px 6px", fontSize: 10, color: PAL.red, fontStyle: "italic", background: `${PAL.red}05`, borderRadius: "0 0 6px 6px", marginTop: -2 }}>
                            Loss reason: {p.lossReason}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Last Run Info */}
              {botState.lastRunAt && (
                <div style={{ marginTop: 16, fontSize: 11, color: PAL.dim, textAlign: "center" }}>
                  Last run: {new Date(botState.lastRunAt).toLocaleString()} · Next scan in ~5 min ·{" "}
                  <button onClick={() => { setBotSecret(""); setBotSecretInput(""); setBotUrl(""); setBotUrlInput(""); save("botSecret", ""); save("botUrl", ""); setBotState(null); }} style={{ background: "none", border: "none", color: PAL.red, cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Disconnect</button>
                </div>
              )}
            </>);
            })()}
          </>)}

          {/* ─── DAILY RECAP VIEW ─── */}
          {view === "daily" && (<>
            <div style={{ marginBottom: 16 }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", margin: 0 }}>Daily Recap</h1>
              <p style={{ fontSize: 13, color: PAL.sub, marginTop: 4 }}>Day-by-day breakdown for content</p>
            </div>

            {botState && (() => {
              const closed = botState.closedPositions || [];
              const open = botState.openPositions || [];
              const initial = botState.initialBankroll || 1000;

              // Group all activity by day
              const dayMap = {};

              // Add closed trades by resolution date
              closed.forEach(p => {
                const d = (p.resolvedAt || p.placedAt || "").slice(0, 10);
                if (!d) return;
                if (!dayMap[d]) dayMap[d] = { resolved: [], placed: [], date: d };
                dayMap[d].resolved.push(p);
              });

              // Add placed date for closed trades too (might differ from resolved date)
              closed.forEach(p => {
                const d = (p.placedAt || "").slice(0, 10);
                if (!d) return;
                if (!dayMap[d]) dayMap[d] = { resolved: [], placed: [], date: d };
                if (!dayMap[d].placed.find(x => x.id === p.id)) dayMap[d].placed.push(p);
              });

              // Add open positions by placed date
              open.forEach(p => {
                const d = (p.placedAt || "").slice(0, 10);
                if (!d) return;
                if (!dayMap[d]) dayMap[d] = { resolved: [], placed: [], date: d };
                if (!dayMap[d].placed.find(x => x.id === p.id)) dayMap[d].placed.push({ ...p, stillOpen: true });
              });

              // Add changelog days even if no trades (e.g. Day 0 — launch day)
              Object.keys(BOT_CHANGELOG).forEach(d => {
                if (!dayMap[d]) dayMap[d] = { resolved: [], placed: [], date: d };
              });

              const days = Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));

              // Running bankroll calc (chronological)
              const chronDays = [...days].reverse();
              let runningBankroll = initial;
              const bankrollByDay = {};
              chronDays.forEach(day => {
                const dayPnl = day.resolved.reduce((s, p) => s + (p.pnl || 0), 0);
                const dayDeployed = day.placed.filter(p => !day.resolved.find(r => r.id === p.id)).reduce((s, p) => s + (p.betSize || 0), 0);
                runningBankroll += dayPnl;
                bankrollByDay[day.date] = { bankroll: runningBankroll, pnl: dayPnl, deployed: dayDeployed };
              });

              if (days.length === 0) return (
                <div style={{ padding: 40, background: PAL.panel, borderRadius: 10, textAlign: "center", color: PAL.dim, border: `1px dashed ${PAL.border}` }}>
                  No trading activity yet. Daily recaps will appear once the bot starts placing bets.
                </div>
              );

              // Overall cumulative stats for header
              const totalDays = days.length;
              const winDays = days.filter(d => d.resolved.reduce((s, p) => s + (p.pnl || 0), 0) > 0).length;
              const lossDays = days.filter(d => d.resolved.length > 0 && d.resolved.reduce((s, p) => s + (p.pnl || 0), 0) <= 0).length;

              return (<>
                {/* Cumulative header */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
                  <NumCard label="Days Active" value={totalDays} color={PAL.purple} />
                  <NumCard label="Green Days" value={winDays} color={PAL.green} sub={`${lossDays} red days`} />
                  <NumCard label="Total Trades" value={closed.length + open.length} color={PAL.text} sub={`${open.length} still open`} />
                  <NumCard label="Current Bankroll" value={`$${botState.bankroll?.toFixed(0)}`} color={botState.bankroll >= initial ? PAL.green : PAL.red} sub={`Started $${initial}`} />
                </div>

                {/* Day-by-day cards */}
                {days.map((day, dayIdx) => {
                  const dayDate = new Date(day.date + "T12:00:00Z");
                  const dateLabel = dayDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                  const isToday = day.date === new Date().toISOString().slice(0, 10);
                  const isYesterday = day.date === new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                  const dayLabel = isToday ? "Today" : isYesterday ? "Yesterday" : dateLabel;

                  const dayResolved = day.resolved;
                  const dayPlaced = day.placed;
                  const dayWins = dayResolved.filter(p => p.result === "win");
                  const dayLosses = dayResolved.filter(p => p.result === "loss");
                  const dayPnl = dayResolved.reduce((s, p) => s + (p.pnl || 0), 0);
                  const dayBetTotal = dayPlaced.reduce((s, p) => s + (p.betSize || 0), 0);
                  const dayAvgEdge = dayPlaced.length > 0 ? dayPlaced.reduce((s, p) => s + (p.edge || 0), 0) / dayPlaced.length : 0;
                  const dayBk = bankrollByDay[day.date] || {};

                  // Games active this day
                  const gamesActive = [...new Set([...dayPlaced, ...dayResolved].map(p => p.game))];

                  // Best and worst trade of the day
                  const bestTrade = dayResolved.length > 0 ? dayResolved.reduce((b, p) => (p.pnl || 0) > (b.pnl || 0) ? p : b, dayResolved[0]) : null;
                  const worstTrade = dayResolved.length > 0 ? dayResolved.reduce((w, p) => (p.pnl || 0) < (w.pnl || 0) ? p : w, dayResolved[0]) : null;

                  // Talking points
                  const talkingPoints = [];

                  // Overall day narrative
                  if (dayResolved.length > 0) {
                    if (dayWins.length > 0 && dayLosses.length === 0) {
                      talkingPoints.push({ icon: "fire", text: `Perfect day — went ${dayWins.length} for ${dayResolved.length}, no losses` });
                    } else if (dayLosses.length > 0 && dayWins.length === 0) {
                      talkingPoints.push({ icon: "skull", text: `Rough day — ${dayLosses.length} loss${dayLosses.length > 1 ? "es" : ""}, nothing hit` });
                    } else if (dayWins.length > dayLosses.length) {
                      talkingPoints.push({ icon: "chart", text: `Positive day — ${dayWins.length}W ${dayLosses.length}L, net ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}` });
                    } else {
                      talkingPoints.push({ icon: "chart", text: `Mixed results — ${dayWins.length}W ${dayLosses.length}L, net ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)}` });
                    }
                  }

                  if (dayPlaced.length > 0 && dayResolved.length === 0) {
                    talkingPoints.push({ icon: "clock", text: `Placed ${dayPlaced.length} new bet${dayPlaced.length > 1 ? "s" : ""} — waiting for results` });
                  }

                  // High conviction plays
                  const highConv = dayPlaced.filter(p => (p.ourProb || 0) >= 70);
                  if (highConv.length > 0) {
                    talkingPoints.push({ icon: "target", text: `${highConv.length} high-conviction play${highConv.length > 1 ? "s" : ""} (70%+ model confidence): ${highConv.map(p => p.pick).join(", ")}` });
                  }

                  // BO1 risk
                  const bo1Plays = dayPlaced.filter(p => p.format === 1);
                  if (bo1Plays.length > 0) {
                    talkingPoints.push({ icon: "warning", text: `${bo1Plays.length} BO1 play${bo1Plays.length > 1 ? "s" : ""} — higher variance, reduced bet sizing` });
                  }

                  // Best trade callout
                  if (bestTrade && (bestTrade.pnl || 0) > 0) {
                    talkingPoints.push({ icon: "trophy", text: `Best trade: ${bestTrade.pick} in ${bestTrade.event} → +$${(bestTrade.pnl || 0).toFixed(2)}` });
                  }

                  // Loss analysis
                  const lossReasons = dayLosses.filter(p => p.lossReason).map(p => p.lossReason);
                  if (lossReasons.length > 0) {
                    const uniqueReasons = [...new Set(lossReasons)];
                    talkingPoints.push({ icon: "analyze", text: `Loss breakdown: ${uniqueReasons.join("; ")}` });
                  }

                  // Model vs market
                  if (dayResolved.length >= 2) {
                    let botRight = 0, mktRight = 0;
                    dayResolved.forEach(p => {
                      if ((p.ourProb > 50) === (p.result === "win")) botRight++;
                      if ((p.marketProb > 50) === (p.result === "win")) mktRight++;
                    });
                    if (botRight !== mktRight) {
                      talkingPoints.push({ icon: "vs", text: `Model ${botRight > mktRight ? "beat" : "lost to"} market today — Bot ${botRight}/${dayResolved.length} vs Market ${mktRight}/${dayResolved.length}` });
                    }
                  }

                  // Edge sizing
                  if (dayAvgEdge > 5) {
                    talkingPoints.push({ icon: "edge", text: `High average edge today: ${dayAvgEdge.toFixed(1)}% — found strong value` });
                  }

                  const tpIcons = { fire: "\u{1F525}", skull: "\u{1F480}", chart: "\u{1F4C8}", clock: "\u23F3", target: "\u{1F3AF}", warning: "\u26A0\uFE0F", trophy: "\u{1F3C6}", analyze: "\u{1F50D}", vs: "\u2694\uFE0F", edge: "\u{1F4A1}" };

                  return (
                    <div key={day.date} style={{ marginBottom: 16, background: PAL.panel, borderRadius: 12, border: `1px solid ${isToday ? PAL.purple + "50" : PAL.border}`, overflow: "hidden" }}>
                      {/* Day Header */}
                      <div style={{
                        padding: "14px 18px", display: "flex", justifyContent: "space-between", alignItems: "center",
                        background: isToday ? `${PAL.purple}08` : "transparent",
                        borderBottom: `1px solid ${PAL.border}`,
                      }}>
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
                            {dayLabel}
                            {isToday && <span style={{ fontSize: 10, fontWeight: 600, color: PAL.purple, background: `${PAL.purple}20`, padding: "2px 8px", borderRadius: 4 }}>LIVE</span>}
                          </div>
                          <div style={{ fontSize: 12, color: PAL.dim, marginTop: 2 }}>
                            {!isToday && !isYesterday && dateLabel}
                            {gamesActive.length > 0 && <> · {gamesActive.map(g => GAME_LABEL[g] || g).join(", ")}</>}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
                          {dayResolved.length > 0 && (
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 20, fontWeight: 800, color: dayPnl >= 0 ? PAL.green : PAL.red }}>
                                {dayPnl >= 0 ? "+" : ""}${dayPnl.toFixed(2)}
                              </div>
                              <div style={{ fontSize: 11, color: PAL.dim }}>{dayWins.length}W - {dayLosses.length}L</div>
                            </div>
                          )}
                          {dayResolved.length === 0 && dayPlaced.length > 0 && (
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: PAL.yellow }}>Pending</div>
                              <div style={{ fontSize: 11, color: PAL.dim }}>{dayPlaced.length} bet{dayPlaced.length > 1 ? "s" : ""} placed</div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Talking Points */}
                      {talkingPoints.length > 0 && (
                        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${PAL.border}`, background: `${PAL.card}` }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: PAL.purple, letterSpacing: "0.1em", marginBottom: 8 }}>TALKING POINTS</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {talkingPoints.map((tp, i) => (
                              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: PAL.sub, lineHeight: 1.5 }}>
                                <span style={{ flexShrink: 0, fontSize: 14 }}>{tpIcons[tp.icon] || "\u2022"}</span>
                                <span>{tp.text}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Bot Updates / Changelog */}
                      {BOT_CHANGELOG[day.date] && (
                        <div style={{ padding: "12px 18px", borderBottom: `1px solid ${PAL.border}`, background: `${PAL.bg}` }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: PAL.orange, letterSpacing: "0.1em", marginBottom: 4 }}>BOT UPDATES</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: PAL.text, marginBottom: 8 }}>{BOT_CHANGELOG[day.date].title}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {BOT_CHANGELOG[day.date].updates.map((u, i) => {
                              const typeColors = {
                                launch: { bg: `${PAL.purple}15`, color: PAL.purple, label: "LAUNCH" },
                                feature: { bg: `${PAL.blue}15`, color: PAL.blue, label: "NEW" },
                                fix: { bg: `${PAL.yellow}15`, color: PAL.yellow, label: "FIX" },
                                model: { bg: `${PAL.green}15`, color: PAL.green, label: "MODEL" },
                                strategy: { bg: `${PAL.orange}15`, color: PAL.orange, label: "STRAT" },
                                result: { bg: `${PAL.red}15`, color: PAL.red, label: "RESULT" },
                                lesson: { bg: `${PAL.purple}15`, color: PAL.purple, label: "LESSON" },
                                infra: { bg: `${PAL.dim}20`, color: PAL.sub, label: "INFRA" },
                              };
                              const tc = typeColors[u.type] || typeColors.feature;
                              return (
                                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
                                  <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: tc.bg, color: tc.color, marginTop: 1 }}>{tc.label}</span>
                                  <span style={{ color: PAL.sub }}>{u.text}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Day's Trades */}
                      <div style={{ padding: "12px 18px" }}>
                        {dayPlaced.length > 0 && (
                          <div style={{ marginBottom: dayResolved.length > 0 && dayPlaced.some(p => !dayResolved.find(r => r.id === p.id)) ? 12 : 0 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: PAL.dim, letterSpacing: "0.1em", marginBottom: 6 }}>
                              {dayPlaced.some(p => p.stillOpen) ? "OPEN POSITIONS" : "TRADES"}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {dayPlaced.map(p => {
                                const resolved = dayResolved.find(r => r.id === p.id);
                                const isOpen = p.stillOpen || (!resolved && !closed.find(c => c.id === p.id));
                                return (
                                  <div key={p.id} style={{
                                    display: "grid", gridTemplateColumns: "44px 1fr 60px 60px 50px 55px 70px",
                                    padding: "8px 12px", borderRadius: 6,
                                    background: PAL.bg,
                                    borderLeft: `3px solid ${resolved ? (resolved.result === "win" ? PAL.green : PAL.red) : isOpen ? PAL.yellow : PAL.dim}`,
                                    alignItems: "center", gap: 6, fontSize: 12,
                                  }}>
                                    <span style={{ fontSize: 10, fontWeight: 700, color: GAME_COLOR[p.game] || PAL.sub }}>{GAME_LABEL[p.game] || p.game}</span>
                                    <div>
                                      <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
                                        {p.pick}
                                        {resolved && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: resolved.result === "win" ? `${PAL.green}20` : `${PAL.red}20`, color: resolved.result === "win" ? PAL.green : PAL.red }}>{resolved.result?.toUpperCase()}</span>}
                                        {isOpen && <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: `${PAL.yellow}20`, color: PAL.yellow }}>OPEN</span>}
                                      </div>
                                      <div style={{ fontSize: 11, color: PAL.dim }}>{p.event}{p.format > 1 ? ` · BO${p.format}` : " · BO1"}</div>
                                    </div>
                                    <div style={{ textAlign: "center" }}>
                                      <div style={{ fontWeight: 600 }}>{p.ourProb}%</div>
                                      <div style={{ fontSize: 9, color: PAL.dim }}>model</div>
                                    </div>
                                    <div style={{ textAlign: "center" }}>
                                      <div style={{ color: PAL.sub }}>{p.marketProb}%</div>
                                      <div style={{ fontSize: 9, color: PAL.dim }}>market</div>
                                    </div>
                                    <div style={{ textAlign: "center", fontWeight: 600, color: PAL.green, fontSize: 12 }}>+{p.edge}%</div>
                                    <div style={{ textAlign: "center", fontWeight: 600, fontSize: 12 }}>${p.betSize}</div>
                                    <div style={{ textAlign: "right", fontWeight: 700, fontSize: 12, color: resolved ? ((resolved.pnl || 0) >= 0 ? PAL.green : PAL.red) : PAL.dim }}>
                                      {resolved ? `${(resolved.pnl || 0) >= 0 ? "+" : ""}$${(resolved.pnl || 0).toFixed(2)}` : "—"}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Thesis breakdown per trade */}
                        {dayPlaced.filter(p => p.thesis).length > 0 && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: PAL.dim, letterSpacing: "0.1em", marginBottom: 6 }}>MODEL REASONING</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              {dayPlaced.filter(p => p.thesis).map(p => (
                                <div key={p.id + "_thesis"} style={{
                                  padding: "8px 12px", background: PAL.bg, borderRadius: 6,
                                  borderLeft: `3px solid ${PAL.purple}`,
                                }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3, color: PAL.text }}>{p.pick} — {p.event}</div>
                                  <div style={{ fontSize: 11, color: PAL.dim, lineHeight: 1.5, fontStyle: "italic" }}>{p.thesis}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Day bankroll state */}
                        {dayBk.bankroll && (
                          <div style={{ marginTop: 10, padding: "8px 12px", background: PAL.bg, borderRadius: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                            <span style={{ color: PAL.dim }}>End of day bankroll</span>
                            <span style={{ fontWeight: 700, color: dayBk.bankroll >= initial ? PAL.green : PAL.red }}>${dayBk.bankroll.toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>);
            })()}

            {!botState && (
              <div style={{ padding: 30, background: PAL.panel, borderRadius: 10, border: `1px dashed ${botError ? PAL.red + "50" : PAL.border}` }}>
                {botLoading ? (
                  <div style={{ textAlign: "center", color: PAL.dim }}>Loading bot state...</div>
                ) : botError ? (
                  <>
                    <div style={{ color: PAL.red, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>⚠ Bot connection failed</div>
                    <div style={{ color: PAL.sub, fontSize: 12, marginBottom: 12, fontFamily: "monospace", background: PAL.bg, padding: 10, borderRadius: 6 }}>{botError}</div>
                    <div style={{ color: PAL.dim, fontSize: 11, lineHeight: 1.6 }}>
                      Bot URL: <code>{botUrl}</code><br/>
                      Via proxy: <code>/api/bot-proxy</code><br/>
                      Check: (1) VPS bot is running, (2) port 3069 is open to all incoming, (3) bot secret matches
                    </div>
                    <button onClick={loadBotState} style={{ ...btnSm, marginTop: 12, color: PAL.blue, borderColor: `${PAL.blue}30` }}>Retry</button>
                  </>
                ) : (
                  <div style={{ textAlign: "center", color: PAL.dim }}>Connect to the bot to see daily recaps. Go to the Bot view first.</div>
                )}
              </div>
            )}
          </>)}

          {/* ─── BET LOG VIEW ─── */}
          {view === "log" && (<>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
              <div>
                <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", margin: 0 }}>Bet Log</h1>
                <p style={{ fontSize: 13, color: PAL.sub, marginTop: 4 }}>Model performance tracking</p>
              </div>
              {betLog.length > 0 && (
                <button onClick={clearBetLog} style={{ ...btnSm, color: PAL.red, borderColor: `${PAL.red}22` }}>Clear</button>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
              <NumCard label="Total Bets" value={betStats.total} color={PAL.text} />
              <NumCard label="Win Rate" value={`${betStats.hitRate.toFixed(1)}%`} color={betStats.hitRate > 55 ? PAL.green : betStats.hitRate > 45 ? PAL.yellow : PAL.red} sub={`${betStats.wins}W / ${betStats.losses}L`} />
              <NumCard label="Pending" value={betStats.pending} color={PAL.yellow} />
              <NumCard label="Edge Avg" value={betLog.length > 0 ? `${(betLog.reduce((s, b) => s + parseFloat(b.edge), 0) / betLog.length).toFixed(1)}%` : "-"} color={PAL.purple} />
            </div>

            {betLog.length === 0 ? (
              <div style={{ padding: 40, background: PAL.panel, borderRadius: 10, textAlign: "center", color: PAL.dim, border: `1px dashed ${PAL.border}` }}>
                No bets logged. Set market odds on a prediction, then click "Log" when you spot edge.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {betLog.map(b => (
                  <div key={b.id} style={{
                    display: "grid", gridTemplateColumns: "50px 1fr 80px 80px 60px 130px",
                    padding: "10px 14px", borderRadius: 8, background: PAL.panel,
                    borderLeft: `3px solid ${b.result === "win" ? PAL.green : b.result === "loss" ? PAL.red : PAL.yellow}`,
                    alignItems: "center", gap: 8, fontSize: 13,
                  }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: GAME_COLOR[b.game] || PAL.sub }}>{GAME_LABEL[b.game] || b.game}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{b.team}</div>
                      <div style={{ fontSize: 11, color: PAL.dim }}>{b.event}{" · "}{b.league}</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{b.ourProb}%</div>
                      <div style={{ fontSize: 10, color: PAL.dim }}>model</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 700 }}>{b.marketProb}{"¢"}</div>
                      <div style={{ fontSize: 10, color: PAL.dim }}>market</div>
                    </div>
                    <div style={{ textAlign: "center", fontWeight: 700, color: parseFloat(b.edge) > 0 ? PAL.green : PAL.red }}>
                      {parseFloat(b.edge) > 0 ? "+" : ""}{b.edge}%
                    </div>
                    <div style={{ display: "flex", gap: 3 }}>
                      {["win", "loss", "push"].map(r => (
                        <button key={r} onClick={() => updateBetResult(b.id, r)} style={{
                          padding: "4px 10px", fontSize: 10, fontWeight: b.result === r ? 700 : 400,
                          background: b.result === r ? (r === "win" ? PAL.green : r === "loss" ? PAL.red : PAL.yellow) : PAL.card,
                          color: b.result === r ? PAL.bg : PAL.dim,
                          border: `1px solid ${b.result === r ? "transparent" : PAL.border}`,
                          borderRadius: 4, cursor: "pointer", textTransform: "uppercase", fontFamily: "inherit",
                        }}>{r}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>)}

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function TeamBreakdown({ label, data, overall, prob, color }) {
  return (
    <div style={{ background: PAL.panel, borderRadius: 8, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{label}</span>
        <span style={{ fontSize: 20, fontWeight: 800, color: prob > 50 ? PAL.green : PAL.sub }}>{prob.toFixed(1)}%</span>
      </div>
      <div style={{ fontSize: 12, color: PAL.sub, marginBottom: 4 }}>
        Recent: <span style={{ fontWeight: 600, color: PAL.text }}>{data.record}</span>
        <span style={{ color: PAL.dim }}> ({data.winRate.toFixed(0)}% weighted)</span>
      </div>
      <div style={{ fontSize: 12, color: PAL.sub, marginBottom: 8 }}>
        Overall: <span style={{ fontWeight: 600, color: PAL.text }}>{overall.record}</span>
        <span style={{ color: PAL.dim }}> ({overall.winRate.toFixed(0)}%)</span>
      </div>
      {data.streak && data.streak.count > 1 && (
        <div style={{ fontSize: 11, color: data.streak.type === "W" ? PAL.green : PAL.red, fontWeight: 600 }}>
          {data.streak.count}{data.streak.type} streak
        </div>
      )}
      {data.results && data.results.length > 0 && (
        <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
          {data.results.map((r, i) => (
            <div key={i} style={{
              width: 16, height: 16, borderRadius: 3, fontSize: 9, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: r === "W" ? `${PAL.green}20` : `${PAL.red}20`,
              color: r === "W" ? PAL.green : PAL.red,
            }}>{r}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function NumCard({ label, value, color, sub }) {
  return (
    <div style={{ background: PAL.panel, borderRadius: 8, padding: "12px 14px", border: `1px solid ${PAL.border}` }}>
      <div style={{ fontSize: 11, color: PAL.dim, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || PAL.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: PAL.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, sub, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: PAL.dim, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || PAL.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: PAL.dim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
      <div style={{ width: 20, height: 20, border: `2px solid ${PAL.border}`, borderTopColor: PAL.sub, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
    </div>
  );
}

function ErrBox({ msg, retry }) {
  return (
    <div style={{ padding: 14, background: `${PAL.red}08`, borderLeft: `3px solid ${PAL.red}`, borderRadius: 6, margin: "8px 0" }}>
      <div style={{ fontSize: 13, color: PAL.red, fontWeight: 600 }}>{msg}</div>
      {retry && <button onClick={retry} style={{ marginTop: 6, fontSize: 12, padding: "5px 14px", background: `${PAL.red}12`, border: `1px solid ${PAL.red}25`, borderRadius: 6, color: PAL.red, cursor: "pointer", fontFamily: "inherit" }}>Retry</button>}
    </div>
  );
}
