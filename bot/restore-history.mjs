#!/usr/bin/env node
// One-time script — sets EXACT state. No merging, no reading old state.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "state.json");

// The 3 original losses from the broken edge logic (v1 bot, wrong-side picks)
// Plus the PNG.A loss from today (new filters, legit loss)
// Total closed P&L: -57.72 - 51.44 - 47.00 - 80.00 = -$236.16
// Bankroll: $1000 - $236.16 = $763.84

const state = {
  bankroll: 763.84,
  initialBankroll: 1000,
  openPositions: [],
  closedPositions: [
    {
      id: "bet_v2_png", matchId: 0, game: "csgo",
      teamA: "EST", teamB: "PNG.A",
      pick: "PNG.A", pickSide: "B",
      ourProb: 58.0, marketProb: 50.0, edge: 8.0,
      betSize: 80, betPercent: 8.0, confidence: "medium",
      event: "EST vs PNG.A", league: "", format: 3,
      placedAt: "2026-04-07T20:00:00.000Z", matchTime: "2026-04-07T21:00:00.000Z",
      result: "loss", pnl: -80.00, resolvedAt: "2026-04-07T22:30:00.000Z",
    },
    {
      id: "bet_orig_1", matchId: 1413588, game: "csgo",
      teamA: "Keyd", teamB: "CRASH", teamAId: 129633, teamBId: 133727,
      pick: "CRASH", pickSide: "B",
      ourProb: 54.2, marketProb: 50.0, edge: 4.2,
      betSize: 20, betPercent: 2.0, confidence: "medium",
      event: "Keyd vs CRASH", league: "CCT South America", format: 3,
      placedAt: "2026-04-07T02:00:00.000Z", matchTime: "2026-04-07T03:00:00.000Z",
      result: "loss", pnl: -57.72, resolvedAt: "2026-04-07T06:00:00.000Z",
    },
    {
      id: "bet_orig_2", matchId: 1421626, game: "csgo",
      teamA: "ZOMB", teamB: "LAG", teamAId: 134560, teamBId: 133120,
      pick: "ZOMB", pickSide: "A",
      ourProb: 52.8, marketProb: 50.0, edge: 2.8,
      betSize: 10, betPercent: 1.0, confidence: "low",
      event: "ZOMB vs LAG", league: "CCT South America", format: 3,
      placedAt: "2026-04-07T02:00:00.000Z", matchTime: "2026-04-07T04:00:00.000Z",
      result: "loss", pnl: -51.44, resolvedAt: "2026-04-07T07:00:00.000Z",
    },
    {
      id: "bet_orig_3", matchId: 1431971, game: "csgo",
      teamA: "REGAIN", teamB: "InC", teamAId: 135890, teamBId: 134200,
      pick: "InC", pickSide: "B",
      ourProb: 53.5, marketProb: 50.0, edge: 3.5,
      betSize: 15, betPercent: 1.5, confidence: "medium",
      event: "REGAIN vs InC", league: "CCT South America", format: 3,
      placedAt: "2026-04-07T02:00:00.000Z", matchTime: "2026-04-07T05:00:00.000Z",
      result: "loss", pnl: -47.00, resolvedAt: "2026-04-07T08:00:00.000Z",
    },
  ],
  modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
  calibration: { totalPredictions: 4, correctPredictions: 0, bins: {} },
  lastRunAt: new Date().toISOString(),
  totalRuns: 67,
};

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log("✅ State set. 0W-4L record. Bankroll: $763.84. P&L: -$236.16");
