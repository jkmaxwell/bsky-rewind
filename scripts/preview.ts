/**
 * Dev preview: run the full personalized pipeline for a given DID/handle
 * against the local index, bypassing JWT auth (which only the AppView can
 * exercise). Usage: npx tsx scripts/preview.ts <did-or-handle> [limit]
 */
import { IdResolver, MemoryCache } from '@atproto/identity'
import { openDb } from '../src/db.js'
import { Ingestor } from '../src/ingest.js'
import { ViewerStore } from '../src/viewer.js'
import { FeedAlgo } from '../src/feed.js'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npx tsx scripts/preview.ts <did-or-handle> [limit]')
  process.exit(1)
}
const limit = Number(process.argv[3] ?? 30)

const idResolver = new IdResolver({ didCache: new MemoryCache() })
const did = arg.startsWith('did:') ? arg : await idResolver.handle.resolve(arg).then((d) => {
  if (!d) throw new Error(`could not resolve handle ${arg}`)
  return d
})
console.log(`viewer: ${arg} -> ${did}`)

const db = openDb()
const ingestor = new Ingestor(db)
const viewers = new ViewerStore(db, idResolver, ingestor)
viewers.loadRelevantFromDb()
const algo = new FeedAlgo(db, viewers)

// Diagnostics before ranking, so an empty feed explains itself
const state = await viewers.getViewer(did)
const totalPosts = (db.prepare('SELECT count(*) AS n FROM post').get() as { n: number }).n
const byFollows = (
  db
    .prepare(
      `SELECT count(*) AS n FROM post
       WHERE author IN (SELECT value FROM json_each(?)) AND is_reply = 0`,
    )
    .get(JSON.stringify(state.followsArr)) as { n: number }
).n
console.log(`index: ${totalPosts} posts total; viewer follows ${state.followsArr.length} accounts, ${byFollows} of their posts indexed`)
if (state.followsArr.length < 5) {
  console.warn(`⚠ this account follows almost nobody — did you mean to preview a different handle?`)
}
if (totalPosts < 50_000) {
  console.warn(`⚠ small index — let \`npm run dev\` ingest for 15+ minutes for a meaningful preview`)
}

interface Hydrated {
  handle: string
  text: string
  likes: number
  replies: number
}

/** Hydrate skeleton URIs into readable posts via the public AppView. */
async function hydrate(uris: string[]): Promise<Map<string, Hydrated>> {
  const map = new Map<string, Hydrated>()
  for (let i = 0; i < uris.length; i += 25) {
    const params = new URLSearchParams()
    for (const u of uris.slice(i, i + 25)) params.append('uris', u)
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${params}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) continue
      const data: any = await res.json()
      for (const p of data.posts ?? []) {
        map.set(p.uri, {
          handle: p.author?.handle ?? '?',
          text: String(p.record?.text ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 100),
          likes: p.likeCount ?? 0,
          replies: p.replyCount ?? 0,
        })
      }
    } catch {
      // leave chunk unhydrated; URIs are printed as fallback
    }
  }
  return map
}

async function printPage(feed: { post: string; reason?: unknown }[], rankedCount: number): Promise<void> {
  const posts = await hydrate(feed.map((i) => i.post))
  feed.forEach((item, i) => {
    if (i === 0 && rankedCount > 0) console.log('── while you were away ─────────────────────')
    if (i === rankedCount && rankedCount > 0) console.log('── chronological ───────────────────────────')
    const p = posts.get(item.post)
    const tag = item.reason ? 'RT ' : '   '
    if (p) {
      console.log(`${tag}@${p.handle} (${p.likes}♥ ${p.replies}💬) ${p.text}`)
    } else {
      console.log(`${tag}${item.post} (deleted or unhydratable)`)
    }
  })
}

console.time('page 1')
const page1 = await algo.getSkeleton(did, limit)
console.timeEnd('page 1')
console.log(`\npage 1: ${page1.feed.length} items`)
const { WEIGHTS } = await import('../src/scoring.js')
await printPage(page1.feed, Math.min(WEIGHTS.rankedBlockSize, page1.feed.length))

if (page1.cursor) {
  console.time('page 2')
  const page2 = await algo.getSkeleton(did, limit, page1.cursor)
  console.timeEnd('page 2')
  console.log(`\npage 2: ${page2.feed.length} items, cursor=${page2.cursor ? 'yes' : 'end'}`)
  await printPage(page2.feed, 0)
  const dupes = page2.feed.filter((i) => page1.feed.some((j) => j.post === i.post))
  console.log(`duplicates across pages: ${dupes.length}`)
}
db.close()
