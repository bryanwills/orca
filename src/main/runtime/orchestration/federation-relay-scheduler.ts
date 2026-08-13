const FEDERATION_RELAY_BASE_DELAY_MS = 1_000
const FEDERATION_RELAY_MAX_DELAY_MS = 30_000
const FEDERATION_RELAY_MAX_CONCURRENCY = 4

type FederationRelayLane = 'first' | 'recurring' | 'retry'

type FederationRelayState = {
  inFlight: boolean
  lane: FederationRelayLane
  nextAttemptAt: number
  retryDelayMs: number
}

export class FederationRelayScheduler {
  private readonly states = new Map<string, FederationRelayState>()
  private readonly firstReady = new Set<string>()
  private readonly recurringReady = new Set<string>()
  private readonly retryReady = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDueAt = Number.POSITIVE_INFINITY
  private readonly runningByLane: Record<FederationRelayLane, number> = {
    first: 0,
    recurring: 0,
    retry: 0
  }
  private running = 0
  private generation = 0

  constructor(
    private readonly callbacks: {
      isEligible: (dispatchId: string) => boolean
      sync: (dispatchId: string) => Promise<void>
      onIneligible: (dispatchId: string) => void
    }
  ) {}

  ensure(dispatchIds: string[]): void {
    const now = Date.now()
    const newlyReady: string[] = []
    for (const dispatchId of dispatchIds) {
      if (!this.states.has(dispatchId)) {
        this.states.set(dispatchId, {
          inFlight: false,
          lane: 'first',
          nextAttemptAt: now,
          retryDelayMs: FEDERATION_RELAY_BASE_DELAY_MS
        })
        newlyReady.push(dispatchId)
      }
    }
    if (newlyReady.length > 0) {
      this.prependReady(this.firstReady, newlyReady)
    }
    this.schedule()
  }

  stop(): void {
    this.generation += 1
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.timerDueAt = Number.POSITIVE_INFINITY
    this.states.clear()
    this.firstReady.clear()
    this.recurringReady.clear()
    this.retryReady.clear()
  }

  private schedule(): void {
    if (this.running >= FEDERATION_RELAY_MAX_CONCURRENCY || this.states.size === 0) {
      return
    }
    const hasReady =
      this.firstReady.size > 0 || this.recurringReady.size > 0 || this.retryReady.size > 0
    let nextAttemptAt = hasReady ? Date.now() : Number.POSITIVE_INFINITY
    if (!hasReady) {
      for (const state of this.states.values()) {
        if (!state.inFlight) {
          nextAttemptAt = Math.min(nextAttemptAt, state.nextAttemptAt)
        }
      }
    }
    if (!Number.isFinite(nextAttemptAt)) {
      return
    }
    if (this.timer && this.timerDueAt <= nextAttemptAt) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timerDueAt = nextAttemptAt
    const generation = this.generation
    this.timer = setTimeout(() => this.pump(generation), Math.max(0, nextAttemptAt - Date.now()))
    this.timer.unref?.()
  }

  private pump(generation: number): void {
    if (generation !== this.generation) {
      return
    }
    this.timer = null
    this.timerDueAt = Number.POSITIVE_INFINITY
    const now = Date.now()
    for (const [dispatchId, state] of this.states) {
      if (!state.inFlight && state.nextAttemptAt <= now) {
        this.readyForLane(state.lane).add(dispatchId)
      }
    }
    while (
      this.running < FEDERATION_RELAY_MAX_CONCURRENCY &&
      (this.firstReady.size > 0 || this.recurringReady.size > 0 || this.retryReady.size > 0)
    ) {
      const lane = this.selectLane()
      const ready = this.readyForLane(lane)
      const dispatchId = ready.values().next().value as string
      ready.delete(dispatchId)
      const state = this.states.get(dispatchId)
      if (!state || state.inFlight) {
        continue
      }
      state.inFlight = true
      this.running += 1
      this.runningByLane[lane] += 1
      void this.attempt(dispatchId, state, generation, lane)
    }
    this.schedule()
  }

  private async attempt(
    dispatchId: string,
    state: FederationRelayState,
    generation: number,
    lane: FederationRelayLane
  ): Promise<void> {
    let succeeded = false
    let eligible = true
    try {
      if (!this.callbacks.isEligible(dispatchId)) {
        eligible = false
      } else {
        await this.callbacks.sync(dispatchId)
        succeeded = true
      }
    } catch {
      // The scheduler owns retry timing; sync logs the first failure per Dispatch.
    }
    this.runningByLane[lane] -= 1
    if (generation !== this.generation) {
      this.running -= 1
      this.schedule()
      return
    }
    this.running -= 1
    state.inFlight = false
    if (!this.states.has(dispatchId)) {
      this.schedule()
      return
    }
    try {
      eligible = eligible && this.callbacks.isEligible(dispatchId)
    } catch {
      eligible = true
    }
    if (!eligible) {
      this.removeIneligible(dispatchId)
      this.schedule()
      return
    }
    state.retryDelayMs = succeeded
      ? FEDERATION_RELAY_BASE_DELAY_MS
      : Math.min(state.retryDelayMs * 2, FEDERATION_RELAY_MAX_DELAY_MS)
    state.lane = succeeded ? 'recurring' : 'retry'
    state.nextAttemptAt = Date.now() + state.retryDelayMs
    this.schedule()
  }

  private removeIneligible(dispatchId: string): void {
    this.states.delete(dispatchId)
    this.firstReady.delete(dispatchId)
    this.recurringReady.delete(dispatchId)
    this.retryReady.delete(dispatchId)
    this.callbacks.onIneligible(dispatchId)
  }

  private prependReady(ready: Set<string>, dispatchIds: string[]): void {
    if (dispatchIds.length === 0) {
      return
    }
    const existing = [...ready]
    ready.clear()
    dispatchIds.forEach((dispatchId) => ready.add(dispatchId))
    existing.forEach((dispatchId) => ready.add(dispatchId))
  }

  private readyForLane(lane: FederationRelayLane): Set<string> {
    if (lane === 'first') {
      return this.firstReady
    }
    return lane === 'recurring' ? this.recurringReady : this.retryReady
  }

  private selectLane(): FederationRelayLane {
    const lanes: FederationRelayLane[] = ['recurring', 'first', 'retry']
    return (
      lanes.find((lane) => this.readyForLane(lane).size > 0 && this.runningByLane[lane] === 0) ??
      lanes.find((lane) => this.readyForLane(lane).size > 0)!
    )
  }
}
