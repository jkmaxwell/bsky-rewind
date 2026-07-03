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
