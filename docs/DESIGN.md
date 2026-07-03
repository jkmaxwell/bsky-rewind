# Rewind — a mid-2010s Twitter-style personalized feed for Bluesky

## Goal

A Bluesky custom feed that recreates the 2015–2017 Twitter home timeline: posts from
people you follow ranked by likes/reposts and your affinity for the author, a
MagicRecs-style discovery lane ("3+ people you follow just liked this"), and an
explicit refusal to reward reply-driven engagement (the 2019+ "dunk" mechanic).

Grounded in primary sources: Twitter's 2017 "Using Deep Learning at Scale in
Twitter's Timelines" engineering post, the open-sourced Earlybird ranker weights
(fav=30, retweet=20, reply=1), and the 2023 heavy-ranker weights we deliberately
invert (reply=13.5–27x a like, reply-engaged-by-author=75x).

## Architecture

Single Node/TypeScript process on one VPS:

```
Jetstream (posts, likes, reposts) ──> ingest ──> SQLite (rolling 48h window)
                                                    │
Bluesky AppView ── getFeedSkeleton(viewer JWT) ──> feed algo ──> ranked skeleton
                                                    │
public.api.bsky.app / viewer's PDS  <── follows + like-history fetch (cached 12h)
```

- **Ingest** (`src/jetstream.ts`, `src/ingest.ts`): consumes Jetstream
  (`app.bsky.feed.post|like|repost`). All posts are indexed (uri, author, timestamps,
  media flag, reply linkage, engagement counters). Likes/reposts are stored
  row-level only when the actor is in the "relevant DID" set (union of all
  subscribers' follow graphs) — that's what MagicRecs and repost injection need.
  Aggregate like/repost/reply counters are updated on the post rows for all events.
- **Viewer state** (`src/viewer.ts`): per requesting DID, fetch + cache (12h TTL):
  follow list (public AppView `getFollows`) and affinity map (the viewer's own
  `app.bsky.feed.like` records read from their PDS; the liked-post author is in the
  subject URI, so no extra lookups).
- **Feed algorithm** (`src/feed.ts`): "recap + chronological", the era's defining
  shape. Page 1 opens with a ranked block (top ~15 scored posts, including up to 3
  MagicRecs injections), then reverse-chronological follows-only posts (including
  their reposts, with proper `reason`) below and on all subsequent pages.

## Scoring (src/scoring.ts)

```
score = affinity × (1 + normalized_engagement) × boosts × ratio_guard × time_decay
```

- `engagement_raw = 30·likes + 20·reposts + 1·replies` (Earlybird weights)
- `normalized_engagement = raw / (author_avg_engagement + 5)` — small accounts'
  unusually good posts beat celebrities' average ones (documented 2016 signal)
- `affinity = min(1 + 0.6·log2(1 + viewer_likes_of_author), 4)` — friends first
- boosts: media ×1.15 (documented 2016 signal), self-thread root ×1.25 (advice
  threads)
- **ratio guard**: replies ≥ 10 and replies > 2×likes → ×0.15. Dunked-on posts and
  argument bait get suppressed, not amplified.
- time decay: half-life 6h over a 48h candidate window
- bare replies never enter the feed; only roots and self-thread roots
- MagicRecs lane: out-of-network post where ≥3 of the viewer's follows liked it
  within 6h, scored by distinct-liker count, capped at 3 per ranked block

## What we deliberately do NOT do

- No reply-count reward (weight 1 vs. like 30 — inverted from 2023 Twitter/Threads)
- No out-of-network content except network-burst MagicRecs
- No global trending / virality sourcing
- No "conversation" optimization of any kind

## Ops

- SQLite (better-sqlite3, WAL), hourly pruning of rows older than 48h
- Jetstream cursor persisted; reconnect with replay
- JWT verified via @atproto/xrpc-server + IdResolver; unauthenticated requests get
  a generic (no-affinity) ranked feed
- Serves `/.well-known/did.json` (did:web), `describeFeedGenerator`, health check
- Fits a $5–10/mo VPS; single-digit GB disk
