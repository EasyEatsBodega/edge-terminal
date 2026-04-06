# Edge Terminal — Esports Betting Analytics

Live esports betting analytics dashboard with real API integrations for Dota 2, CS2, and League of Legends.

## Live APIs

| Game | Source | Auth | Status |
|------|--------|------|--------|
| Dota 2 | OpenDota API | None (free) | ✅ Works out of the box |
| CS2 | PandaScore API | Free API key | Needs key from pandascore.co |
| LoL | PandaScore API | Free API key | Needs key from pandascore.co |

## Features

- **Pro Match Feed** — Real-time pro match results with full detail (drafts, gold graphs, player stats)
- **Draft Analyzer** — Pick heroes, fetches real hero-vs-hero matchup data, calculates win probability with counter/synergy scores
- **Hero Meta Scanner** — Every hero ranked by edge score (win rate adjusted for pick volume)
- **Odds Comparison Engine** — Enter odds from multiple books, calculates EV, edge, and Kelly sizing
- **CS2 & LoL Feeds** — Upcoming and recent matches via PandaScore

## Deploy to Vercel

### Option A: Vercel CLI (fastest)

```bash
# 1. Install Vercel CLI
npm i -g vercel

# 2. From the project root:
vercel

# 3. Follow the prompts. Done.
```

### Option B: GitHub → Vercel (auto-deploys on push)

```bash
# 1. Create a GitHub repo
gh repo create edge-terminal --public --source=. --push

# Or manually:
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/edge-terminal.git
git push -u origin main

# 2. Go to vercel.com/new
# 3. Import your GitHub repo
# 4. Framework: Vite
# 5. Deploy
```

## Local Development

```bash
npm install
npm run dev
```

Opens at http://localhost:5173

## Build

```bash
npm run build
```

Output goes to `dist/` folder.
