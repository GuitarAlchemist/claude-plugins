import { describe, expect, test } from 'claude-code/testing'
import { needsAttention, toRow } from '../hooks/pr-rows'
import type { GhPr } from '../hooks/pr-rows'

const pr = (extra: object = {}): GhPr => ({
  number: 2, title: 'guard', headRefName: 'fix', headRefOid: 'abc1234',
  isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
  statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }],
  url: 'https://github.com/GuitarAlchemist/claude-plugins/pull/2', updatedAt: '2026-10-10T00:00:00Z',
  ...extra,
})
describe('CI green does not prove review readiness', () => {
  test('missing review-thread evidence needs attention', () => {
    expect(needsAttention(toRow('repo', pr()))).toBe(true)
  })
  test('an unresolved finding needs attention even after approval', () => {
    expect(needsAttention(toRow('repo', pr({ reviewThreads: { head: 'abc1234', complete: true, unresolved: 1 } })))).toBe(true)
  })
  test('a thread snapshot for another head is unknown', () => {
    expect(toRow('repo', pr({ reviewThreads: { head: 'old', complete: true, unresolved: 0 } })).unresolvedReviews).toBe(null)
  })
  test('truncated thread results are unknown', () => {
    expect(needsAttention(toRow('repo', pr({ reviewThreads: { head: 'abc1234', complete: false, unresolved: 0 } })))).toBe(true)
  })
  test('closed threads alone do not replace an approval', () => {
    expect(needsAttention(toRow('repo', pr({ reviewDecision: '', reviewThreads: { head: 'abc1234', complete: true, unresolved: 0 } })))).toBe(true)
  })
  test('draft and unknown mergeability need attention', () => {
    const reviewThreads = { head: 'abc1234', complete: true, unresolved: 0 }
    expect(needsAttention(toRow('repo', pr({ reviewThreads, isDraft: true })))).toBe(true)
    expect(needsAttention(toRow('repo', pr({ reviewThreads, mergeable: 'UNKNOWN' })))).toBe(true)
  })
  test('complete approved review with green CI clears only these alerts', () => {
    expect(needsAttention(toRow('repo', pr({ reviewThreads: { head: 'abc1234', complete: true, unresolved: 0 } })))).toBe(false)
  })
})
