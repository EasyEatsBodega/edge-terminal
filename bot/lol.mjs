// ═══════════════════════════════════════════════════════════════════════════════
// LoL — Patch-aware prediction helpers
// ═══════════════════════════════════════════════════════════════════════════════
// League of Legends patches every ~2 weeks, and meta shifts wreck historical
// form: a team that was 8-2 on patch 15.4 may struggle on patch 15.5 because
// their comp picks got nerfed. Our base model treats every past match equally,
// which is why LoL predictions drift out of date faster than CS2 or Dota 2.
//
// Oracle's Elixir is the canonical pro LoL data source but they distribute
// data as multi-MB CSVs updated daily — heavy for a bot that runs every 5
// minutes. The actionable signal their data provides is patch-awareness:
// filter team history to the current patch before computing form.
//
// This module provides that directly:
//   1. Current patch version from Riot's free ddragon API
//   2. Approximate patch release date (Wednesdays, every ~14 days)
//   3. History filter that keeps only matches on the current patch (with a
//      prior-patch fallback if the team has too few current-patch games)
//
// Usage in computePrediction (LoL only):
//   const patch = await getCurrentLolPatch();
//   const filtered = filterToCurrentPatch(teamHistory, patch);
// ═══════════════════════════════════════════════════════════════════════════════

let _cache = { patch: null, fetchedAt: 0 };
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — Riot only rotates versions on patch day

// Known anchor: patch 15.5 dropped ~March 12 2026 (Wed, 2-week cadence).
// Used to extrapolate approximate release date for any numeric patch.
// Each minor-version bump = +14 days from this anchor.
const PATCH_ANCHOR_VERSION = "15.5";
const PATCH_ANCHOR_DATE = Date.parse("2026-03-12T12:00:00Z");
const PATCH_INTERVAL_MS = 14 * 86400000;

// ─── Fetch current LoL patch from Riot's ddragon ─────────────────────────

// Returns { version: "15.5.1", minor: "15.5", releaseDate: Date }. Cached 6h.
// Falls back to a sensible default if ddragon is unreachable.
export async function getCurrentLolPatch() {
  const now = Date.now();
  if (_cache.patch && (now - _cache.fetchedAt) < CACHE_TTL_MS) return _cache.patch;

  try {
    const r = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
    if (!r.ok) throw new Error(`ddragon ${r.status}`);
    const versions = await r.json();
    const version = versions[0]; // ddragon sorts latest first
    if (!version) throw new Error("no versions returned");

    // "15.5.1" → minor = "15.5"
    const minor = version.split(".").slice(0, 2).join(".");
    const releaseDate = estimatePatchReleaseDate(minor);

    const patch = { version, minor, releaseDate };
    _cache = { patch, fetchedAt: now };
    return patch;
  } catch (e) {
    console.error("LoL patch fetch error:", e.message);
    // Fallback: assume most recent patch dropped ~7 days ago
    if (_cache.patch) return _cache.patch;
    return {
      version: "unknown",
      minor: "unknown",
      releaseDate: new Date(now - 7 * 86400000),
    };
  }
}

// Estimate release date for a minor patch by extrapolating from anchor.
// "15.5" → anchor, "15.6" → anchor + 14d, "15.7" → anchor + 28d, etc.
function estimatePatchReleaseDate(minorVersion) {
  const [season, patch] = minorVersion.split(".").map(Number);
  const [anchorSeason, anchorPatch] = PATCH_ANCHOR_VERSION.split(".").map(Number);
  if (isNaN(season) || isNaN(patch)) return new Date(PATCH_ANCHOR_DATE);

  // Rough patch count from anchor (~26 patches per season)
  const patchDelta = (season - anchorSeason) * 26 + (patch - anchorPatch);
  return new Date(PATCH_ANCHOR_DATE + patchDelta * PATCH_INTERVAL_MS);
}

// ─── History filtering ───────────────────────────────────────────────────

// Filter team match history to only include matches on or after the current
// patch's release date. If fewer than minKeep matches survive, include
// previous-patch matches too (better some data than none).
//
// Works with the result objects built in computePrediction (they have a
// `daysAgo` field we can convert back to an absolute timestamp, or we can
// rely on the original m.scheduled_at if passed raw matches).
export function filterToCurrentPatch(historyWithDaysAgo, patchReleaseDate, minKeep = 4) {
  if (!historyWithDaysAgo || !historyWithDaysAgo.length) return historyWithDaysAgo;
  const nowMs = Date.now();
  const patchMs = patchReleaseDate.getTime();
  const daysSincePatch = Math.max(0, (nowMs - patchMs) / 86400000);

  const currentPatch = historyWithDaysAgo.filter(r => r.daysAgo <= daysSincePatch);

  // Not enough current-patch data — fall back to current + previous patch
  // (double the window) so the model isn't starved of signal.
  if (currentPatch.length < minKeep) {
    const extendedWindow = daysSincePatch + 14; // one more patch cycle back
    return historyWithDaysAgo.filter(r => r.daysAgo <= extendedWindow);
  }

  return currentPatch;
}

// Returns { current: number, total: number, patch: string } describing how
// many of a team's recent matches are on the current patch. Used for thesis
// output so we can show "5-1 on current patch (8-4 overall)".
export function patchBreakdown(historyWithDaysAgo, patch) {
  if (!historyWithDaysAgo || !historyWithDaysAgo.length) return null;
  const daysSincePatch = Math.max(0, (Date.now() - patch.releaseDate.getTime()) / 86400000);
  const current = historyWithDaysAgo.filter(r => r.daysAgo <= daysSincePatch);
  return {
    currentPatchGames: current.length,
    currentPatchWins: current.filter(r => r.won).length,
    totalGames: historyWithDaysAgo.length,
    totalWins: historyWithDaysAgo.filter(r => r.won).length,
    patch: patch.minor,
  };
}
