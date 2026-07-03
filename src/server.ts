import express from 'express'
import type { IdResolver } from '@atproto/identity'
import { config, feedUri } from './config.js'
import { getViewerDid } from './auth.js'
import type { FeedAlgo } from './feed.js'

export function createServer(algo: FeedAlgo, idResolver: IdResolver) {
  const app = express()
  app.disable('x-powered-by')

  app.get('/.well-known/did.json', (_req, res) => {
    res.json({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: config.serviceDid,
      service: [
        {
          id: '#bsky_fg',
          type: 'BskyFeedGenerator',
          serviceEndpoint: `https://${config.hostname}`,
        },
      ],
    })
  })

  app.get('/xrpc/app.bsky.feed.describeFeedGenerator', (_req, res) => {
    res.json({
      did: config.serviceDid,
      feeds: [{ uri: feedUri() }],
    })
  })

  app.get('/xrpc/app.bsky.feed.getFeedSkeleton', async (req, res) => {
    const feed = String(req.query.feed ?? '')
    if (feed !== feedUri()) {
      res.status(400).json({ error: 'UnknownFeed', message: `Unknown feed: ${feed}` })
      return
    }
    try {
      const viewerDid = await getViewerDid(req, idResolver)
      const limit = Number(req.query.limit ?? 50)
      const cursor = req.query.cursor ? String(req.query.cursor) : undefined
      const skeleton = await algo.getSkeleton(viewerDid, limit, cursor)
      res.json(skeleton)
    } catch (err) {
      console.error('getFeedSkeleton failed', err)
      res.status(500).json({ error: 'InternalError' })
    }
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true })
  })

  return app
}
