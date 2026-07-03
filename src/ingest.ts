import type { Db } from './db.js'
import { config } from './config.js'

export interface JetstreamCommit {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: any
  cid?: string
}

export interface JetstreamEvent {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: JetstreamCommit
}

export function didFromAtUri(uri: string): string {
  // at://did:plc:xxx/app.bsky.feed.post/rkey
  return uri.split('/')[2] ?? ''
}

function hasMedia(record: any): boolean {
  const t: string | undefined = record?.embed?.$type
  if (!t) return false
  if (t.startsWith('app.bsky.embed.images') || t.startsWith('app.bsky.embed.video')) return true
  if (t.startsWith('app.bsky.embed.recordWithMedia')) {
    const mt: string | undefined = record.embed?.media?.$type
    return !!mt && (mt.startsWith('app.bsky.embed.images') || mt.startsWith('app.bsky.embed.video'))
  }
  return false
}

function parseCreatedAt(record: any, timeUs: number): number {
  const ts = Date.parse(record?.createdAt ?? '')
  const eventMs = Math.floor(timeUs / 1000)
  if (Number.isNaN(ts)) return eventMs
  // Clamp future-dated posts so they can't camp at the top of the window
  return Math.min(ts, eventMs + 5 * 60_000)
}

/**
 * Consumes Jetstream commit events into the rolling SQLite index.
 *
 * Every post is indexed (MagicRecs subjects can be from anywhere), but
 * row-level likes/reposts are only kept when the actor is "relevant" —
 * followed by at least one of this feed's viewers. Aggregate counters on the
 * post row are updated for all events regardless.
 */
export class Ingestor {
  private relevant = new Set<string>()

  private stmtInsertPost
  private stmtDeletePost
  private stmtBumpReply
  private stmtMarkSelfReply
  private stmtBumpLike
  private stmtInsertLike
  private stmtGetLike
  private stmtDeleteLike
  private stmtBumpRepost
  private stmtInsertRepost
  private stmtGetRepost
  private stmtDeleteRepost
  private stmtPrunePosts
  private stmtPruneLikes
  private stmtPruneReposts

  constructor(private db: Db) {
    this.stmtInsertPost = db.prepare(`
      INSERT OR IGNORE INTO post (uri, cid, author, created_at, indexed_at, is_reply, parent_uri, has_media)
      VALUES (@uri, @cid, @author, @created_at, @indexed_at, @is_reply, @parent_uri, @has_media)
    `)
    this.stmtDeletePost = db.prepare('DELETE FROM post WHERE uri = ?')
    this.stmtBumpReply = db.prepare('UPDATE post SET reply_count = reply_count + 1 WHERE uri = ?')
    this.stmtMarkSelfReply = db.prepare('UPDATE post SET has_self_reply = 1 WHERE uri = ?')
    this.stmtBumpLike = db.prepare('UPDATE post SET like_count = MAX(0, like_count + ?) WHERE uri = ?')
    this.stmtInsertLike = db.prepare(`
      INSERT OR IGNORE INTO network_like (liker, rkey, subject_uri, subject_author, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.stmtGetLike = db.prepare('SELECT subject_uri FROM network_like WHERE liker = ? AND rkey = ?')
    this.stmtDeleteLike = db.prepare('DELETE FROM network_like WHERE liker = ? AND rkey = ?')
    this.stmtBumpRepost = db.prepare('UPDATE post SET repost_count = MAX(0, repost_count + ?) WHERE uri = ?')
    this.stmtInsertRepost = db.prepare(`
      INSERT OR IGNORE INTO network_repost (reposter, rkey, uri, subject_uri, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    this.stmtGetRepost = db.prepare('SELECT subject_uri FROM network_repost WHERE reposter = ? AND rkey = ?')
    this.stmtDeleteRepost = db.prepare('DELETE FROM network_repost WHERE reposter = ? AND rkey = ?')
    this.stmtPrunePosts = db.prepare('DELETE FROM post WHERE created_at < ?')
    this.stmtPruneLikes = db.prepare('DELETE FROM network_like WHERE created_at < ?')
    this.stmtPruneReposts = db.prepare('DELETE FROM network_repost WHERE created_at < ?')
  }

  addRelevant(dids: Iterable<string>): void {
    for (const did of dids) this.relevant.add(did)
  }

  get relevantCount(): number {
    return this.relevant.size
  }

  handleEvent(evt: JetstreamEvent): void {
    if (evt.kind !== 'commit' || !evt.commit) return
    const c = evt.commit
    try {
      switch (c.collection) {
        case 'app.bsky.feed.post':
          if (c.operation === 'create') this.onPostCreate(evt.did, c, evt.time_us)
          else if (c.operation === 'delete') this.stmtDeletePost.run(`at://${evt.did}/app.bsky.feed.post/${c.rkey}`)
          break
        case 'app.bsky.feed.like':
          if (c.operation === 'create') this.onLikeCreate(evt.did, c, evt.time_us)
          else if (c.operation === 'delete') this.onLikeDelete(evt.did, c.rkey)
          break
        case 'app.bsky.feed.repost':
          if (c.operation === 'create') this.onRepostCreate(evt.did, c, evt.time_us)
          else if (c.operation === 'delete') this.onRepostDelete(evt.did, c.rkey)
          break
      }
    } catch (err) {
      console.error('ingest error', c.collection, c.operation, err)
    }
  }

  private onPostCreate(did: string, c: JetstreamCommit, timeUs: number): void {
    const record = c.record ?? {}
    const uri = `at://${did}/app.bsky.feed.post/${c.rkey}`
    const parentUri: string | null = record.reply?.parent?.uri ?? null
    this.stmtInsertPost.run({
      uri,
      cid: c.cid ?? '',
      author: did,
      created_at: parseCreatedAt(record, timeUs),
      indexed_at: Date.now(),
      is_reply: parentUri ? 1 : 0,
      parent_uri: parentUri,
      has_media: hasMedia(record) ? 1 : 0,
    })
    if (parentUri) {
      this.stmtBumpReply.run(parentUri)
      // Author replying to themselves = a thread (advice threads, stories).
      if (didFromAtUri(parentUri) === did) this.stmtMarkSelfReply.run(parentUri)
    }
  }

  private onLikeCreate(did: string, c: JetstreamCommit, timeUs: number): void {
    const subjectUri: string | undefined = c.record?.subject?.uri
    if (!subjectUri) return
    this.stmtBumpLike.run(1, subjectUri)
    if (this.relevant.has(did)) {
      this.stmtInsertLike.run(did, c.rkey, subjectUri, didFromAtUri(subjectUri), parseCreatedAt(c.record, timeUs))
    }
  }

  private onLikeDelete(did: string, rkey: string): void {
    const row = this.stmtGetLike.get(did, rkey) as { subject_uri: string } | undefined
    if (!row) return
    this.stmtDeleteLike.run(did, rkey)
    this.stmtBumpLike.run(-1, row.subject_uri)
  }

  private onRepostCreate(did: string, c: JetstreamCommit, timeUs: number): void {
    const subjectUri: string | undefined = c.record?.subject?.uri
    if (!subjectUri) return
    this.stmtBumpRepost.run(1, subjectUri)
    if (this.relevant.has(did)) {
      const uri = `at://${did}/app.bsky.feed.repost/${c.rkey}`
      this.stmtInsertRepost.run(did, c.rkey, uri, subjectUri, parseCreatedAt(c.record, timeUs))
    }
  }

  private onRepostDelete(did: string, rkey: string): void {
    const row = this.stmtGetRepost.get(did, rkey) as { subject_uri: string } | undefined
    if (!row) return
    this.stmtDeleteRepost.run(did, rkey)
    this.stmtBumpRepost.run(-1, row.subject_uri)
  }

  prune(): void {
    const cutoff = Date.now() - config.retentionHours * 3600_000
    const posts = this.stmtPrunePosts.run(cutoff).changes
    const likes = this.stmtPruneLikes.run(cutoff).changes
    const reposts = this.stmtPruneReposts.run(cutoff).changes
    console.log(`prune: removed ${posts} posts, ${likes} likes, ${reposts} reposts older than ${config.retentionHours}h`)
  }
}
