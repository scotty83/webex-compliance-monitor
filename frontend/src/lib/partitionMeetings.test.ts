import { describe, it, expect } from 'vitest'
import { partitionMeetings, FAILURE_GRACE_MS } from './partitionMeetings'
import type { Meeting } from '../types'

const NOW = 1_000_000

function m(id: string, over: Partial<Meeting>): Meeting {
  return {
    id,
    title: `Meeting ${id}`,
    org: '',
    sipUri: `${id}@x.webex.com`,
    startedAt: NOW - 10_000,
    botState: 'connected',
    attendees: [],
    ...over,
  }
}

describe('partitionMeetings — Active vs Past split', () => {
  it('ended → past immediately', () => {
    const { active, past } = partitionMeetings(
      [m('m1', { botState: 'ended', endedAt: NOW - 1 })],
      NOW,
    )
    expect(active).toHaveLength(0)
    expect(past).toHaveLength(1)
    expect(past[0].id).toBe('m1')
  })

  it('failed FRESH (within grace) → active (fail-LOUD)', () => {
    const { active, past } = partitionMeetings(
      [m('m2', { botState: 'failed', endedAt: NOW - FAILURE_GRACE_MS + 1_000 })],
      NOW,
    )
    expect(active).toHaveLength(1)
    expect(past).toHaveLength(0)
  })

  it('failed STALE (beyond grace) → past', () => {
    const { active, past } = partitionMeetings(
      [m('m3', { botState: 'failed', endedAt: NOW - FAILURE_GRACE_MS - 1_000 })],
      NOW,
    )
    expect(active).toHaveLength(0)
    expect(past).toHaveLength(1)
  })

  it('disconnected FRESH → active (fail-LOUD)', () => {
    const { active, past } = partitionMeetings(
      [m('m4', { botState: 'disconnected', endedAt: NOW - 60_000 })],
      NOW,
    )
    expect(active).toHaveLength(1)
    expect(past).toHaveLength(0)
  })

  it('disconnected STALE → past', () => {
    const { active, past } = partitionMeetings(
      [m('m5', { botState: 'disconnected', endedAt: NOW - FAILURE_GRACE_MS - 1 })],
      NOW,
    )
    expect(active).toHaveLength(0)
    expect(past).toHaveLength(1)
  })

  it('idle / dialing / connected → always active', () => {
    for (const botState of ['idle', 'dialing', 'connected'] as const) {
      const { active, past } = partitionMeetings([m('mx', { botState })], NOW)
      expect(active).toHaveLength(1)
      expect(past).toHaveLength(0)
    }
  })

  it('endedAt undefined on a terminal state → past (conservative safe default)', () => {
    // now − 0 = NOW ≥ FAILURE_GRACE_MS → past
    const { past } = partitionMeetings(
      [m('m6', { botState: 'failed', endedAt: undefined })],
      NOW,
    )
    expect(past).toHaveLength(1)
  })

  it('past list sorted most-recent first (descending endedAt)', () => {
    const meetings = [
      m('early', { botState: 'ended', endedAt: NOW - 3_000 }),
      m('late',  { botState: 'ended', endedAt: NOW - 1_000 }),
      m('mid',   { botState: 'ended', endedAt: NOW - 2_000 }),
    ]
    const { past } = partitionMeetings(meetings, NOW)
    expect(past.map((x) => x.id)).toEqual(['late', 'mid', 'early'])
  })

  it('mixed list: one live, one fresh-failed, one stale-ended', () => {
    const meetings = [
      m('live',  { botState: 'connected' }),
      m('fresh', { botState: 'failed', endedAt: NOW - 60_000 }),
      m('stale', { botState: 'ended',  endedAt: NOW - 999_999 }),
    ]
    const { active, past } = partitionMeetings(meetings, NOW)
    expect(active.map((x) => x.id).sort()).toEqual(['fresh', 'live'])
    expect(past.map((x) => x.id)).toEqual(['stale'])
  })
})
