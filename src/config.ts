import 'dotenv/config'

const hostname = process.env.FEEDGEN_HOSTNAME ?? 'feed.example.com'

export const config = {
  port: Number(process.env.PORT ?? 3000),
  listenHost: process.env.LISTEN_HOST ?? '0.0.0.0',
  hostname,
  serviceDid: process.env.FEEDGEN_SERVICE_DID ?? `did:web:${hostname}`,
  publisherDid: process.env.FEEDGEN_PUBLISHER_DID ?? '',
  feedRkey: process.env.FEED_RKEY ?? 'rewind',
  jetstreamUrl: process.env.JETSTREAM_URL ?? 'wss://jetstream2.us-east.bsky.network/subscribe',
  dbPath: process.env.DB_PATH ?? './data/rewind.db',
  retentionHours: Number(process.env.RETENTION_HOURS ?? 48),
}

export function feedUri(): string {
  return `at://${config.publisherDid}/app.bsky.feed.generator/${config.feedRkey}`
}
