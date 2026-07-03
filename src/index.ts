import { IdResolver, MemoryCache } from '@atproto/identity'
import { config } from './config.js'
import { openDb, kvGet, kvSet } from './db.js'
import { Ingestor } from './ingest.js'
import { JetstreamConsumer } from './jetstream.js'
import { ViewerStore } from './viewer.js'
import { FeedAlgo } from './feed.js'
import { createServer } from './server.js'

const db = openDb()
const ingestor = new Ingestor(db)
const idResolver = new IdResolver({ didCache: new MemoryCache() })
const viewers = new ViewerStore(db, idResolver, ingestor)
const algo = new FeedAlgo(db, viewers)

viewers.loadRelevantFromDb()

const jetstream = new JetstreamConsumer(
  config.jetstreamUrl,
  (evt) => ingestor.handleEvent(evt),
  () => {
    const v = kvGet(db, 'jetstream_cursor')
    return v ? Number(v) : undefined
  },
  (timeUs) => kvSet(db, 'jetstream_cursor', String(timeUs)),
)
jetstream.start()

const pruneTimer = setInterval(() => ingestor.prune(), 3600_000)
ingestor.prune()

const app = createServer(algo, idResolver)
const server = app.listen(config.port, config.listenHost, () => {
  console.log(`rewind: listening on ${config.listenHost}:${config.port} as ${config.serviceDid}`)
})

function shutdown() {
  console.log('shutting down')
  clearInterval(pruneTimer)
  jetstream.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
