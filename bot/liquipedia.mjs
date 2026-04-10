// ═══════════════════════════════════════════════════════════════════════════════
// LIQUIPEDIA — Roster change detection
// ═══════════════════════════════════════════════════════════════════════════════
// Liquipedia is the definitive esports wiki — it tracks every roster change,
// stand-in, coach swap, and tournament result. The #1 thing our W/L model
// doesn't know is: "did this team just change players?" A team with a
// stand-in plays WAY worse than their historical form suggests.
//
// Liquipedia has strict API rate limits (2s between requests, User-Agent
// required). We cache aggressively (24h per team) and only check teams we
// care about betting on.
//
// Usage:
//   import { hasRecentRosterChange } from "./liquipedia.mjs";
//   const { changed, daysAgo } = await hasRecentRosterChange("FaZe", "csgo");
//   if (changed && daysAgo < 14) skip();
// ═══════════════════════════════════════════════════════════════════════════════

// Per-team cache: { teamName: { result, fetchedAt } }
const _cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ROSTER_CHANGE_WINDOW_DAYS = 14; // Recent = within 14 days

// Liquipedia requires User-Agent with contact info per their ToS
const USER_AGENT = "EdgeTerminal/1.0 (paper trading bot; +https://edge-terminal.vercel.app)";

// Rate limiter — Liquipedia asks for 2s between requests to the MediaWiki API
let lastFetchAt = 0;
async function rateLimit() {
  const now = Date.now();
  const wait = Math.max(0, 2000 - (now - lastFetchAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetchAt = Date.now();
}

// Map our game identifiers to Liquipedia wiki subdomains
const WIKI_BY_GAME = {
  csgo: "counterstrike",
  dota2: "dota2",
  lol: "leagueoflegends",
  valorant: "valorant",
};

// Fetch a team page's parsed wikitext to look for roster change markers.
// Liquipedia pages have "{{Transfer" templates and section headers like
// "Timeline" that document every roster move with dates.
async function fetchTeamPage(teamName, game) {
  const wiki = WIKI_BY_GAME[game];
  if (!wiki) return null;
  await rateLimit();

  try {
    // MediaWiki API: parse page content, return wikitext
    const url = `https://liquipedia.net/${wiki}/api.php?action=parse&page=${encodeURIComponent(teamName)}&prop=wikitext&format=json`;
    const r = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.parse?.wikitext?.["*"] || null;
  } catch (e) {
    return null;
  }
}

// Parse the team page wikitext for recent roster changes.
// Looks for transfer templates with dates in the last 14 days.
function findRecentRosterChanges(wikitext) {
  if (!wikitext) return { changed: false, daysAgo: null };

  const now = Date.now();
  const windowMs = ROSTER_CHANGE_WINDOW_DAYS * 86400000;
  let mostRecentChange = null;

  // Pattern 1: Transfer templates — {{Transfer|date=YYYY-MM-DD|...}}
  const transferRe = /\{\{Transfer[^}]*?date\s*=\s*(\d{4}-\d{2}-\d{2})/gi;
  let m;
  while ((m = transferRe.exec(wikitext)) !== null) {
    const date = new Date(m[1]);
    if (!isNaN(date.getTime())) {
      const age = now - date.getTime();
      if (age < windowMs && (!mostRecentChange || age < mostRecentChange)) {
        mostRecentChange = age;
      }
    }
  }

  // Pattern 2: Section header "Current Roster" or "Active Roster" followed by
  // a "|join_date_=" near the top (most recent entries are listed first)
  const joinDateRe = /\|\s*join_?date\s*=\s*(\d{4}-\d{2}-\d{2})/gi;
  let count = 0;
  while ((m = joinDateRe.exec(wikitext)) !== null && count < 10) {
    const date = new Date(m[1]);
    if (!isNaN(date.getTime())) {
      const age = now - date.getTime();
      if (age < windowMs && (!mostRecentChange || age < mostRecentChange)) {
        mostRecentChange = age;
      }
    }
    count++;
  }

  if (mostRecentChange === null) return { changed: false, daysAgo: null };
  return {
    changed: true,
    daysAgo: Math.floor(mostRecentChange / 86400000),
  };
}

// Main API: has this team had a roster change in the last 14 days?
export async function hasRecentRosterChange(teamName, game) {
  const cacheKey = `${game}::${teamName}`;
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.result;
  }

  const wikitext = await fetchTeamPage(teamName, game);
  const result = findRecentRosterChanges(wikitext);
  _cache.set(cacheKey, { result, fetchedAt: Date.now() });
  return result;
}

// Check both teams in a match. Returns { skip, reason } — skip=true means
// the bot should avoid this match entirely.
export async function checkMatchRosters(teamAName, teamBName, game) {
  try {
    const [a, b] = await Promise.all([
      hasRecentRosterChange(teamAName, game),
      hasRecentRosterChange(teamBName, game),
    ]);
    if (a.changed && a.daysAgo < 7) {
      return { skip: true, reason: `${teamAName} roster change ${a.daysAgo}d ago` };
    }
    if (b.changed && b.daysAgo < 7) {
      return { skip: true, reason: `${teamBName} roster change ${b.daysAgo}d ago` };
    }
    // 7-14 days ago: warning but don't skip
    if (a.changed || b.changed) {
      return { skip: false, warn: true, reason: "Recent roster change in last 2 weeks" };
    }
    return { skip: false };
  } catch {
    return { skip: false }; // Fail open — if Liquipedia is down, don't block bets
  }
}
