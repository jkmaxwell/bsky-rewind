import WebSocket from 'ws'
import type { JetstreamEvent } from './ingest.js'

const COLLECTIONS = ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost']

export class JetstreamConsumer {
  private ws?: WebSocket
  private lastTimeUs = 0
  private stopped = false
  private backoffMs = 1000
  private saveTimer?: NodeJS.Timeout

  constructor(
    private url: string,
    private onEvent: (evt: JetstreamEvent) => void,
    private getCursor: () => number | undefined,
    private saveCursor: (timeUs: number) => void,
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
    this.saveTimer = setInterval(() => {
      if (this.lastTimeUs > 0) this.saveCursor(this.lastTimeUs)
    }, 5000)
  }

  stop(): void {
    this.stopped = true
    if (this.saveTimer) clearInterval(this.saveTimer)
    this.ws?.close()
    if (this.lastTimeUs > 0) this.saveCursor(this.lastTimeUs)
  }

  private connect(): void {
    const params = new URLSearchParams()
    for (const c of COLLECTIONS) params.append('wantedCollections', c)
    const cursor = this.lastTimeUs || this.getCursor()
    if (cursor) {
      // Rewind a few seconds; ingest is idempotent (INSERT OR IGNORE) except
      // for aggregate counters, where slight double-counting on reconnect is
      // an acceptable error for a 48h ranking window.
      params.set('cursor', String(Math.max(0, cursor - 3_000_000)))
    }
    const url = `${this.url}?${params.toString()}`
    console.log('jetstream: connecting', url)
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.backoffMs = 1000
      console.log('jetstream: connected')
    })

    ws.on('message', (data) => {
      let evt: JetstreamEvent
      try {
        evt = JSON.parse(data.toString())
      } catch {
        return
      }
      if (typeof evt.time_us === 'number') this.lastTimeUs = evt.time_us
      this.onEvent(evt)
    })

    const reconnect = () => {
      if (this.stopped) return
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
      console.log(`jetstream: disconnected, reconnecting in ${delay}ms`)
      setTimeout(() => this.connect(), delay)
    }

    ws.on('close', reconnect)
    ws.on('error', (err) => {
      console.error('jetstream: error', err.message)
      ws.close()
    })
  }
}
