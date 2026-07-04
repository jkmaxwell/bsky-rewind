/**
 * Offline evaluation of The Algorithm against ground truth: the viewer's own
 * public likes. Measures whether the ranker surfaces the posts the viewer
 * went on to like, and diagnoses why each miss was buried.
 *
 * Usage: npx tsx scripts/eval.ts <did-or-handle> [windowHours=24]
 *
 * Caveat: scores use engagement counts as of eval time, not as of the moment
 * the feed would have served the post. Fresh-post misses are judged slightly
 * unfairly; treat trends across runs as the signal, not single numbers.
 */
import { IdResolver, MemoryCache } from '@atproto/identity'
import { openDb } from '../src/db.js'
import { Ingestor } from '../src/ingest.js'
import { ViewerStore } from '../src/viewer.js'
import { FeedAlgo, type ScoredCandidate } from '../src/feed.js'
import { fetchRecentLikes, hydratePosts } from '../src/appview.js'
import { WEIGHTS, affinity, engagementRaw, ratioGuard, timeDecay } from '../src/scoring.js'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npx tsx scripts/eval.ts <did-or-handle> [windowHours]')
  process.exit(1)
}
const windowHours = Number(process.argv[3] ?? 24)

const idResolver = new IdResolver({ didCache: new MemoryCache() })
const did = arg.startsWith('did:') ? arg : await idResolver.handle.resolve(arg).then((d) => {
  if (!d) throw new Error(`could not resolve handle ${arg}`)
  return d
})

const db = openDb()
const ingestor = new Ingestor(db)
const viewers = new ViewerStore(db, idResolver, ingestor)
viewers.loadRelevantFromDb()
const algo = new FeedAlgo(db, viewers)

const now = Date.now()
const since = now - windowHours * 3600_000
const viewer = await viewers.getViewer(did)
const likes = await fetchRecentLikes(did, idResolver, since)

console.log(`\n=== eval: ${arg} — likes from the last ${windowHours}h as ground truth ===`)
console.log(`you liked ${likes.length} posts in the window\n`)
if (likes.length === 0) {
  console.log('No likes in the window — nothing to evaluate. Try a larger window.')
  process.exit(0)
}

// Rank the full candidate set exactly as the live feed would right now
const candidates = algo.scoreCandidates(viewer, now)
const rankByUri = new Map<string, number>(candidates.map((c, i) => [c.uri, i + 1]))
const candByUri = new Map<string, ScoredCandidate>(candidates.map((c) => [c.uri, c]))

// Categorize each liked post by whether the feed could have shown it
const getPost = db.prepare('SELECT author, is_reply, created_at FROM post WHERE uri = ?')
const burstCount = db.prepare(
  `SELECT COUNT(DISTINCT liker) AS n FROM network_like
   WHERE subject_uri = ? AND liker IN (SELECT value FROM json_each(?))`,
)
const followsJson = JSON.stringify(viewer.followsArr)

interface Hit { uri: string; rank: number }
const hits: Hit[] = []
let replies = 0
let notIndexed = 0
let ownPosts = 0
const outOfNetwork: { uri: string; networkLikers: number }[] = []

for (const like of likes) {
  const post = getPost.get(like.subjectUri) as { author: string; is_reply: number; created_at: number } | undefined
  if (!post) {
    notIndexed++
    continue
  }
  if (post.author === did) {
    ownPosts++
    continue
  }
  if (post.is_reply === 1) {
    replies++
    continue
  }
  if (viewer.follows.has(post.author)) {
    const rank = rankByUri.get(like.subjectUri)
    if (rank) hits.push({ uri: like.subjectUri, rank })
    else notIndexed++ // in index but outside the 48h candidate window
  } else {
    const n = (burstCount.get(like.subjectUri, followsJson) as { n: number }).n
    outOfNetwork.push({ uri: like.subjectUri, networkLikers: n })
  }
}

console.log(`reachability of what you liked:`)
console.log(`  in-network posts the ranker scored:   ${hits.length}`)
console.log(`  replies (feed never shows, by design): ${replies}`)
console.log(`  out-of-network:                        ${outOfNetwork.length}`)
console.log(`  not in index (too old / pre-warmup):   ${notIndexed}${ownPosts ? `\n  your own posts: ${ownPosts}` : ''}`)

if (hits.length > 0) {
  const N = candidates.length
  const block = WEIGHTS.rankedBlockSize
  const at = (k: number) => hits.filter((h) => h.rank <= k).length
  const ranks = hits.map((h) => h.rank).sort((a, b) => a - b)
  const median = ranks[Math.floor(ranks.length / 2)]
  const auc = 1 - ranks.reduce((s, r) => s + (r - 1) / (N - 1), 0) / ranks.length

  console.log(`\nranking quality (${N} candidates scored):`)
  console.log(`  recall@${block} (the ranked block):  ${at(block)}/${hits.length} (${Math.round((100 * at(block)) / hits.length)}%)`)
  console.log(`  recall@50:                  ${at(50)}/${hits.length} (${Math.round((100 * at(50)) / hits.length)}%)`)
  console.log(`  median rank of liked posts: ${median}`)
  console.log(`  AUC (1.0 = perfect order):  ${auc.toFixed(3)}`)

  // Diagnose the misses: which factor buried each liked post?
  const buried = hits.filter((h) => h.rank > block)
  const reasons = new Map<string, Hit[]>()
  for (const h of buried) {
    const s = candByUri.get(h.uri)!.signals
    const factors = {
      decay: timeDecay(s.ageHours),
      ratio: ratioGuard(s.likes, s.replies),
      aff: affinity(s.viewerLikesOfAuthor),
      eng: 1 + engagementRaw(s.likes, s.reposts, s.replies) / (s.authorAvgEngagement + WEIGHTS.authorNormSmoothing),
    }
    const reason =
      factors.ratio < 1
        ? 'ratio-guarded (was it really a pile-on?)'
        : factors.decay < 0.15
          ? `too old by now (decay ${factors.decay.toFixed(2)})`
          : factors.aff === 1
            ? 'no affinity — you had never liked this author'
            : factors.eng < 1.5
              ? 'low engagement relative to author baseline'
              : 'outcompeted (no single weak factor)'
    if (!reasons.has(reason)) reasons.set(reason, [])
    reasons.get(reason)!.push(h)
  }

  if (buried.length > 0) {
    console.log(`\nliked but ranked below the block (${buried.length}):`)
    const sample = buried.slice(0, 12)
    const hyd = await hydratePosts(sample.map((h) => h.uri))
    for (const [reason, list] of [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${list.length}x ${reason}`)
      for (const h of list.slice(0, 3)) {
        const p = hyd.get(h.uri)
        if (p) console.log(`     #${h.rank} @${p.handle} (${p.likes}♥) ${p.text.slice(0, 70)}`)
      }
    }
  }

  console.log(`\nknob suggestions:`)
  const suggestions: string[] = []
  const byPrefix = (prefix: string) => [...reasons.entries()].filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v.length, 0)
  if (byPrefix('too old') >= 3)
    suggestions.push(`- ${byPrefix('too old')} misses died of time decay: consider decayHalfLifeHours ${WEIGHTS.decayHalfLifeHours} -> ${WEIGHTS.decayHalfLifeHours * 2}`)
  if (byPrefix('no affinity') >= 3)
    suggestions.push(`- ${byPrefix('no affinity')} misses were authors you'd never liked before: affinity history may be too shallow (raise maxRecords in fetchViewerLikeAuthors) or affinityLikeWeight too dominant`)
  if (byPrefix('ratio-guarded') >= 2)
    suggestions.push(`- ${byPrefix('ratio-guarded')} posts you liked were ratio-guarded: check them above; if they're benign, raise ratioReplyToLike ${WEIGHTS.ratioReplyToLike} -> 3`)
  if (byPrefix('low engagement') >= 3)
    suggestions.push(`- ${byPrefix('low engagement')} misses had few likes yet: the serve-time-vs-eval-time caveat may apply, or lower authorNormSmoothing`)
  const nearBursts = outOfNetwork.filter((o) => o.networkLikers > 0 && o.networkLikers < WEIGHTS.burstMinLikers).length
  const gotBursts = outOfNetwork.filter((o) => o.networkLikers >= WEIGHTS.burstMinLikers).length
  if (outOfNetwork.length > 0)
    console.log(`  (discovery: of ${outOfNetwork.length} out-of-network likes, ${gotBursts} were burst-eligible, ${nearBursts} had 1-${WEIGHTS.burstMinLikers - 1} network likes${nearBursts >= 3 ? ' — consider burstMinLikers: ' + (WEIGHTS.burstMinLikers - 1) : ''})`)
  if (suggestions.length === 0) suggestions.push('- nothing systematic — the ranker is doing its job for this window')
  for (const s of suggestions) console.log(`  ${s}`)
}

db.close()
