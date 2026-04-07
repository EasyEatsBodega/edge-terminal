#!/usr/bin/env node
// One-time script to restore the 0-3 record from the old broken edge logic
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, "state.json");

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf-8")) : {
  bankroll: 1000,
  initialBankroll: 1000,
  openPositions: [],
  closedPositions: [],
  modelWeights: { form: 0.45, overall: 0.35, h2h: 0.15, formN: 10 },
  calibration: { totalPredictions: 0, correctPredictions: 0, bins: {} },
  lastRunAt: null,
  totalRuns: 0,
};

// Restore the 3 original losses from the broken edge logic
const originalLosses = [
  {
    id: "bet_orig_1", matchId: 1413588, game: "csgo",
    teamA: "Keyd", teamB: "CRASH", teamAId: 129633, teamBId: 133727,
    pick: "CRASH", pickSide: "B",
    ourProb: 54.2, marketProb: 50.0, edge: 4.2,
    betSize: 20, betPercent: 2.0, confidence: "medium",
    event: "Keyd vs CRASH", league: "CCT South America", format: 3,
    placedAt: "2025-04-07T02:00:00.000Z", matchTime: "2025-04-07T03:00:00.000Z",
    result: "loss", pnl: -20, resolvedAt: "2025-04-07T06:00:00.000Z",
  },
  {
    id: "bet_orig_2", matchId: 1421626, game: "csgo",
    teamA: "ZOMB", teamB: "LAG", teamAId: 134560, teamBId: 133120,
    pick: "ZOMB", pickSide: "A",
    ourProb: 52.8, marketProb: 50.0, edge: 2.8,
    betSize: 10, betPercent: 1.0, confidence: "low",
    event: "ZOMB vs LAG", league: "CCT South America", format: 3,
    placedAt: "2025-04-07T02:00:00.000Z", matchTime: "2025-04-07T04:00:00.000Z",
    result: "loss", pnl: -10, resolvedAt: "2025-04-07T07:00:00.000Z",
  },
  {
    id: "bet_orig_3", matchId: 1431971, game: "csgo",
    teamA: "REGAIN", teamB: "InC", teamAId: 135890, teamBId: 134200,
    pick: "InC", pickSide: "B",
    ourProb: 53.5, marketProb: 50.0, edge: 3.5,
    betSize: 15, betPercent: 1.5, confidence: "medium",
    event: "REGAIN vs InC", league: "CCT South America", format: 3,
    placedAt: "2025-04-07T02:00:00.000Z", matchTime: "2025-04-07T05:00:00.000Z",
    result: "loss", pnl: -15, resolvedAt: "2025-04-07T08:00:00.000Z",
  },
];

// Add to closed positions (avoid duplicates)
const existingIds = new Set((state.closedPositions || []).map(p => p.id));
for (const loss of originalLosses) {
  if (!existingIds.has(loss.id)) {
    state.closedPositions.push(loss);
  }
}

// Adjust bankroll to reflect the losses
state.bankroll = 1000 - 45; // $1000 - $45 total losses = $955
state.initialBankroll = 1000;

// Update calibration
state.calibration.totalPredictions = (state.calibration.totalPredictions || 0) + 3;
// All 3 were losses, so no correctPredictions added

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
console.log("✅ Restored 0-3 record. Bankroll: $955. State saved.");
console.log("Closed positions:", state.closedPositions.length);
