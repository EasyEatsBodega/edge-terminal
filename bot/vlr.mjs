// ═══════════════════════════════════════════════════════════════════════════════
// VLR.gg — Valorant rankings scraper
// ═══════════════════════════════════════════════════════════════════════════════
// VLR.gg is the HLTV of Valorant — the canonical source for pro team rankings,
// stats, and match data. They maintain regional rankings (Americas, EMEA,
// Pacific, China, East Asia) which we merge into a global list by points.
//
// Why we need this:
//   Our PandaScore W/L model can't see agent pool diversity, map pool gaps,
//   or that "beating 5 tier-3 teams" ≠ "beating 5 tier-1 teams". VLR's
//   points system captures all of that via head-to-head results across the
//   pro circuit.
//
// We cache 12h (rankings move slowly) and scrape politely with a browser UA.
//
// Usage mirrors hltv.mjs:
//   const rank = await getVlrRank("Sentinels");   // { rank, points, region }
//   const delta = await getVlrRankDelta("SEN", "LOUD");  // numeric
// ═══════════════════════════════════════════════════════════════════════════════

let _cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const REGIONS = ["americas", "emea", "pacific", "east-asia", "china"];

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "en-US,en;q=0.9",
};

// ─── Scraper ─────────────────────────────────────────────────────────────

// Parse one region's ranking page. Returns array of { name, points, region }.
async function fetchRegion(region) {
  try {
    const r = await fetch(`https://www.vlr.gg/rankings/${region}`, { headers: BROWSER_HEADERS });
    if (!r.ok) return [];
    const html = await r.text();
    const teams = [];

    // VLR ranking rows live inside table rows with class "rank-item-...".
    // Primary parser: match team name + points pair within each row.
    const rowRe = /<tr[^>]*class="[^"]*rank-item[^"]*"[\s\S]*?<\/tr>/g;
    const rows = html.match(rowRe) || [];
    for (const row of rows) {
      // Team name often in <div class="ge-text-light"> or a link title
      const nameMatch = row.match(/class="[^"]*ge-text-light[^"]*"[^>]*>([^<]+)</)
                     || row.match(/class="[^"]*rank-item-team[^"]*"[\s\S]*?>([A-Za-z0-9][^<]{1,40})</);
      const pointsMatch = row.match(/(\d+)\s*(?:pts?|pt)\b/i)
                       || row.match(/>(\d{3,4})<\/td>/);
      if (nameMatch && pointsMatch) {
        const name = nameMatch[1].trim();
        const points = parseInt(pointsMatch[1], 10);
        if (name && points && points < 10000) {
          teams.push({ name, points, region, normName: norm(name) });
        }
      }
    }

    // Fallback: simpler name+points extraction if the primary parser finds nothing.
    if (teams.length === 0) {
      const simpleRe = /<a[^>]+href="\/team\/[^"]+"[^>]*>[\s\S]*?<div[^>]*>([A-Za-z0-9][^<]{1,40})<\/div>[\s\S]*?(\d{3,4})\s*(?:pts?|pt)/g;
      let m;
      while ((m = simpleRe.exec(html)) !== null && teams.length < 50) {
        teams.push({
          name: m[1].trim(),
          points: parseInt(m[2], 10),
          region,
          normName: norm(m[1]),
        });
      }
    }

    return teams;
  } catch (e) {
    console.error(`VLR ${region} fetch error:`, e.message);
    return [];
  }
}

// Fetch all regions, merge, assign global rank by points. Cached 12h.
async function fetchVlrRankings() {
  const now = Date.now();
  if (_cache.data && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.data;
  }

  const regions = await Promise.all(REGIONS.map(fetchRegion));
  const all = regions.flat();

  // De-duplicate by normalized name (a team might appear in 2 region pages
  // when transferring — keep the highest point count).
  const dedup = new Map();
  for (const t of all) {
    const existing = dedup.get(t.normName);
    if (!existing || t.points > existing.points) dedup.set(t.normName, t);
  }

  // Assign global ranks by points descending
  const ranked = [...dedup.values()]
    .sort((a, b) => b.points - a.points)
    .map((t, i) => ({ ...t, rank: i + 1 }));

  _cache = { data: ranked, fetchedAt: now };
  return ranked;
}

// ─── Public API (same shape as hltv.mjs) ─────────────────────────────────

export async function getVlrRank(teamName) {
  const rankings = await fetchVlrRankings();
  if (!rankings.length) return null;
  const target = norm(teamName);
  if (!target) return null;
  let hit = rankings.find(t => t.normName === target);
  if (hit) return { rank: hit.rank, points: hit.points, region: hit.region };
  if (target.length >= 4) {
    hit = rankings.find(t => t.normName.startsWith(target) || target.startsWith(t.normName));
    if (hit) return { rank: hit.rank, points: hit.points, region: hit.region };
  }
  if (target.length >= 5) {
    hit = rankings.find(t => t.normName.includes(target) || target.includes(t.normName));
    if (hit) return { rank: hit.rank, points: hit.points, region: hit.region };
  }
  return null;
}

// Returns positive if A is ranked better (lower rank number), negative if B.
export async function getVlrRankDelta(teamA, teamB) {
  const [a, b] = await Promise.all([getVlrRank(teamA), getVlrRank(teamB)]);
  if (!a && !b) return 0;
  // One ranked, other unranked = ranked team favored
  if (a && !b) return Math.min(30, 30 - a.rank);
  if (!a && b) return -Math.min(30, 30 - b.rank);
  return b.rank - a.rank;
}

// Convert rank delta to probability adjustment. Mirrors HLTV's formula but
// capped at ±12% (VLR rankings mix regions with different skill floors, so
// the signal is slightly noisier than HLTV's unified global rank).
export function vlrRankDeltaToProbAdjust(delta) {
  if (!delta) return 0;
  const sign = delta > 0 ? 1 : -1;
  const magnitude = Math.min(Math.abs(delta), 30);
  return sign * Math.min(12, Math.sqrt(magnitude) * 2.5);
}

export async function isVlrAvailable() {
  const rankings = await fetchVlrRankings();
  return rankings.length > 0;
}
