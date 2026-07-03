# Rewind — the timeline like it used to be

A personalized Bluesky custom feed that recreates the **mid-2010s Twitter home
timeline**: posts from people you follow ranked by likes and friendship, a
"several people you follow just liked this" discovery lane, and **zero reward
for arguments**.

Built from the primary sources: Twitter's 2017 timeline-ranking engineering
post and the open-sourced legacy Earlybird ranker (`like=30, retweet=20,
reply=1`). The 2019+ ranker that Threads imitates weights a reply at 13.5–27×
a like — that's the dunk machine, and this feed inverts it. See
[docs/DESIGN.md](docs/DESIGN.md) for the research and full scoring model.

## How it ranks

Page 1 opens with a ranked **"while you were away" block** (~15 posts), then
everything else is reverse-chronological (including your follows' reposts):

```
score = affinity × (1 + engagement / author_baseline) × boosts × ratio_guard × decay
```

- **Engagement**: `30·likes + 20·reposts + 1·replies` — likes matter, arguments don't
- **Author baseline**: normalized by each author's typical engagement, so a
  small account's banger beats a celebrity's shrug
- **Affinity**: authors you like often (from your own public like history) float up
- **Ratio guard**: replies ≥ 10 and > 2× likes → suppressed. Dunks don't spread here
- **Boosts**: media ×1.15, self-thread roots ×1.25 (advice threads live!)
- **Decay**: 6h half-life over a 48h window; bare replies never appear
- **MagicRecs**: up to 3 out-of-network posts per block, only when ≥3 people
  you follow liked the same post within 6h

All knobs live in [src/scoring.ts](src/scoring.ts).

## Run it

```bash
cp .env.example .env   # set FEEDGEN_HOSTNAME
npm install
npm test
npm run dev            # starts ingesting Jetstream + serving on :3000
```

The service needs a public HTTPS hostname (reverse proxy via Caddy/nginx, or a
Cloudflare Tunnel). It serves its own `did:web` document at
`/.well-known/did.json`.

## Publish the feed to your account

```bash
BLUESKY_HANDLE=you.bsky.social BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx npm run publish-feed
# then put the printed FEEDGEN_PUBLISHER_DID in .env and restart
```

Open the printed `bsky.app` link, pin the feed, done.

## Notes

- First request from a new viewer takes a few seconds (fetching their follows
  and like history); afterwards it's cached 12h and refreshed in the background.
- Storage is a rolling 48h SQLite window — single-digit GB, prunes hourly.
- Discovery (MagicRecs) warms up as the feed learns which accounts are
  followed by its viewers; expect it to kick in within a few hours of first use.
- Fits comfortably on a $5–10/mo VPS.
