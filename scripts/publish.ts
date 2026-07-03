import { AtpAgent } from '@atproto/api'
import { config } from '../src/config.js'

const handle = process.env.BLUESKY_HANDLE
const password = process.env.BLUESKY_APP_PASSWORD

if (!handle || !password) {
  console.error('Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not your real password).')
  process.exit(1)
}

const agent = new AtpAgent({ service: 'https://bsky.social' })
await agent.login({ identifier: handle, password })

await agent.com.atproto.repo.putRecord({
  repo: agent.session!.did,
  collection: 'app.bsky.feed.generator',
  rkey: config.feedRkey,
  record: {
    did: config.serviceDid,
    displayName: 'Rewind',
    description:
      'The timeline like it used to be. Your follows ranked by likes and friendship, ' +
      'discoveries only when several people you follow love the same post, and zero ' +
      'reward for arguments. Twitter circa 2016, on Bluesky.',
    createdAt: new Date().toISOString(),
  },
})

console.log('Published!')
console.log(`Feed URI: at://${agent.session!.did}/app.bsky.feed.generator/${config.feedRkey}`)
console.log(`Set FEEDGEN_PUBLISHER_DID=${agent.session!.did} in your .env and restart the service.`)
console.log(
  `View at: https://bsky.app/profile/${agent.session!.did}/feed/${config.feedRkey}`,
)
