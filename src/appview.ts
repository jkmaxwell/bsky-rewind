import type { IdResolver } from '@atproto/identity'
import { didFromAtUri } from './ingest.js'

const PUBLIC_API = 'https://public.api.bsky.app'
const FETCH_TIMEOUT_MS = 15_000

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

/** All DIDs the actor follows, via the public AppView (100/page). */
export async function fetchFollows(did: string, maxFollows = 4000): Promise<string[]> {
  const follows: string[] = []
  let cursor: string | undefined
  while (follows.length < maxFollows) {
    const params = new URLSearchParams({ actor: did, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const data = await getJson(`${PUBLIC_API}/xrpc/app.bsky.graph.getFollows?${params}`)
    for (const f of data.follows ?? []) follows.push(f.did)
    cursor = data.cursor
    if (!cursor || (data.follows ?? []).length === 0) break
  }
  return follows
}

export interface LikeRecord {
  subjectUri: string
  createdAt: number
}

/**
 * The viewer's like records newer than `sinceMs`, with timestamps, read from
 * their PDS. Fetches up to maxRecords and filters, so it is order-agnostic.
 */
export async function fetchRecentLikes(
  did: string,
  idResolver: IdResolver,
  sinceMs: number,
  maxRecords = 1000,
): Promise<LikeRecord[]> {
  const { pds } = await idResolver.did.resolveAtprotoData(did)
  const out: LikeRecord[] = []
  let cursor: string | undefined
  let fetched = 0
  while (fetched < maxRecords) {
    const params = new URLSearchParams({ repo: did, collection: 'app.bsky.feed.like', limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const data = await getJson(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`)
    const records: any[] = data.records ?? []
    for (const r of records) {
      const subjectUri: string | undefined = r?.value?.subject?.uri
      const createdAt = Date.parse(r?.value?.createdAt ?? '')
      if (!subjectUri || Number.isNaN(createdAt)) continue
      if (createdAt >= sinceMs) out.push({ subjectUri, createdAt })
    }
    fetched += records.length
    cursor = data.cursor
    if (!cursor || records.length === 0) break
    // listRecords pages newest-first; once a whole page is older, stop
    if (records.every((r) => Date.parse(r?.value?.createdAt ?? '') < sinceMs)) break
  }
  return out
}

export interface HydratedPost {
  handle: string
  text: string
  likes: number
  replies: number
}

/** Hydrate post URIs into readable summaries via the public AppView (25/call). */
export async function hydratePosts(uris: string[]): Promise<Map<string, HydratedPost>> {
  const map = new Map<string, HydratedPost>()
  for (let i = 0; i < uris.length; i += 25) {
    const params = new URLSearchParams()
    for (const u of uris.slice(i, i + 25)) params.append('uris', u)
    try {
      const data = await getJson(`${PUBLIC_API}/xrpc/app.bsky.feed.getPosts?${params}`)
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
      // leave chunk unhydrated; callers fall back to raw URIs
    }
  }
  return map
}

/**
 * The viewer's recent like history, read straight from their PDS repo
 * (app.bsky.feed.like records are public). The liked post's author DID is
 * embedded in the subject at-uri, so this needs no per-post lookups.
 * Returns author DID -> number of viewer likes.
 */
export async function fetchViewerLikeAuthors(
  did: string,
  idResolver: IdResolver,
  maxRecords = 600,
): Promise<Record<string, number>> {
  const { pds } = await idResolver.did.resolveAtprotoData(did)
  const counts: Record<string, number> = {}
  let cursor: string | undefined
  let fetched = 0
  while (fetched < maxRecords) {
    const params = new URLSearchParams({
      repo: did,
      collection: 'app.bsky.feed.like',
      limit: '100',
    })
    if (cursor) params.set('cursor', cursor)
    const data = await getJson(`${pds}/xrpc/com.atproto.repo.listRecords?${params}`)
    const records: any[] = data.records ?? []
    for (const r of records) {
      const subjectUri: string | undefined = r?.value?.subject?.uri
      if (!subjectUri) continue
      const author = didFromAtUri(subjectUri)
      if (author) counts[author] = (counts[author] ?? 0) + 1
    }
    fetched += records.length
    cursor = data.cursor
    if (!cursor || records.length === 0) break
  }
  return counts
}
