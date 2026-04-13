// ─── Pinnacle Odds Scraper ─────────────────────────────────────────────────
//
// Pinnacle is the sharpest esports bookmaker in the world. Their lines are
// treated as "true probabilities" by professional bettors because (1) they
// accept sharp action without limiting and (2) they take huge volume which
// forces their lines to be efficient.
//
// We use Pinnacle odds as a third data point alongside our model and
// Polymarket. When all three agree, high confidence. When Pinnacle disagrees
// with Polymarket, the Polymarket side is usually the mispriced one.
//
// Source: guest.api.arcadia.pinnacle.com — same API that powers pinnacle.com
// public matchup pages. No auth required, just a browser-like User-Agent.

const PIN_BASE = "https://guest.api.arcadia.pinnacle.com/0.1";
const PIN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  "X-API-Key": "CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R", // Public key used by pinnacle.com frontend
  "Accept": "application/json",
  "Referer": "https://www.pinnacle.com/",
  "Origin": "https://www.pinnacle.com",
};

// Pinnacle sport/league IDs for esports. Sport ID 12 = Esports parent.
// Individual esport league IDs are not strictly needed — fetching all
// esports matchups at once is fine.
const ESPORTS_SPORT_ID = 12;

// ─── Fetch ───────────────────────────────────────────────────────────────

// Fetch all current esports matchups (games + leagues) from Pinnacle.
// Returns array of matchup objects with participants, leagueId, starts, etc.
export async function fetchPinnacleEsportsMatchups() {
  try {
    const r = await fetch(`${PIN_BASE}/sports/${ESPORTS_SPORT_ID}/matchups?withSpecials=false&brandId=0`, {
      headers: PIN_HEADERS,
    });
    if (!r.ok) return [];
    const data = await r.json();
    // Arcadia returns an array of matchup objects directly
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("Pinnacle matchups fetch failed:", e.message);
    return [];
  }
}

// Fetch moneyline markets for a given matchup ID. Returns array of markets.
export async function fetchPinnacleMatchupMarkets(matchupId) {
  try {
    const r = await fetch(`${PIN_BASE}/matchups/${matchupId}/markets/related/straight`, {
      headers: PIN_HEADERS,
    });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

// Batch fetch moneyline for an array of matchup IDs with a concurrency limit
// to avoid hammering Pinnacle. Returns a Map of matchupId → moneyline market.
export async function fetchPinnacleMoneylines(matchupIds, concurrency = 5) {
  const result = new Map();
  const queue = [...matchupIds];

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      if (id == null) continue;
      const markets = await fetchPinnacleMatchupMarkets(id);
      // Find the moneyline (match winner) market, period 0 = full match
      const ml = markets.find(m => m.type === "moneyline" && m.period === 0);
      if (ml) result.set(id, ml);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

// ─── Odds helpers ────────────────────────────────────────────────────────

// Convert American/decimal odds to implied probability, then de-vig a pair.
// Pinnacle returns decimal odds in `prices`. No-vig prob = (1/oddsA) / (1/oddsA + 1/oddsB).
function deVig(oddsA, oddsB) {
  if (!oddsA || !oddsB || oddsA <= 1 || oddsB <= 1) return null;
  const implA = 1 / oddsA;
  const implB = 1 / oddsB;
  const total = implA + implB;
  if (total <= 0) return null;
  return {
    probA: +(implA / total * 100).toFixed(2),
    probB: +(implB / total * 100).toFixed(2),
    vig: +((total - 1) * 100).toFixed(2),
  };
}

// ─── Matching ────────────────────────────────────────────────────────────

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function nameScore(target, candidate) {
  if (!target || !candidate) return 0;
  if (target === candidate) return 100;
  const shorter = Math.min(target.length, candidate.length);
  const longer = Math.max(target.length, candidate.length);
  if (shorter < 3) return 0;
  if (shorter / longer < 0.3) return 0;
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 85;
  if (candidate.endsWith(target) || target.endsWith(candidate)) return 75;
  if (candidate.includes(target) || target.includes(candidate)) return 60;
  return 0;
}

// Find the Pinnacle matchup for a given team pair. Returns the matchup
// object or null. Uses the same fuzzy name matching as Polymarket so
// acronym/full-name variants all resolve.
export function matchPinnacleMatchup(matchups, teamA, teamB) {
  const a = norm(teamA);
  const b = norm(teamB);
  if (!a || !b) return null;

  let best = null;
  let bestScore = 120; // require both participants to score >=60 each

  for (const m of matchups) {
    if (!m.participants || m.participants.length < 2) continue;
    // Pinnacle matchups can be "2-way" (match winner) — we only want those
    if (m.units && m.units !== "Corners" && m.type !== "matchup") continue;

    const p1 = norm(m.participants[0]?.name);
    const p2 = norm(m.participants[1]?.name);

    // Try A=p1, B=p2 and A=p2, B=p1
    const s1 = nameScore(a, p1) + nameScore(b, p2);
    const s2 = nameScore(a, p2) + nameScore(b, p1);
    const score = Math.max(s1, s2);

    if (score > bestScore) {
      bestScore = score;
      best = { ...m, _aIsFirst: s1 >= s2 };
    }
  }

  return best;
}

// Given a matched Pinnacle matchup and its moneyline market, extract
// de-vigged probabilities oriented to match teamA/teamB order.
export function extractPinnacleProbs(matchup, moneylineMarket) {
  if (!moneylineMarket || !moneylineMarket.prices) return null;
  const prices = moneylineMarket.prices;
  if (prices.length < 2) return null;

  // prices is an array of { designation: "home"|"away", price: decimalOdds } or
  // sometimes { participantId, price }. We map by array order since the
  // participants array in the matchup is ordered matching the prices.
  const oddsHome = prices.find(p => p.designation === "home")?.price || prices[0]?.price;
  const oddsAway = prices.find(p => p.designation === "away")?.price || prices[1]?.price;

  const devigged = deVig(oddsHome, oddsAway);
  if (!devigged) return null;

  // Reorient so probA matches teamA (our side A)
  const probA = matchup._aIsFirst ? devigged.probA : devigged.probB;
  const probB = matchup._aIsFirst ? devigged.probB : devigged.probA;

  return {
    probA: +probA.toFixed(1),
    probB: +probB.toFixed(1),
    vig: devigged.vig,
    oddsHome,
    oddsAway,
    matchupId: matchup.id,
  };
}

// ─── Top-level convenience ───────────────────────────────────────────────

// Fetch all esports matchups + their moneyline markets, returning a list
// ready to be matched against PandaScore team pairs. Caller passes this
// list to `matchPinnacle` for each match they care about.
export async function fetchPinnacleAllEsports() {
  const matchups = await fetchPinnacleEsportsMatchups();
  if (matchups.length === 0) return { matchups: [], odds: new Map() };

  // Only fetch markets for matchups with valid participants (skip parent nodes)
  const matchupIds = matchups
    .filter(m => m.participants && m.participants.length === 2 && m.type === "matchup")
    .map(m => m.id);

  const odds = await fetchPinnacleMoneylines(matchupIds, 5);
  return { matchups, odds };
}

// Find pinnacle probs for a given team pair from a pre-fetched dataset.
export function matchPinnacle(pinData, teamA, teamB) {
  if (!pinData || !pinData.matchups) return null;
  const matchup = matchPinnacleMatchup(pinData.matchups, teamA, teamB);
  if (!matchup) return null;
  const ml = pinData.odds.get(matchup.id);
  if (!ml) return null;
  return extractPinnacleProbs(matchup, ml);
}
