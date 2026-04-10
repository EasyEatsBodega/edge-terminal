// ═══════════════════════════════════════════════════════════════════════════════
// HLTV — Counter-Strike rankings scraper
// ═══════════════════════════════════════════════════════════════════════════════
// HLTV (hltv.org) is the authoritative source for CS2 team rankings.
// This module scrapes the public rankings page and provides team-name-to-rank
// lookups. Results are cached aggressively (12h) to be polite + fast.
//
// Why we need this:
//   Our base model was 0-6 on CS2 because it only knew recent W/L. HLTV
//   rankings capture everything our model misses — roster strength, map
//   pool, consistency, international performance.
//
// Usage:
//   import { getHltvRank, getHltvRankDelta } from "./hltv.mjs";
//   const rankA = await getHltvRank("FaZe");    // => { rank: 3, points: 903 }
//   const delta = await getHltvRankDelta("FaZe", "NAVI"); // => -2 (FaZe better)
// ═══════════════════════════════════════════════════════════════════════════════

let _cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Normalize a team name for matching (lowercase, strip non-alphanumeric)
function norm(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Fetch + parse HLTV top 30 rankings page.
// Returns an array of { rank, name, points, country } sorted by rank.
async function fetchHltvRankings() {
  const now = Date.now();
  if (_cache.data && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.data;
  }

  try {
    const r = await fetch("https://www.hltv.org/ranking/teams/", {
      headers: {
        // HLTV blocks default Node user agents. Pretend to be a browser.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) throw new Error(`HLTV ${r.status}`);
    const html = await r.text();

    // Parse team rows. HLTV's structure: each team is in a div.ranked-team
    // with a .position (rank), .name (team name), and .points.
    const teams = [];
    const re = /<div class="ranked-team[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let m;
    while ((m = re.exec(html)) !== null && teams.length < 50) {
      const block = m[1];
      const rankMatch = block.match(/class="position">#?(\d+)</);
      const nameMatch = block.match(/class="name">([^<]+)</) ||
                        block.match(/class="teamLine[^"]*">\s*<span[^>]*>([^<]+)/);
      const pointsMatch = block.match(/\((\d+)\s*points?\)/i);
      if (rankMatch && nameMatch) {
        teams.push({
          rank: parseInt(rankMatch[1], 10),
          name: nameMatch[1].trim(),
          points: pointsMatch ? parseInt(pointsMatch[1], 10) : null,
          normName: norm(nameMatch[1]),
        });
      }
    }

    // Fallback parser: if the above regex didn't match (HLTV changes layout),
    // try a simpler extraction of any "class=\"teamLine\"" blocks.
    if (teams.length === 0) {
      const simpleRe = /class="teamLine[^"]*"[\s\S]*?<span[^>]*class="name"[^>]*>([^<]+)<\/span>[\s\S]*?\((\d+)\s*points?\)/g;
      let sm;
      let rank = 1;
      while ((sm = simpleRe.exec(html)) !== null && teams.length < 50) {
        teams.push({
          rank: rank++,
          name: sm[1].trim(),
          points: parseInt(sm[2], 10),
          normName: norm(sm[1]),
        });
      }
    }

    _cache = { data: teams, fetchedAt: now };
    return teams;
  } catch (e) {
    console.error("HLTV fetch error:", e.message);
    // Return stale cache if available, empty otherwise
    return _cache.data || [];
  }
}

// Look up a team's HLTV ranking by name. Fuzzy match against the top 30.
// Returns { rank, points } if found, null if unranked.
export async function getHltvRank(teamName) {
  const rankings = await fetchHltvRankings();
  if (!rankings.length) return null;
  const target = norm(teamName);
  if (!target) return null;
  // Exact match first
  let hit = rankings.find(t => t.normName === target);
  if (hit) return { rank: hit.rank, points: hit.points };
  // Partial match (one is substring of the other)
  hit = rankings.find(t => t.normName.includes(target) || target.includes(t.normName));
  if (hit) return { rank: hit.rank, points: hit.points };
  return null;
}

// Get ranking delta between two teams. Returns positive if team A is ranked
// BETTER (lower rank number), negative if B is better, 0 if equal or unknown.
// Range roughly -30 to +30.
export async function getHltvRankDelta(teamA, teamB) {
  const [a, b] = await Promise.all([getHltvRank(teamA), getHltvRank(teamB)]);
  if (!a && !b) return 0;
  // If only one team is ranked, they're likely favored (top 30 vs unranked)
  if (a && !b) return 30 - a.rank;      // +a team: advantage scaling with rank
  if (!a && b) return -(30 - b.rank);   // b team: advantage
  return b.rank - a.rank; // lower rank # = better, so positive = a is better
}

// Convert rank delta to a probability adjustment (-15 to +15)
// Used as a direct prob modifier in the prediction model.
export function rankDeltaToProbAdjust(delta) {
  if (!delta) return 0;
  // Logarithmic scaling — being #1 vs #5 is bigger than #25 vs #29
  const sign = delta > 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(delta), 30);
  // Max adjust: ±15%. At delta 30 (ranked vs unranked), max pull.
  return sign * Math.min(15, Math.sqrt(magnitude) * 3);
}

// Health check: is HLTV data available?
export async function isHltvAvailable() {
  const rankings = await fetchHltvRankings();
  return rankings.length > 0;
}
