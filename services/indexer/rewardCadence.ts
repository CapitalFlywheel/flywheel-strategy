export const CONFIRMATION_SECONDS = 60 * 60;

export const CADENCE_LEVELS = [
  { minimumMarketCapUsd: 0, intervalSeconds: 10 * 60 },
  { minimumMarketCapUsd: 500_000, intervalSeconds: 20 * 60 },
  { minimumMarketCapUsd: 1_000_000, intervalSeconds: 30 * 60 },
  { minimumMarketCapUsd: 5_000_000, intervalSeconds: 60 * 60 }
] as const;

export interface CadenceState {
  confirmedLevel: number;
  candidateLevel: number | null;
  candidateSince: number | null;
  lastObservationTimestamp: number | null;
}

export class RewardCadenceTracker {
  private state: CadenceState;

  constructor(initial?: Partial<CadenceState>) {
    this.state = {
      confirmedLevel: initial?.confirmedLevel ?? 0,
      candidateLevel: initial?.candidateLevel ?? null,
      candidateSince: initial?.candidateSince ?? null,
      lastObservationTimestamp: initial?.lastObservationTimestamp ?? null,
    };
    if (this.state.confirmedLevel < 0 || this.state.confirmedLevel >= CADENCE_LEVELS.length) {
      throw new Error("INVALID_CONFIRMED_LEVEL");
    }
  }

  update(timestamp: number, rollingHourMarketCapUsd: number): CadenceState {
    const targetLevel = this.levelForMarketCap(rollingHourMarketCapUsd);
    const observationGap = this.state.lastObservationTimestamp === null
      ? 0
      : timestamp - this.state.lastObservationTimestamp;
    this.state.lastObservationTimestamp = timestamp;

    // We cannot prove that price stayed above a threshold while the monitor
    // was offline. A gap over two minutes restarts the one-hour confirmation.
    if (observationGap > 120) {
      this.state.candidateLevel = null;
      this.state.candidateSince = null;
    }

    // Levels only move upward after confirmation; a later dump cannot roll them back.
    if (targetLevel <= this.state.confirmedLevel) {
      this.state.candidateLevel = null;
      this.state.candidateSince = null;
      return this.snapshot();
    }

    if (this.state.candidateLevel !== targetLevel) {
      this.state.candidateLevel = targetLevel;
      this.state.candidateSince = timestamp;
      return this.snapshot();
    }

    if (timestamp - (this.state.candidateSince ?? timestamp) >= CONFIRMATION_SECONDS) {
      this.state.confirmedLevel = targetLevel;
      this.state.candidateLevel = null;
      this.state.candidateSince = null;
    }
    return this.snapshot();
  }

  currentIntervalSeconds(): number {
    return CADENCE_LEVELS[this.state.confirmedLevel].intervalSeconds;
  }

  snapshot(): CadenceState {
    return { ...this.state };
  }

  private levelForMarketCap(marketCapUsd: number): number {
    let level = 0;
    for (let i = 1; i < CADENCE_LEVELS.length; ++i) {
      if (marketCapUsd >= CADENCE_LEVELS[i].minimumMarketCapUsd) level = i;
    }
    return level;
  }
}
