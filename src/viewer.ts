import type { IdResolver } from '@atproto/identity'
import type { Db } from './db.js'
import type { Ingestor } from './ingest.js'
import { fetchFollows, fetchViewerLikeAuthors } from './appview.js'

const REFRESH_TTL_MS = 12 * 3600_000

export interface ViewerState {
  did: string
  follows: Set<string>
  followsArr: string[]
  /** author DID -> count of viewer's likes of that author */
  affinity: Record<string, number>
}

interface ViewerRow {
  did: string
  follows_json: string | null
  follows_fetched_at: number | null
  affinity_json: string | null
  affinity_fetched_at: number | null
}

/**
 * Per-viewer social graph + affinity, cached in SQLite with a 12h TTL.
 * First-ever request fetches synchronously (a few seconds); afterwards stale
 * data is served immediately and refreshed in the background.
 */
export class ViewerStore {
  private memory = new Map<string, { state: ViewerState; fetchedAt: number }>()
  private inflight = new Map<string, Promise<ViewerState>>()

  constructor(
    private db: Db,
    private idResolver: IdResolver,
    private ingestor: Ingestor,
  ) {}

  /** On boot: mark every known viewer's follow graph as relevant for ingest. */
  loadRelevantFromDb(): void {
    const rows = this.db.prepare('SELECT did, follows_json FROM viewer').all() as ViewerRow[]
    for (const row of rows) {
      this.ingestor.addRelevant([row.did])
      if (row.follows_json) {
        try {
          this.ingestor.addRelevant(JSON.parse(row.follows_json) as string[])
        } catch {
          // ignore corrupt cache; it will be refreshed on next request
        }
      }
    }
    console.log(`viewer: loaded ${rows.length} viewers, ${this.ingestor.relevantCount} relevant DIDs`)
  }

  async getViewer(did: string): Promise<ViewerState> {
    const now = Date.now()
    const cached = this.memory.get(did)
    if (cached) {
      if (now - cached.fetchedAt > REFRESH_TTL_MS) {
        void this.refresh(did).catch((err) => console.error('viewer refresh failed', did, err))
      }
      return cached.state
    }

    const row = this.db.prepare('SELECT * FROM viewer WHERE did = ?').get(did) as ViewerRow | undefined
    if (row?.follows_json && row.follows_fetched_at) {
      const state = this.rowToState(row)
      this.memory.set(did, { state, fetchedAt: row.follows_fetched_at })
      if (now - row.follows_fetched_at > REFRESH_TTL_MS) {
        void this.refresh(did).catch((err) => console.error('viewer refresh failed', did, err))
      }
      return state
    }

    return this.refresh(did)
  }

  private rowToState(row: ViewerRow): ViewerState {
    const followsArr: string[] = row.follows_json ? JSON.parse(row.follows_json) : []
    const affinity: Record<string, number> = row.affinity_json ? JSON.parse(row.affinity_json) : {}
    return { did: row.did, follows: new Set(followsArr), followsArr, affinity }
  }

  private refresh(did: string): Promise<ViewerState> {
    const existing = this.inflight.get(did)
    if (existing) return existing
    const p = this.doRefresh(did).finally(() => this.inflight.delete(did))
    this.inflight.set(did, p)
    return p
  }

  private async doRefresh(did: string): Promise<ViewerState> {
    const [followsArr, affinity] = await Promise.all([
      fetchFollows(did),
      fetchViewerLikeAuthors(did, this.idResolver).catch((err) => {
        console.error('affinity fetch failed (continuing without)', did, err.message ?? err)
        return {} as Record<string, number>
      }),
    ])
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO viewer (did, follows_json, follows_fetched_at, affinity_json, affinity_fetched_at, last_seen_at)
         VALUES (@did, @follows, @now, @affinity, @now, @now)
         ON CONFLICT(did) DO UPDATE SET
           follows_json = excluded.follows_json,
           follows_fetched_at = excluded.follows_fetched_at,
           affinity_json = excluded.affinity_json,
           affinity_fetched_at = excluded.affinity_fetched_at,
           last_seen_at = excluded.last_seen_at`,
      )
      .run({ did, follows: JSON.stringify(followsArr), affinity: JSON.stringify(affinity), now })

    this.ingestor.addRelevant([did, ...followsArr])
    const state: ViewerState = { did, follows: new Set(followsArr), followsArr, affinity }
    this.memory.set(did, { state, fetchedAt: now })
    console.log(`viewer: refreshed ${did} (${followsArr.length} follows, ${Object.keys(affinity).length} liked authors)`)
    return state
  }
}
