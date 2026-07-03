/**
 * Ranking weights modeled on mid-2010s Twitter:
 *
 * - Engagement weights (like=30, repost=20, reply=1) mirror the open-sourced
 *   legacy "Earlybird" light ranker. Replies are deliberately near-worthless:
 *   the 2019+ ranker that made a reply worth 13.5-27x a like is what produced
 *   dunk/argument culture, and we invert that on purpose.
 * - Engagement is normalized by the author's typical engagement (documented
 *   2016 signal), so a small account's great post outranks a celebrity's
 *   average one.
 * - Affinity (how often the viewer likes this author) multiplies everything:
 *   friends first.
 * - The ratio guard suppresses posts whose replies dwarf their likes — the
 *   signature of a pile-on or engagement bait.
 */
export const WEIGHTS = {
  like: 30,
  repost: 20,
  reply: 1,

  mediaBoost: 1.15,
  threadRootBoost: 1.25,

  ratioMinReplies: 10,
  ratioReplyToLike: 2,
  ratioPenalty: 0.15,

  decayHalfLifeHours: 6,
  candidateWindowHours: 48,

  authorNormSmoothing: 5,

  affinityLikeWeight: 0.6,
  affinityCap: 4,

  burstMinLikers: 3,
  burstWindowHours: 6,

  rankedBlockSize: 15,
  maxBurstsInBlock: 3,
} as const

export interface PostSignals {
  likes: number
  reposts: number
  replies: number
  hasMedia: boolean
  isThreadRoot: boolean
  ageHours: number
  authorAvgEngagement: number
  viewerLikesOfAuthor: number
}

export function engagementRaw(likes: number, reposts: number, replies: number): number {
  return WEIGHTS.like * likes + WEIGHTS.repost * reposts + WEIGHTS.reply * replies
}

export function timeDecay(ageHours: number): number {
  return Math.pow(0.5, Math.max(0, ageHours) / WEIGHTS.decayHalfLifeHours)
}

export function affinity(viewerLikesOfAuthor: number): number {
  const a = 1 + WEIGHTS.affinityLikeWeight * Math.log2(1 + Math.max(0, viewerLikesOfAuthor))
  return Math.min(a, WEIGHTS.affinityCap)
}

export function ratioGuard(likes: number, replies: number): number {
  if (replies >= WEIGHTS.ratioMinReplies && replies > WEIGHTS.ratioReplyToLike * likes) {
    return WEIGHTS.ratioPenalty
  }
  return 1
}

export function scorePost(s: PostSignals): number {
  const raw = engagementRaw(s.likes, s.reposts, s.replies)
  const normalized = raw / (s.authorAvgEngagement + WEIGHTS.authorNormSmoothing)
  let score = affinity(s.viewerLikesOfAuthor) * (1 + normalized)
  if (s.hasMedia) score *= WEIGHTS.mediaBoost
  if (s.isThreadRoot) score *= WEIGHTS.threadRootBoost
  score *= ratioGuard(s.likes, s.replies)
  score *= timeDecay(s.ageHours)
  return score
}

/**
 * MagicRecs-style burst score for out-of-network injections: driven purely by
 * how many of the viewer's follows converged on the post, decayed like
 * everything else. Global popularity is irrelevant by construction.
 */
export function burstScore(distinctLikers: number, ageHours: number): number {
  return Math.log2(1 + distinctLikers) * timeDecay(ageHours)
}
