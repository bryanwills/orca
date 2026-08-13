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
    const sync = vi.fn(
      (dispatchId: string) =>
        new Promise<void>((resolve) => {
          releases.set(dispatchId, resolve)
        })
    )
    const scheduler = new FederationRelayScheduler({
      isEligible: () => true,
      sync,
      onIneligible: () => {}
    })

    scheduler.ensure(['old'])
    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    scheduler.ensure(['new'])
    await vi.advanceTimersByTimeAsync(0)
    releases.get('old')?.()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(sync.mock.calls.map(([dispatchId]) => dispatchId)).toEqual(['old', 'new'])
    scheduler.stop()
  })
})
