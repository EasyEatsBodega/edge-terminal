// ═══════════════════════════════════════════════════════════════════════════════
// OpenDota — Dota 2 team ratings + recent form
// ═══════════════════════════════════════════════════════════════════════════════
// OpenDota (opendota.com) is the Dota 2 equivalent of HLTV. It maintains an
// Elo-style rating for every pro team, computed from their actual match
// results across all leagues. This captures strength signals our PandaScore
// W/L record misses (opponent quality, international vs regional, patch era).
//
// Free public API, no auth required. Rate limit: 60/min, we cache 6h.
//
// Key endpoint: GET /api/teams
//   Returns: [{ team_id, name, tag, rating, wins, losses, last_match_time }]
//   `rating` is Elo-like (1000-1800 typical range for pro teams).
//
// Usage:
//   import { getOpenDotaRating, getOpenDotaRatingDelta } from "./opendota.mjs";
//   const a = await getOpenDotaRating("Team Spirit");     // { rating: 1654, wins, losses }
//   const delta = await getOpenDotaRatingDelta("T1", "Gaimin Gladiators"); // numeric
// ═══════════════════════════════════════════════════════════════════════════════

let _cache = { teams: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — team ratings change slowly

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ─── Fetch ────────────────────────────────────────────────────────────────

async function fetchOpenDotaTeams() {
  const now = Date.now();
  if (_cache.teams && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.teams;
  }
  try {
    const r = await fetch("https://api.opendota.com/api/teams", {
      headers: { "User-Agent": "edge-terminal/1.0" },
    });
    if (!r.ok) throw new Error(`OpenDota ${r.status}`);
    const data = await r.json();
    // OpenDota returns teams already sorted by rating (best first).
    // Filter out teams that haven't played recently (inactive teams pollute matching)
    const sixMonthsAgo = (Date.now() - 180 * 86400000) / 1000;
    const teams = data
      .filter(t => t && t.name && (!t.last_match_time || t.last_match_time > sixMonthsAgo))
      .map(t => ({
        team_id: t.team_id,
        name: t.name,
        tag: t.tag || "",
        rating: Math.round(t.rating || 0),
        wins: t.wins || 0,
        losses: t.losses || 0,
        lastMatch: t.last_match_time,
        normName: norm(t.name),
        normTag: norm(t.tag),
      }));
    _cache = { teams, fetchedAt: now };
    return teams;
  } catch (e) {
    console.error("OpenDota fetch error:", e.message);
    return _cache.teams || [];
  }
}

// ─── Matching ────────────────────────────────────────────────────────────

// Match a PandaScore team name against OpenDota's team list.
// Returns the matched team object or null.
function matchTeam(teams, pandaName) {
  const target = norm(pandaName);
  if (!target) return null;

  // Exact name or tag match
  let hit = teams.find(t => t.normName === target || t.normTag === target);
  if (hit) return hit;

  // Prefix/suffix match on name (>= 4 chars to avoid matching "ti" to everything)
  if (target.length >= 4) {
    hit = teams.find(t => t.normName.startsWith(target) || target.startsWith(t.normName));
    if (hit) return hit;
    hit = teams.find(t => t.normName.endsWith(target) || target.endsWith(t.normName));
    if (hit) return hit;
  }

  // Substring match (last resort)
  if (target.length >= 5) {
    hit = teams.find(t => t.normName.includes(target) || target.includes(t.normName));
    if (hit) return hit;
  }

  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────

// Get OpenDota rating + W/L for a team. Returns null if team isn't in the
// active pro scene (i.e. inactive > 6mo or never in the list).
export async function getOpenDotaRating(teamName) {
  const teams = await fetchOpenDotaTeams();
  if (!teams.length) return null;
  const hit = matchTeam(teams, teamName);
  if (!hit || !hit.rating) return null;
  return { rating: hit.rating, wins: hit.wins, losses: hit.losses, team_id: hit.team_id };
}

// Elo-expected win probability for team A vs team B. Returns a percentage 0-100.
// Standard Elo formula with K=400 (Dota convention). Returns null if either
// team is missing a rating.
function eloExpected(ratingA, ratingB) {
  if (!ratingA || !ratingB) return null;
  const diff = ratingA - ratingB;
  return 100 / (1 + Math.pow(10, -diff / 400));
}

// Get the rating delta between two teams as an Elo-expected probability
// deviation from 50%. Positive means team A is favored.
//   Example: A=1700, B=1500 → Elo says A wins 76% → returns +26
// Returns 0 if data is missing for either team.
export async function getOpenDotaRatingDelta(teamA, teamB) {
  const [a, b] = await Promise.all([getOpenDotaRating(teamA), getOpenDotaRating(teamB)]);
  if (!a && !b) return 0;
  // If only one team is rated, they likely have an edge (pro vs non-pro-list)
  if (a && !b) return Math.min(15, (a.rating - 1200) / 30); // up to +15 for top team
  if (!a && b) return -Math.min(15, (b.rating - 1200) / 30);

  const eloExp = eloExpected(a.rating, b.rating);
  if (eloExp == null) return 0;
  return eloExp - 50; // deviation from coinflip
}

// Convert the rating delta (Elo expected - 50) into a probability adjustment.
// We dampen the signal since Elo alone is a noisy single-factor; the W/L-based
// base model captures a lot of the same info. This prevents double-counting.
// Max adjustment: ±12%.
export function ratingDeltaToProbAdjust(delta) {
  if (!delta) return 0;
  const sign = delta > 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(delta), 30);
  // Dampened linear: 0.4 weight, capped ±12
  return sign * Math.min(12, magnitude * 0.4);
}

export async function isOpenDotaAvailable() {
  const teams = await fetchOpenDotaTeams();
  return teams.length > 0;
}
