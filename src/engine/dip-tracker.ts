import type { TreasuryStore, PriceSample } from '../store.js';

/**
 * Rolling-window high tracker.
 *
 * Tracks `(timestamp, price)` samples within the last `windowMs`, and exposes
 * the current drawdown of the latest price relative to the rolling-window
 * high. Persistence-aware: a `TreasuryStore` is loaded on construction (so a
 * restart picks up where the previous process left off) and every appended
 * sample is mirrored to the store.
 *
 * Pure logic apart from the optional store IO. Time is injected via `now`
 * so the unit tests don't need to mock Date.now().
 */
export class DipTracker {
  /** In-memory buffer (chronological). */
  private samples: PriceSample[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly store: TreasuryStore | null = null,
    now: number = Date.now(),
  ) {
    if (this.store) {
      const cutoff = now - this.windowMs;
      this.samples = this.store.loadPriceSamples(cutoff);
    }
  }

  /**
   * Add a sample. Returns the dropped count so callers can log eviction.
   * Persisted to the store immediately so a crash inside the loop tick
   * doesn't lose the sample.
   */
  push(priceUsd: number, ts: number = Date.now()): number {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
    this.samples.push({ ts, priceUsd });
    if (this.store) {
      this.store.appendPriceSample({ ts, priceUsd });
    }
    return this.prune(ts);
  }

  /**
   * Drop in-memory samples older than `now - windowMs`. Also tells the
   * store to delete the matching rows so the table doesn't grow without
   * bound across restarts.
   */
  prune(now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    const before = this.samples.length;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    if (this.store) {
      this.store.prunePriceSamples(cutoff);
    }
    return before - this.samples.length;
  }

  /** True if there isn't enough data to compute a meaningful drawdown. */
  get empty(): boolean {
    return this.samples.length < 2;
  }

  /** Most recent price seen, or undefined if no samples. */
  current(): number | undefined {
    return this.samples[this.samples.length - 1]?.priceUsd;
  }

  /** Highest price seen within the rolling window, or undefined if no samples. */
  high(): number | undefined {
    if (this.samples.length === 0) return undefined;
    let h = this.samples[0]!.priceUsd;
    for (let i = 1; i < this.samples.length; i++) {
      const p = this.samples[i]!.priceUsd;
      if (p > h) h = p;
    }
    return h;
  }

  /**
   * Drawdown of the latest sample relative to the rolling-window high, in
   * the range [0, 1]. Returns 0 when we don't yet have enough data, when
   * price is at-or-above the high (no dip), or on degenerate inputs.
   * Never returns a negative number — buyback logic should treat 0 as
   * "no opportunity".
   */
  drawdownPct(): number {
    if (this.empty) return 0;
    const high = this.high();
    const cur = this.current();
    if (high === undefined || cur === undefined || high <= 0) return 0;
    const dd = (high - cur) / high;
    return dd > 0 ? dd : 0;
  }

  /** Sample count currently in the rolling window. */
  size(): number {
    return this.samples.length;
  }

  /**
   * Drop every in-memory sample and clear the persisted store. Use when
   * switching price sources (e.g. Jupiter → on-chain reserves) since mixing
   * sources with subtly different valuations can fake a dip and trigger
   * unintended buybacks.
   */
  reset(): void {
    this.samples = [];
    if (this.store) {
      // Use a far-future cutoff to delete every persisted row in one call.
      this.store.prunePriceSamples(Number.MAX_SAFE_INTEGER);
    }
  }

  /**
   * Read-only copy of the in-memory series, suitable for shipping over
   * JSON (no PriceSample identity references). Returned chronological;
   * the web UI sparkline relies on this ordering.
   */
  snapshotSeries(): { ts: number; priceUsd: number }[] {
    return this.samples.map((s) => ({ ts: s.ts, priceUsd: s.priceUsd }));
  }
}
