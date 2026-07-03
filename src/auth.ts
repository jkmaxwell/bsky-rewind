import type { Request } from 'express'
import { verifyJwt } from '@atproto/xrpc-server'
import type { IdResolver } from '@atproto/identity'
import { config } from './config.js'

/**
 * The AppView signs a service JWT with the requesting user's repo key:
 * iss = viewer DID, aud = this generator's DID. Returns the viewer DID, or
 * null when the request is unauthenticated (e.g. logged-out feed preview).
 */
export async function getViewerDid(req: Request, idResolver: IdResolver): Promise<string | null> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const jwt = header.slice('Bearer '.length).trim()
  try {
    const payload = await verifyJwt(jwt, config.serviceDid, 'app.bsky.feed.getFeedSkeleton', (did, forceRefresh) =>
      idResolver.did.resolveAtprotoKey(did, forceRefresh),
    )
    // iss may carry a #service suffix; strip to the bare DID
    return payload.iss.split('#')[0]
  } catch (err) {
    console.warn('auth: jwt verification failed', err instanceof Error ? err.message : err)
    return null
  }
}
