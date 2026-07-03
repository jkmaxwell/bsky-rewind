import { describe, it, expect } from 'vitest'
import { WEIGHTS, scorePost, affinity, ratioGuard, timeDecay, burstScore, type PostSignals } from '../src/scoring.js'

function signals(overrides: Partial<PostSignals>): PostSignals {
  return {
    likes: 0,
    reposts: 0,
    replies: 0,
    hasMedia: false,
    isThreadRoot: false,
    ageHours: 1,
    authorAvgEngagement: 50,
    viewerLikesOfAuthor: 0,
    ...overrides,
  }
}

describe('engagement weights (Earlybird ordering)', () => {
  it('values a like far above a reply', () => {
    const liked = scorePost(signals({ likes: 50 }))
    const replied = scorePost(signals({ replies: 50 }))
    expect(liked).toBeGreaterThan(replied * 5)
  })

  it('a well-liked post beats a heavily-replied post (anti-dunk core)', () => {
    // 2019-era Twitter/Threads would rank the 200-reply post first.
    const funny = scorePost(signals({ likes: 60, replies: 5 }))
    const argument = scorePost(signals({ likes: 20, replies: 200 }))
    expect(funny).toBeGreaterThan(argument)
  })
})

describe('ratio guard', () => {
  it('suppresses ratio’d posts', () => {
    expect(ratioGuard(10, 100)).toBe(WEIGHTS.ratioPenalty)
  })
  it('leaves healthy posts alone', () => {
    expect(ratioGuard(100, 40)).toBe(1)
  })
  it('ignores small-sample replies', () => {
    expect(ratioGuard(1, 8)).toBe(1) // 8 replies on a tiny post is a conversation, not a pile-on
  })
  it('a dunked-on post scores below an ordinary decent post', () => {
    const dunked = scorePost(signals({ likes: 30, replies: 300 }))
    const decent = scorePost(signals({ likes: 30, replies: 3 }))
    expect(decent).toBeGreaterThan(dunked * 3)
  })
})

describe('author normalization', () => {
  it('a small account’s great post outranks a celebrity’s average post', () => {
    const smallAccount = scorePost(signals({ likes: 50, authorAvgEngagement: 60 }))
    const celebrity = scorePost(signals({ likes: 400, authorAvgEngagement: 40000 }))
    expect(smallAccount).toBeGreaterThan(celebrity)
  })
})

describe('affinity', () => {
  it('grows with viewer likes of the author and is capped', () => {
    expect(affinity(0)).toBe(1)
    expect(affinity(10)).toBeGreaterThan(affinity(2))
    expect(affinity(100000)).toBe(WEIGHTS.affinityCap)
  })
  it('multiplies a close friend’s post ~4x over the same post from a stranger', () => {
    const friend = scorePost(signals({ likes: 20, viewerLikesOfAuthor: 30 }))
    const stranger = scorePost(signals({ likes: 20, viewerLikesOfAuthor: 0 }))
    expect(friend / stranger).toBeGreaterThan(3.5)
  })
  it('a friend’s modest post beats a stranger’s moderately better one', () => {
    const friend = scorePost(signals({ likes: 8, viewerLikesOfAuthor: 30 }))
    const stranger = scorePost(signals({ likes: 20, viewerLikesOfAuthor: 0 }))
    expect(friend).toBeGreaterThan(stranger)
  })
})

describe('time decay', () => {
  it('halves per half-life and is monotonic', () => {
    expect(timeDecay(WEIGHTS.decayHalfLifeHours)).toBeCloseTo(0.5)
    expect(timeDecay(0)).toBe(1)
    expect(timeDecay(24)).toBeLessThan(timeDecay(6))
  })
})

describe('content boosts', () => {
  it('boosts media and thread roots', () => {
    const plain = scorePost(signals({ likes: 20 }))
    const withMedia = scorePost(signals({ likes: 20, hasMedia: true }))
    const thread = scorePost(signals({ likes: 20, isThreadRoot: true }))
    expect(withMedia).toBeCloseTo(plain * WEIGHTS.mediaBoost)
    expect(thread).toBeCloseTo(plain * WEIGHTS.threadRootBoost)
  })
})

describe('burst score (MagicRecs)', () => {
  it('scales with distinct likers, not global popularity', () => {
    expect(burstScore(6, 1)).toBeGreaterThan(burstScore(3, 1))
  })
  it('decays with age', () => {
    expect(burstScore(5, 6)).toBeLessThan(burstScore(5, 1))
  })
})
