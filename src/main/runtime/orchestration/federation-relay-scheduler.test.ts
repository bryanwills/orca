import { afterEach, describe, expect, it, vi } from 'vitest'
import { FederationRelayScheduler } from './federation-relay-scheduler'

describe('FederationRelayScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds relay fanout while giving every eligible Dispatch a turn', async () => {
    vi.useFakeTimers()
    const dispatchIds = Array.from({ length: 1_000 }, (_, index) => `dispatch_${index}`)
    const releases: (() => void)[] = []
    const calls: string[] = []
    let active = 0
    let peak = 0
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync: (dispatchId) => {
        calls.push(dispatchId)
        active += 1
        peak = Math.max(peak, active)
        return new Promise<void>((resolve) => {
          releases.push(() => {
            active -= 1
            resolve()
          })
        })
      },
      onIneligible: () => {}
    })

    scheduler.ensure(dispatchIds)
    await vi.advanceTimersByTimeAsync(0)
    expect({ calls: calls.length, peak, timers: vi.getTimerCount() }).toEqual({
      calls: 4,
      peak: 4,
      timers: 0
    })

    while (calls.length < dispatchIds.length) {
      releases.splice(0).forEach((release) => release())
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(new Set(calls)).toEqual(new Set(dispatchIds))
    expect(peak).toBe(4)

    releases.splice(0).forEach((release) => release())
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(dispatchIds.length)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(dispatchIds.length + 4)
    expect(peak).toBe(4)
    scheduler.stop()
  })

  it('does not let stopped work rearm a replaced scheduler generation', async () => {
    vi.useFakeTimers()
    const releases = new Map<string, () => void>()
    let active = 0
    let peak = 0
    const sync = vi.fn(
      (dispatchId: string) =>
        new Promise<void>((resolve) => {
          active += 1
          peak = Math.max(peak, active)
          releases.set(dispatchId, () => {
            active -= 1
            resolve()
          })
        })
    )
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync,
      onIneligible: () => {}
    })

    const oldDispatches = Array.from({ length: 4 }, (_, index) => `old_${index}`)
    const newDispatches = Array.from({ length: 4 }, (_, index) => `new_${index}`)
    scheduler.ensure(oldDispatches)
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    scheduler.ensure(newDispatches)
    await vi.advanceTimersByTimeAsync(0)
    expect(sync.mock.calls.map(([dispatchId]) => dispatchId)).toEqual(oldDispatches)

    oldDispatches.forEach((dispatchId) => releases.get(dispatchId)?.())
    await vi.advanceTimersByTimeAsync(0)

    expect(sync.mock.calls.map(([dispatchId]) => dispatchId)).toEqual([
      ...oldDispatches,
      ...newDispatches
    ])
    expect(peak).toBe(4)
    scheduler.stop()
  })

  it('runs newly ensured settlement ahead of the existing retry backlog', async () => {
    vi.useFakeTimers()
    const releases = new Map<string, () => void>()
    const calls: string[] = []
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync: (dispatchId) => {
        calls.push(dispatchId)
        return new Promise<void>((resolve) => releases.set(dispatchId, resolve))
      },
      onIneligible: () => {}
    })

    scheduler.ensure(Array.from({ length: 20 }, (_, index) => `historical_${index}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(4)

    scheduler.ensure(['live_completion'])
    releases.get('historical_0')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[4]).toBe('live_completion')

    releases.get('live_completion')?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    releases.get('historical_1')?.()
    await vi.advanceTimersByTimeAsync(0)
    releases.get('historical_2')?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.filter((dispatchId) => dispatchId === 'live_completion')).toHaveLength(2)
    scheduler.stop()
  })

  it('reserves capacity for a failed retry while priority work remains ready', async () => {
    vi.useFakeTimers()
    const releases = new Map<string, () => void>()
    const calls: string[] = []
    let retryAttempts = 0
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync: (dispatchId) => {
        calls.push(dispatchId)
        if (dispatchId === 'retry' && retryAttempts++ === 0) {
          return Promise.reject(new Error('offline'))
        }
        return new Promise<void>((resolve) => releases.set(dispatchId, resolve))
      },
      onIneligible: () => {}
    })

    scheduler.ensure(['retry'])
    await vi.advanceTimersByTimeAsync(0)
    scheduler.ensure(Array.from({ length: 4 }, (_, index) => `priority_${index}`))
    await vi.advanceTimersByTimeAsync(2_000)
    scheduler.ensure(['priority_queued'])
    releases.get('priority_0')?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.at(-1)).toBe('retry')
    scheduler.stop()
  })

  it('gives every first check a turn during sustained successful polling', async () => {
    vi.useFakeTimers()
    const releases = new Map<string, () => void>()
    const calls: string[] = []
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync: (dispatchId) => {
        calls.push(dispatchId)
        return new Promise<void>((resolve) => {
          releases.set(dispatchId, () => {
            releases.delete(dispatchId)
            resolve()
          })
        })
      },
      onIneligible: () => {}
    })
    const dispatchIds = Array.from({ length: 20 }, (_, index) => `dispatch_${index}`)

    scheduler.ensure(dispatchIds)
    await vi.advanceTimersByTimeAsync(0)
    for (let round = 0; round < dispatchIds.length && releases.size > 0; round += 1) {
      await vi.advanceTimersByTimeAsync(1_100)
      Array.from(releases.values()).forEach((release) => release())
      await vi.advanceTimersByTimeAsync(0)
      if (dispatchIds.every((dispatchId) => calls.includes(dispatchId))) {
        break
      }
    }

    expect(new Set(calls)).toEqual(new Set(dispatchIds))
    scheduler.stop()
  })
})
