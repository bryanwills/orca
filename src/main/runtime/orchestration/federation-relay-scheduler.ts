const FEDERATION_RELAY_BASE_DELAY_MS = 1_000
const FEDERATION_RELAY_MAX_DELAY_MS = 30_000
const FEDERATION_RELAY_MAX_CONCURRENCY = 4

type FederationRelayState = {
  inFlight: boolean
  nextAttemptAt: number
  retryDelayMs: number
}

export class FederationRelayScheduler {
  private readonly states = new Map<string, FederationRelayState>()
  private readonly ready = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDueAt = Number.POSITIVE_INFINITY
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
    for (const dispatchId of dispatchIds) {
      if (!this.states.has(dispatchId)) {
        this.states.set(dispatchId, {
          inFlight: false,
          nextAttemptAt: now,
          retryDelayMs: FEDERATION_RELAY_BASE_DELAY_MS
        })
        this.ready.add(dispatchId)
      }
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
    this.ready.clear()
  }

  private schedule(): void {
    if (this.running >= FEDERATION_RELAY_MAX_CONCURRENCY || this.states.size === 0) {
      return
    }
    let nextAttemptAt = this.ready.size > 0 ? Date.now() : Number.POSITIVE_INFINITY
    if (this.ready.size === 0) {
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
        this.ready.add(dispatchId)
      }
    }
    while (this.running < FEDERATION_RELAY_MAX_CONCURRENCY && this.ready.size > 0) {
      const dispatchId = this.ready.values().next().value as string
      this.ready.delete(dispatchId)
      const state = this.states.get(dispatchId)
      if (!state || state.inFlight) {
        continue
      }
      state.inFlight = true
      this.running += 1
      void this.attempt(dispatchId, state, generation)
    }
    this.schedule()
  }

  private async attempt(
    dispatchId: string,
    state: FederationRelayState,
    generation: number
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
    state.nextAttemptAt = Date.now() + state.retryDelayMs
    this.schedule()
  }

  private removeIneligible(dispatchId: string): void {
    this.states.delete(dispatchId)
    this.ready.delete(dispatchId)
    this.callbacks.onIneligible(dispatchId)
  }
}
