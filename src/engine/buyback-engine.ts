import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  PriceOracle,
  type RpcManager,
  type TxExecutor,
} from '@amm/core';
import {
  JupiterVenue,
  PumpBondingClient,
  PumpSwapVenue,
  type VenueRegistry,
} from '@amm/venues';
import {
  LAMPORTS_PER_SOL,
  bnToDecimal,
  createLogger,
  decimalToBn,
  randomFloat,
} from '@amm/shared';
import type { ResolvedTreasuryConfig } from '../config.js';
import { TreasuryStore } from '../store.js';
import { DipTracker } from './dip-tracker.js';

const log = createLogger('treasury:engine');

/**
 * Jupiter→Pump (and similar) swaps CPI-create ATAs (`CreateIdempotent`). The
 * bucket must keep this many lamports **beyond** the swap principal or sim
 * fails with `InsufficientFundsForRent`. Config `bucketRentReserveLamports`
 * may be set lower for non-Jupiter venues; when `buyback.venue === 'jupiter'`
 * we never use less than this floor.
 */
const JUPITER_SWAP_CPI_RESERVE_FLOOR_LAMPORTS = 12_000_000;

export interface BuybackEngineDeps {
  rpc: RpcManager;
  exec: TxExecutor;
  venues: VenueRegistry;
  oracle: PriceOracle;
  store: TreasuryStore;
}

interface ResolvedPool {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  coinCreator: PublicKey;
}

/**
 * Standalone treasury / buyback engine.
 *
 * Each tick (every `loop.pollIntervalMs`) runs the following phases in
 * sequence, isolated by a single `inFlight` guard so a long phase can't
 * overlap the next tick:
 *
 *   1. claim+split (atomic)
 *               - if the on-chain coin_creator vault has > threshold and
 *                 claimIntervalMs has elapsed (and `claim.manualOnly` is
 *                 false), sign and send the collect_coin_creator_fee ix
 *                 from the creator wallet. When creatorWallet === payer
 *                 (default) the SDK auto-appends closeAccount(creatorWsolAta)
 *                 so the lamports land natively.
 *               - On success, immediately fires a follow-up SystemProgram
 *                 transfer tx that routes ONLY the just-claimed lamports
 *                 (treasuryBps to the treasury, remainder to the buyback
 *                 bucket if `split.bucketEnabled`). Pre-existing creator
 *                 wallet SOL is never touched.
 *               - Self-transfers (treasury == creator OR bucket == creator)
 *                 are detected and skipped.
 *
 *   2. dip      - sample the latest token price (Jupiter price oracle),
 *                 push to the rolling-window `DipTracker`. The tracker
 *                 persists samples through TreasuryStore so a restart
 *                 doesn't reset the rolling-high reference.
 *
 *   3. tranches - iterate dip tiers (sorted ascending by drawdownPct).
 *                 Fire any tier whose drawdown is met AND whose cooldown
 *                 has elapsed AND whose trancheSol fits in the bucket.
 *                 After firing tier N, mark tiers <= N as fired so a -5%
 *                 trigger doesn't keep refiring while -20% is also true.
 *                 After each successful swap, sweep the buyback hot
 *                 wallet's *entire* base-token balance to the mining
 *                 treasury (self-healing — if a previous sweep failed,
 *                 this one picks it up).
 *
 * Phases 2 and 3 are skipped entirely when `runtimeSkipBuybacks` is true.
 * Phase 1 is skipped when `claim.manualOnly` is true (only the dashboard's
 * "Claim NOW (live)" button can fire claims in that mode).
 *
 * Persistence: `lastClaimAttemptAt`, per-tier `lastFiredAt`, and price
 * samples all flow through TreasuryStore, so the engine resumes coherently
 * after a process restart.
 */
export interface ClaimResult {
  ok: boolean;
  signature?: string;
  claimedLamports?: string;
  vaultBalanceBefore?: string;
  error?: string;
}

export interface ManualBuybackOpts {
  /** SOL to swap, in lamports. Must be > 0 and ≤ bucket balance - reserve. */
  lamports: number;
  /** Override config slippageBps. Default = config.buyback.slippageBps. */
  slippageBps?: number;
  /**
   * If true, after a successful swap also sweep the bucket's full base-token
   * balance to the mining-treasury wallet. Default false for manual ops so
   * the user can inspect the bucket before pushing to cold storage.
   */
  sweepAfter?: boolean;
  /**
   * If true, ignore the engine's runtime dryRun flag and send a real swap.
   * Default false: with dryRun=true, this method only logs what it would do
   * and records a dry-run buyback row.
   */
  liveDespiteDryRun?: boolean;
}

export interface ManualBuybackResult {
  ok: boolean;
  swapSignature?: string;
  baseTokensOut?: string;
  sweepSignature?: string | null;
  lamportsIn?: string;
  slippageBps?: number;
  venue?: 'jupiter' | 'pumpswap';
  dryRun?: boolean;
  error?: string;
}

export interface EngineSnapshot {
  running: boolean;
  inFlight: boolean;
  dryRun: boolean;
  skipBuybacks: boolean;
  startedAtMs: number | null;
  lastTickAtMs: number;
  lastClaimAttemptAtMs: number;
  pollIntervalMs: number;
  pool: {
    poolId: string;
    baseMint: string;
    quoteMint: string;
    baseDecimals: number;
    quoteDecimals: number;
    coinCreator: string;
    /** Active claim instruction path for this pool. */
    claimModel: 'sharing-config' | 'legacy-amm' | null;
  } | null;
  dip: {
    samples: number;
    current: number | null;
    high: number | null;
    drawdownPct: number;
    windowSec: number;
    series: { ts: number; priceUsd: number }[];
    /** Unit of `current` / `high` / `series[].priceUsd`. SOL-per-token by design. */
    priceUnit: 'sol-per-token';
    /** Source of the most recent sample, or null if none yet. */
    lastSource: 'jupiter' | 'pumpswap-reserves' | null;
  };
  tiers: {
    idx: number;
    drawdownPct: number;
    trancheSol: number;
    cooldownMs: number;
    lastFiredAtMs: number | null;
    cooldownRemainingMs: number;
    drawdownMet: boolean;
    eligible: boolean;
  }[];
  wallets: {
    creator: string;
    buybackHot: string;
    treasury: string;
    miningTreasury: string;
    claimPayer: string | null;
  };
  config: {
    treasuryBps: number;
    bucketBps: number | null;
    minSplitLamports: number;
    creatorRentReserveLamports: number;
    bucketEnabled: boolean;
    claimThresholdLamports: number;
    claimIntervalMs: number;
    claimManualOnly: boolean;
    bucketRentReserveLamports: number;
    /** Max(configured reserve, Jupiter CPI floor) — value used when sizing swaps. */
    bucketRentReserveEffectiveLamports: number;
    venue: 'jupiter' | 'pumpswap';
    slippageBps: number;
    slippageJitter: number;
    useJito: boolean;
    dipWindowSec: number;
  };
}

export class BuybackEngine {
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private inFlight = false;
  private startedAt: number | null = null;
  private lastTickAt = 0;

  /**
   * Mutable runtime mirror of cfg.loop.dryRun. The web UI / `setDryRun()` API
   * flips this without restarting the engine. cfg stays immutable so the
   * config-on-disk is always the source-of-truth at startup.
   */
  private runtimeDryRun: boolean;

  /**
   * Mutable runtime mirror of cfg.loop.skipBuybacks. Toggling this skips the
   * dip + tranche phases of every subsequent tick (claim + split keep running).
   */
  private runtimeSkipBuybacks: boolean;

  /**
   * Last price source used in tickDip. Tracked so the dip window is reset
   * whenever the source flips (Jupiter ↔ pumpswap-reserves) — necessary
   * because the two can disagree by a few percent on illiquid pairs even
   * though both produce SOL-per-token.
   */
  private lastPriceSource: 'jupiter' | 'pumpswap-reserves' | null = null;

  /**
   * Lazy PumpBondingClient — used by the new sharing-config-aware claim
   * path. We instantiate on first use rather than in the constructor so the
   * connection ref stays the one RpcManager hands out per-call (which gives
   * us the round-robin / failover behaviour for free).
   */
  private _pumpBonding: PumpBondingClient | null = null;
  private get pumpBonding(): PumpBondingClient {
    // Use pickConnection() so each call goes through the round-robin /
    // failover path. Caching the client itself is fine — it stores no
    // per-connection state — but we'd give up the failover behaviour if
    // we cached the Connection too.
    if (!this._pumpBonding) {
      this._pumpBonding = new PumpBondingClient(this.deps.rpc.pickConnection());
    }
    return this._pumpBonding;
  }

  /**
   * Cached classification of the pool's claim model, set during resolvePool().
   *   - 'sharing-config': pool has been migrated. Use the permissionless
   *     `pump:distribute_creator_fees` instruction (split across the
   *     shareholders defined on-chain). Read fees from the creator_vault PDA
   *     keyed by the sharing-config PDA.
   *   - 'legacy-amm':     pool still uses the original creator-pays
   *     `pump_amm:collect_coin_creator_fee` path. Read fees from the WSOL
   *     vault ATA owned by the configured creator wallet.
   */
  private claimModel: 'sharing-config' | 'legacy-amm' | null = null;
  /**
   * Cached shareholder list for sharing-config pools, in the on-chain order
   * the program expects in `remaining_accounts`. Populated by `resolvePool`
   * and reused on every claim (the list is permanent for any pool whose
   * SharingConfig has `admin_revoked = true`, which is the common case).
   * Null until pool resolution completes; null forever for legacy pools.
   */
  private sharingShareholders: PublicKey[] | null = null;

  /**
   * Resolve fn for the in-flight `waitForNextTick` promise. When set, calling
   * it ends the current sleep early so the loop performs another tick
   * immediately. Used by `triggerTickSoon()` and `forceClaimNow()`.
   */
  private wakeNow: (() => void) | null = null;

  private readonly dip: DipTracker;
  /** tierIndex -> ms epoch of the last successful fire, persisted via store. */
  private readonly tierLastFired = new Map<number, number>();
  private lastClaimAttemptAt = 0;

  private resolvedPool?: ResolvedPool;

  constructor(
    private readonly cfg: ResolvedTreasuryConfig,
    private readonly deps: BuybackEngineDeps,
  ) {
    this.runtimeDryRun = cfg.loop.dryRun;
    this.runtimeSkipBuybacks = cfg.loop.skipBuybacks;
    // Window for the rolling-high. Tracker auto-loads any persisted samples.
    this.dip = new DipTracker(this.cfg.buyback.dipReferenceWindowSec * 1000, deps.store);
    for (const t of deps.store.loadTierState()) {
      this.tierLastFired.set(t.tierIndex, t.lastFiredAt);
    }
    const persistedClaimAt = deps.store.getKv<number>('lastClaimAttemptAt');
    if (typeof persistedClaimAt === 'number') {
      this.lastClaimAttemptAt = persistedClaimAt;
    }
    // Restore a previously web-toggled dryRun so a restart doesn't silently
    // revert to whatever's on disk.
    const persistedDryRun = deps.store.getKv<boolean>('runtimeDryRun');
    if (typeof persistedDryRun === 'boolean') {
      this.runtimeDryRun = persistedDryRun;
    }
    const persistedSkipBuybacks = deps.store.getKv<boolean>('runtimeSkipBuybacks');
    if (typeof persistedSkipBuybacks === 'boolean') {
      this.runtimeSkipBuybacks = persistedSkipBuybacks;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  isDryRun(): boolean {
    return this.runtimeDryRun;
  }

  isSkippingBuybacks(): boolean {
    return this.runtimeSkipBuybacks;
  }

  /**
   * Toggle dry-run at runtime without restarting. Persisted under kv so a
   * crash mid-run doesn't silently revert to the on-disk cfg setting.
   */
  setDryRun(value: boolean): void {
    this.runtimeDryRun = value;
    this.deps.store.setKv('runtimeDryRun', value);
    log.info({ dryRun: value }, 'dryRun toggled');
  }

  /**
   * Toggle the skip-buybacks runtime flag. When true, the engine still does
   * claim + split each tick but skips dip detection and tranche firing.
   * Persisted across restarts.
   */
  setSkipBuybacks(value: boolean): void {
    this.runtimeSkipBuybacks = value;
    this.deps.store.setKv('runtimeSkipBuybacks', value);
    log.info({ skipBuybacks: value }, 'skipBuybacks toggled');
  }

  /** Min lamports left on buyback-hot after sizing a swap (rent + fee headroom). */
  private swapReserveLamports(): number {
    const cfg = this.cfg.buyback.bucketRentReserveLamports;
    if (this.cfg.buyback.venue === 'jupiter') {
      return Math.max(cfg, JUPITER_SWAP_CPI_RESERVE_FLOOR_LAMPORTS);
    }
    return cfg;
  }

  /**
   * End the current sleep early so the next tick runs immediately. No-op if
   * the loop is already mid-tick (the upcoming sleep at the end will be
   * shorter naturally).
   */
  triggerTickSoon(): void {
    const w = this.wakeNow;
    if (w) w();
  }

  /**
   * Reset the claim-cooldown so the next tick definitely re-evaluates the
   * claim phase, then wake the loop. Used by the web UI's "claim now" button.
   */
  forceClaimNow(): void {
    this.lastClaimAttemptAt = 0;
    this.deps.store.setKv('lastClaimAttemptAt', 0);
    this.triggerTickSoon();
    log.info('forced claim cooldown reset; loop will retry on next tick');
  }

  /**
   * Live, JSON-friendly view of engine internals + the resolved config. The
   * web UI polls this every few seconds. No RPC / on-chain reads happen
   * here — all data is in-process — so this is cheap to call frequently.
   */
  getSnapshot(): EngineSnapshot {
    const now = Date.now();
    const cur = this.dip.current() ?? null;
    const high = this.dip.high() ?? null;
    const drawdown = this.dip.drawdownPct();

    const tiers = this.cfg.buyback.tiers.map((t, idx) => {
      const last = this.tierLastFired.get(idx) ?? null;
      const remaining = last === null ? 0 : Math.max(0, t.cooldownMs - (now - last));
      const drawdownMet = drawdown >= t.drawdownPct;
      return {
        idx,
        drawdownPct: t.drawdownPct,
        trancheSol: t.trancheSol,
        cooldownMs: t.cooldownMs,
        lastFiredAtMs: last,
        cooldownRemainingMs: remaining,
        drawdownMet,
        eligible: drawdownMet && remaining === 0,
      };
    });

    return {
      running: this.running,
      inFlight: this.inFlight,
      dryRun: this.runtimeDryRun,
      skipBuybacks: this.runtimeSkipBuybacks,
      startedAtMs: this.startedAt,
      lastTickAtMs: this.lastTickAt,
      lastClaimAttemptAtMs: this.lastClaimAttemptAt,
      pollIntervalMs: this.cfg.loop.pollIntervalMs,
      pool: this.resolvedPool
        ? {
            poolId: this.cfg.pool.toBase58(),
            baseMint: this.resolvedPool.baseMint.toBase58(),
            quoteMint: this.resolvedPool.quoteMint.toBase58(),
            baseDecimals: this.resolvedPool.baseDecimals,
            quoteDecimals: this.resolvedPool.quoteDecimals,
            coinCreator: this.resolvedPool.coinCreator.toBase58(),
            claimModel: this.claimModel,
          }
        : null,
      dip: {
        samples: this.dip.size(),
        current: cur,
        high,
        drawdownPct: drawdown,
        windowSec: this.cfg.buyback.dipReferenceWindowSec,
        series: this.dip.snapshotSeries(),
        priceUnit: 'sol-per-token',
        lastSource: this.lastPriceSource,
      },
      tiers,
      wallets: {
        creator: this.cfg.wallets.creator.publicKey.toBase58(),
        buybackHot: this.cfg.wallets.buybackHot.publicKey.toBase58(),
        treasury: this.cfg.wallets.treasury.toBase58(),
        miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
        claimPayer: this.cfg.wallets.claimPayer?.publicKey.toBase58() ?? null,
      },
      config: {
        treasuryBps: this.cfg.split.treasuryBps,
        bucketBps: this.cfg.split.bucketBps,
        minSplitLamports: this.cfg.split.minSplitLamports,
        creatorRentReserveLamports: this.cfg.split.creatorRentReserveLamports,
        bucketEnabled: this.cfg.split.bucketEnabled,
        claimThresholdLamports: this.cfg.claim.thresholdLamports,
        claimIntervalMs: this.cfg.claim.intervalMs,
        claimManualOnly: this.cfg.claim.manualOnly,
        bucketRentReserveLamports: this.cfg.buyback.bucketRentReserveLamports,
        bucketRentReserveEffectiveLamports: this.swapReserveLamports(),
        venue: this.cfg.buyback.venue,
        slippageBps: this.cfg.buyback.slippageBps,
        slippageJitter: this.cfg.buyback.slippageJitter,
        useJito: this.cfg.buyback.useJito,
        dipWindowSec: this.cfg.buyback.dipReferenceWindowSec,
      },
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.startedAt = Date.now();
    log.info(
      {
        pool: this.cfg.pool.toBase58(),
        creator: this.cfg.wallets.creator.publicKey.toBase58(),
        bucket: this.cfg.wallets.buybackHot.publicKey.toBase58(),
        treasury: this.cfg.wallets.treasury.toBase58(),
        miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
        treasuryBps: this.cfg.split.treasuryBps,
        tiers: this.cfg.buyback.tiers.length,
        dryRun: this.runtimeDryRun,
      },
      'treasury engine starting',
    );
    this.loopPromise = this.loop().catch((e) => {
      log.error({ err: (e as Error).message }, 'treasury loop crashed');
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    // Wake any in-flight sleep so the loop can observe stopRequested and exit.
    this.triggerTickSoon();
    if (this.loopPromise) await this.loopPromise;
    this.running = false;
    log.info('treasury engine stopped');
  }

  private async loop(): Promise<void> {
    await this.resolvePool();

    while (!this.stopRequested) {
      if (this.inFlight) {
        // Should never happen — guard against future accidental concurrent ticks.
        await this.waitForNextTick();
        continue;
      }
      this.inFlight = true;
      try {
        await this.tick();
        this.lastTickAt = Date.now();
      } catch (e) {
        log.error({ err: (e as Error).message.slice(0, 500) }, 'tick crashed');
      } finally {
        this.inFlight = false;
      }
      await this.waitForNextTick();
    }
  }

  /**
   * Sleep up to `pollIntervalMs` but resolve early if `stopRequested` is set
   * or `triggerTickSoon()` is called. Replaces the old fixed-step sleep so
   * the web UI can ask the engine to act now without waiting out the
   * remainder of the poll interval.
   */
  private waitForNextTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.wakeNow === finish) this.wakeNow = null;
        clearInterval(timer);
        resolve();
      };
      this.wakeNow = finish;
      const timer = setInterval(() => {
        if (this.stopRequested) finish();
        else if (Date.now() - start >= this.cfg.loop.pollIntervalMs) finish();
      }, 200);
    });
  }

  private async tick(): Promise<void> {
    // Each phase is isolated so one failing doesn't stop the others.
    // The claim phase ALSO performs the split atomically (in a follow-up tx)
    // when it succeeds — there is no longer a standalone tickSplit that
    // scans the creator wallet's balance, because that footgun caused
    // pre-existing creator wallet SOL to leak into the bucket on the first
    // tick after dryRun was flipped off.
    const startedAt = Date.now();
    let claimPhase: 'skipped-manual' | 'ran' | 'failed' = 'skipped-manual';
    let buybackPhase: 'skipped-flag' | 'ran' | 'failed' = 'skipped-flag';

    if (!this.cfg.claim.manualOnly) {
      claimPhase = 'ran';
      await this.tickClaim().catch((e) => {
        claimPhase = 'failed';
        log.warn({ phase: 'claim', err: (e as Error).message.slice(0, 500) }, 'claim phase failed');
      });
    }

    // Always sample the price into the dip tracker, even when buybacks are
    // skipped. Sampling is read-only (a single price RPC + an in-memory ring
    // buffer write) and gives the operator visibility in the dashboard's
    // "DIP TRACKER" card so they can see the current price + drawdown
    // shaping up before flipping skipBuybacks off. Tranche FIRING is the
    // thing that actually moves SOL, and that stays gated below.
    await this.tickDip().catch((e) => {
      log.warn({ phase: 'dip', err: (e as Error).message.slice(0, 500) }, 'dip phase failed');
    });

    if (!this.runtimeSkipBuybacks) {
      buybackPhase = 'ran';
      await this.tickTranches().catch((e) => {
        buybackPhase = 'failed';
        log.warn({ phase: 'tranches', err: (e as Error).message.slice(0, 500) }, 'tranches phase failed');
      });
    }

    // Single info-level breadcrumb per tick so users clicking "Tick now" in
    // the dashboard get visible feedback even when every phase is a no-op
    // (e.g. manual-only claims + skip-buybacks safe mode). Without this the
    // dashboard's "tick requested" toast had no corresponding log line and
    // the engine looked dead.
    log.info(
      {
        ms: Date.now() - startedAt,
        claim: claimPhase,
        buyback: buybackPhase,
        dip: {
          src: this.lastPriceSource,
          samples: this.dip.size(),
          drawdownPct: +(this.dip.drawdownPct() * 100).toFixed(3),
        },
        dryRun: this.runtimeDryRun,
      },
      'tick complete',
    );
  }

  /**
   * Sign and send a real `collect_coin_creator_fee` tx right now, regardless
   * of dryRun, the per-claim cooldown, or the on-chain vault threshold. Wired
   * to the dashboard's "Claim NOW (live)" button.
   *
   * Returns a structured result instead of throwing so the web layer can show
   * a clear success / error message rather than swallowing the exception.
   * After a successful claim, wakes the loop so the split phase runs on the
   * next iteration without waiting out the poll interval.
   *
   * Respects the inFlight guard so a manual claim doesn't race a tick that's
   * already running.
   */
  async forceLiveClaim(): Promise<ClaimResult> {
    if (!this.running) return { ok: false, error: 'engine is not running' };
    if (this.inFlight) {
      return { ok: false, error: 'engine is mid-tick; try again in a few seconds' };
    }
    if (!this.resolvedPool) {
      return { ok: false, error: 'pool not resolved yet (engine still starting)' };
    }
    this.inFlight = true;
    try {
      return await this.runLiveClaim();
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    } finally {
      this.inFlight = false;
      // Either way, give the loop a kick so its next tick sees the new state.
      this.triggerTickSoon();
    }
  }

  private async runLiveClaim(): Promise<ClaimResult> {
    const vaultBalance = await this.readUnclaimedVaultLamports();
    if (vaultBalance.isZero()) {
      return { ok: false, error: 'creator vault is empty (nothing to claim)' };
    }
    const r = await this.runClaimAndSplit(vaultBalance);
    if (r.ok) {
      this.markClaimAttempted(Date.now());
      log.info({ sig: r.signature?.slice(0, 12), manual: true }, 'manual claim+split succeeded');
    }
    return r;
  }

  /**
   * Manual one-off buyback. Bypasses dip detection + tier cooldowns entirely.
   * Wired to the dashboard's "Buyback NOW" form so users can sanity-check the
   * swap path (Jupiter / pumpswap routing, slippage, RPC priority) on a small
   * amount BEFORE flipping `skipBuybacks: false` to enable the full auto loop.
   *
   * Records the buyback with `tier: -1` to flag it as manual in the DB and
   * dashboard. By default does NOT sweep to mining-treasury so the user can
   * inspect the bucket. Set sweepAfter=true to mirror the auto-loop's
   * full swap+sweep behavior.
   *
   * Honors the runtime dryRun flag unless `liveDespiteDryRun: true` — gives a
   * sane "show what would happen" mode without forcing the user to flip the
   * global toggle.
   */
  async forceBuyback(opts: ManualBuybackOpts): Promise<ManualBuybackResult> {
    log.info(
      {
        lamports: opts.lamports,
        slippageBps: opts.slippageBps,
        sweepAfter: Boolean(opts.sweepAfter),
        liveDespiteDryRun: Boolean(opts.liveDespiteDryRun),
      },
      'manual buyback requested',
    );
    if (!this.running) {
      log.warn('manual buyback rejected: engine not running');
      return { ok: false, error: 'engine is not running' };
    }
    if (this.inFlight) {
      log.warn('manual buyback rejected: tick in flight');
      return { ok: false, error: 'engine is mid-tick; try again in a few seconds' };
    }
    if (!this.resolvedPool) {
      log.warn('manual buyback rejected: pool not yet resolved');
      return { ok: false, error: 'pool not resolved yet (engine still starting)' };
    }
    const lamports = Math.floor(opts.lamports);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      log.warn({ raw: opts.lamports }, 'manual buyback rejected: invalid lamports');
      return { ok: false, error: 'lamports must be a positive integer' };
    }

    this.inFlight = true;
    try {
      return await this.runManualBuyback(lamports, opts);
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    } finally {
      this.inFlight = false;
      this.triggerTickSoon();
    }
  }

  private async runManualBuyback(
    lamports: number,
    opts: ManualBuybackOpts,
  ): Promise<ManualBuybackResult> {
    const pool = this.requirePool();
    const venueId = this.cfg.buyback.venue;
    const venue = this.deps.venues.get(venueId);
    const slippageBps = opts.slippageBps ?? this.cfg.buyback.slippageBps;

    // Bucket balance check — reuse the rent reserve from config so the
    // wallet never gets fully drained (would brick the next swap).
    const bucketBalance = await this.deps.rpc.getBalance(this.cfg.wallets.buybackHot.publicKey);
    const reserve = this.swapReserveLamports();
    if (lamports + reserve > bucketBalance) {
      return {
        ok: false,
        error:
          `bucket too small: requested ${lamports} + reserve ${reserve} > balance ${bucketBalance} (lamports)`,
      };
    }

    const dryRunActive = this.runtimeDryRun && !opts.liveDespiteDryRun;

    if (dryRunActive) {
      log.info(
        {
          lamports,
          sol: (lamports / LAMPORTS_PER_SOL).toFixed(6),
          venue: venueId,
          slippageBps,
          sweepAfter: Boolean(opts.sweepAfter),
        },
        'DRY RUN: would fire manual buyback',
      );
      this.deps.store.recordBuyback({
        ts: Date.now(),
        bucket: this.cfg.wallets.buybackHot.publicKey.toBase58(),
        miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
        tier: -1,
        drawdownPct: 0,
        lamportsIn: String(lamports),
        baseTokensOut: '0',
        swapSignature: 'dry-run-manual',
        sweepSignature: null,
        live: 0,
      });
      return {
        ok: true,
        dryRun: true,
        lamportsIn: String(lamports),
        slippageBps,
        venue: venueId,
        baseTokensOut: '0',
        swapSignature: 'dry-run-manual',
      };
    }

    // ---- live swap path ----
    const built = await venue.buildSwap({
      poolId: this.cfg.pool,
      inputMint: NATIVE_MINT,
      outputMint: pool.baseMint,
      amountIn: new BN(lamports),
      user: this.cfg.wallets.buybackHot.publicKey,
      slippageBps,
    });

    let luts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
    if (
      venueId === 'jupiter' &&
      built.addressLookupTables &&
      built.addressLookupTables.length > 0
    ) {
      luts = await (venue as JupiterVenue).loadLuts(built.addressLookupTables);
    }

    let swapSig: string;
    try {
      const r = await this.deps.exec.execute(
        this.cfg.wallets.buybackHot,
        built.instructions,
        {
          useJito: this.cfg.buyback.useJito,
          computeUnitLimit: this.cfg.buyback.computeUnitLimit,
          skipPreflight: false,
          maxRetries: 2,
        },
        built.signers ?? [],
        luts,
      );
      swapSig = r.signature;
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }

    const bucketBaseBalance = await this.readBucketBaseBalance(pool.baseMint);
    this.deps.store.recordBuyback({
      ts: Date.now(),
      bucket: this.cfg.wallets.buybackHot.publicKey.toBase58(),
      miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
      tier: -1,
      drawdownPct: 0,
      lamportsIn: String(lamports),
      baseTokensOut: bucketBaseBalance.toString(),
      swapSignature: swapSig,
      sweepSignature: null,
      live: 1,
    });
    const buybackId = this.deps.store.lastBuybackId();
    log.info(
      {
        lamports,
        sol: (lamports / LAMPORTS_PER_SOL).toFixed(6),
        venue: venueId,
        slippageBps,
        baseTokensOut: bucketBaseBalance.toString(),
        sig: swapSig.slice(0, 12),
      },
      'manual buyback fired',
    );

    let sweepSignature: string | null = null;
    if (opts.sweepAfter) {
      sweepSignature =
        (await this.sweepBoughtTokensToMiningTreasury(pool.baseMint, pool.baseDecimals).catch(
          (e) => {
            log.warn(
              { err: (e as Error).message.slice(0, 500) },
              'manual buyback sweep failed; tokens are in the buyback bucket',
            );
            return undefined;
          },
        )) ?? null;
      if (sweepSignature && buybackId !== undefined) {
        this.deps.store.attachSweepSignature(buybackId, sweepSignature);
      }
    }

    return {
      ok: true,
      swapSignature: swapSig,
      baseTokensOut: bucketBaseBalance.toString(),
      sweepSignature,
      lamportsIn: String(lamports),
      slippageBps,
      venue: venueId,
      dryRun: false,
    };
  }

  // ---------- phase: claim (+ bound split) ----------------------------

  private async tickClaim(): Promise<void> {
    const now = Date.now();
    if (now - this.lastClaimAttemptAt < this.cfg.claim.intervalMs) return;

    const vaultBalance = await this.readUnclaimedVaultLamports();
    if (vaultBalance.ltn(this.cfg.claim.thresholdLamports)) {
      log.debug(
        {
          vault: vaultBalance.toString(),
          threshold: this.cfg.claim.thresholdLamports,
          claimModel: this.claimModel,
        },
        'claim skipped: vault below threshold',
      );
      return;
    }
    if (this.runtimeDryRun) {
      log.info(
        { vaultLamports: vaultBalance.toString(), claimModel: this.claimModel },
        'DRY RUN: would claim + split creator fees',
      );
      this.markClaimAttempted(now);
      return;
    }
    const r = await this.runClaimAndSplit(vaultBalance);
    if (!r.ok) {
      log.warn({ err: r.error?.slice(0, 800) }, 'claim+split failed; will retry next tick');
      return;
    }
    this.markClaimAttempted(Date.now());
  }

  /**
   * Read the amount of SOL currently waiting to be distributed/collected,
   * in lamports. Routes through whichever claim model `resolvePool` detected
   * for this pool. For sharing-config pools this is the *gross* amount
   * across all shareholders; the creator wallet receives only its `bps/10000`
   * share when `distribute_creator_fees` fires.
   */
  private async readUnclaimedVaultLamports(): Promise<BN> {
    const pool = this.requirePool();
    if (this.claimModel === 'sharing-config') {
      // Unclaimed fees live in TWO places under the migrated model:
      //   (a) pump_amm WSOL ATA — every swap's creator-fee slice deposits
      //       here as wrapped SOL and stays until someone calls
      //       `transfer_creator_fees_to_pump`. This is where the bulk
      //       sits between claim cycles.
      //   (b) pump-bonding `creator_vault` PDA (native SOL) — what
      //       `distribute_creator_fees` actually splits to shareholders.
      // Pump.fun's UI shows the SUM of both as "Unclaimed". Our claim tx
      // chains transfer → distribute atomically, so the engine must
      // surface the same combined number or the operator sees a tiny
      // dust value while the real fees pile up upstream.
      const pumpswap = this.deps.venues.get('pumpswap') as PumpSwapVenue;
      const [inAmm, inBonding] = await Promise.all([
        pumpswap.getPumpAmmVaultLamports(pool.coinCreator),
        this.pumpBonding.getCreatorVaultLamports(pool.baseMint),
      ]);
      return inAmm.add(inBonding);
    }
    const pumpswap = this.deps.venues.get('pumpswap') as PumpSwapVenue;
    return await pumpswap.getCreatorVaultBalance(pool.coinCreator);
  }

  private markClaimAttempted(ts: number): void {
    this.lastClaimAttemptAt = ts;
    this.deps.store.setKv('lastClaimAttemptAt', ts);
  }

  /**
   * Claim + split execution path. Used by both the auto-tick phase and the
   * manual "Claim NOW (live)" button. Two sequential txs:
   *
   *   tx1: collect_coin_creator_fee (+ closeAccount(creator WSOL ATA) when a
   *        separate claimPayer is configured — otherwise the SDK appends it).
   *   tx2: SystemProgram.transfer(s) routing the *just-claimed* lamports
   *        only. Pre-existing creator wallet SOL is never touched.
   *
   * Self-transfers (treasury == creator OR bucket == creator) are detected
   * and skipped — no point spending 5k lamports of fees to send SOL to
   * itself.
   */
  private async runClaimAndSplit(vaultBalance: BN): Promise<ClaimResult> {
    const pool = this.requirePool();
    const creator = this.cfg.wallets.creator;

    // We deliberately do NOT preflight `pool.coinCreator === creator.publicKey`
    // here. For sharing-config pools the on-chain coin_creator field is the
    // sharing-config PDA itself, so the equality could never hold. For
    // legacy pools, the user may have rotated the on-chain authority via
    // `set_creator` since we last cached it. Either way, we let the program
    // itself be the source of truth — sim catches wrong-signer rejections
    // before any fee is paid. resolvePool() already logged the relevant
    // warning at startup.

    const before = await this.deps.rpc.getBalance(creator.publicKey);

    // ---- tx1: claim ----
    const payer = this.cfg.wallets.claimPayer ?? creator;
    const claimIxs = await this.buildClaimIxs(payer);
    const extraSigners = payer.publicKey.equals(creator.publicKey) ? [] : [creator];

    let claimSig: string;
    try {
      // Sharing-config emits TWO ixs (transfer + distribute), each touching
      // multiple PDAs and an ATA close. Empirically lands at ~140-180k CU.
      // Legacy pools stay tiny (~30-50k). Use 220k for the multi-ix case so
      // we have headroom without overpaying priority fees, and keep the
      // tight 80k budget for legacy. skipPreflight stays false so simulation
      // catches wrong-signer rejections before we burn even the 5k-lamport
      // network fee.
      const computeUnitLimit = this.claimModel === 'sharing-config' ? 220_000 : 80_000;
      const r = await this.deps.exec.execute(
        payer,
        claimIxs,
        {
          computeUnitLimit,
          priorityMicroLamports: 1_000,
          skipPreflight: false,
          maxRetries: 2,
        },
        extraSigners,
      );
      claimSig = r.signature;
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }

    const after = await this.deps.rpc.getBalance(creator.publicKey);
    const claimed = new BN(after).sub(new BN(before));
    this.deps.store.recordClaim({
      ts: Date.now(),
      creator: creator.publicKey.toBase58(),
      vaultBalanceLamportsBefore: vaultBalance.toString(),
      creatorLamportsBefore: String(before),
      creatorLamportsAfter: String(after),
      claimedLamports: claimed.toString(),
      signature: claimSig,
    });
    log.info(
      {
        sig: claimSig.slice(0, 12),
        claimedSol: lamportsToSolStr(claimed),
        vaultBefore: lamportsToSolStr(vaultBalance),
      },
      'claim succeeded',
    );

    // ---- tx2: bound split (only of the just-claimed lamports) ----
    if (claimed.lten(0)) {
      // Nothing to split; record nothing.
      return {
        ok: true,
        signature: claimSig,
        claimedLamports: claimed.toString(),
        vaultBalanceBefore: vaultBalance.toString(),
      };
    }
    await this.runBoundSplit(creator, claimed, claimSig).catch((e) =>
      // Split failure is logged but does NOT fail the overall claim — the SOL
      // is safely in the creator wallet and the user can split it manually.
      log.warn({ err: (e as Error).message.slice(0, 500) }, 'bound split failed; SOL is in creator wallet'),
    );

    return {
      ok: true,
      signature: claimSig,
      claimedLamports: claimed.toString(),
      vaultBalanceBefore: vaultBalance.toString(),
    };
  }

  /**
   * Build the claim instruction(s) appropriate to this pool's claim model.
   *
   *   sharing-config: TWO permissionless ixs packed into a single tx:
   *     1) `pump_amm:transfer_creator_fees_to_pump` — drains the WSOL
   *        accumulator into the bonding-curve `creator_vault` (native SOL).
   *     2) `pump:distribute_creator_fees` — splits that vault among the
   *        configured shareholders atomically.
   *     Pump.fun's own "Claim and donate" button does the exact same pair.
   *     Skipping (1) is the bug that made our earlier reads show ~0.0009 SOL
   *     while the UI showed 0.56 SOL — almost everything sits upstream in
   *     the AMM vault until the transfer ix moves it.
   *
   *   legacy-amm: the original `pump_amm:collect_coin_creator_fee` path.
   *     When the configured payer is the creator, the SDK appends a
   *     `closeAccount(creatorWsolAta)` automatically. When a separate payer
   *     is in use, we append it ourselves.
   */
  private async buildClaimIxs(payer: Keypair): Promise<TransactionInstruction[]> {
    const pool = this.requirePool();

    if (this.claimModel === 'sharing-config') {
      // Both ixs are signer-less and arg-less; the payer just pays the tx
      // fee. Order matters: transfer must run before distribute or the
      // distribute ix will only split whatever residual already sat in the
      // bonding-curve vault.
      //
      // Distribute requires the shareholder list as `remaining_accounts`;
      // resolvePool() cached it. If the cache is empty something is very
      // wrong (we shouldn't be in this branch without sharing-config) — bail
      // loudly rather than emit a malformed ix.
      if (!this.sharingShareholders || this.sharingShareholders.length === 0) {
        throw new Error(
          'sharing-config claim path selected but shareholder cache is empty; restart engine to re-read SharingConfig',
        );
      }
      return [
        PumpSwapVenue.buildTransferCreatorFeesToPump(pool.coinCreator),
        this.pumpBonding.buildDistributeCreatorFees(
          pool.baseMint,
          this.sharingShareholders,
        ),
      ];
    }

    // Legacy fallback path
    const creator = this.cfg.wallets.creator;
    const pumpswap = this.deps.venues.get('pumpswap') as PumpSwapVenue;
    const built = await pumpswap.buildCollectCreatorFee(pool.coinCreator, payer.publicKey);
    const ixs: TransactionInstruction[] = [...built.instructions];
    if (!payer.publicKey.equals(creator.publicKey)) {
      const creatorWsolAta = await getAssociatedTokenAddress(
        NATIVE_MINT,
        creator.publicKey,
        false,
        TOKEN_PROGRAM_ID,
      );
      ixs.push(
        createCloseAccountInstruction(
          creatorWsolAta,
          creator.publicKey,
          creator.publicKey,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
    }
    return ixs;
  }

  private async runBoundSplit(
    creator: Keypair,
    claimed: BN,
    claimSignature: string,
  ): Promise<void> {
    const treasuryDest = this.cfg.wallets.treasury;
    const bucketDest = this.cfg.wallets.buybackHot.publicKey;
    const treasuryBps = this.cfg.split.treasuryBps;
    const bucketBps = this.cfg.split.bucketBps;
    const bucketEnabled = this.cfg.split.bucketEnabled;

    const treasurySelf = treasuryDest.equals(creator.publicKey);
    const bucketSelf = bucketDest.equals(creator.publicKey);

    // Split arithmetic — only on the claimed amount, never on pre-existing balance.
    //
    // Three ways to determine the bucket cut, in priority order:
    //   1. `bucketBps` set explicitly (new three-way model). Treasury and
    //      bucket each get their basis-point share; creator keeps whatever
    //      remainder is left after both transfers. e.g. 2000/5000 → 20% / 50%
    //      / 30% stays in creator.
    //   2. `bucketEnabled: true` and no `bucketBps` (legacy two-way model).
    //      Bucket gets EVERYTHING that isn't going to treasury (the historical
    //      30/70 routing).
    //   3. `bucketEnabled: false` and no `bucketBps`. Bucket gets nothing;
    //      everything not going to treasury stays in the creator.
    const treasuryLamports = treasuryBps > 0 ? Math.floor((claimed.toNumber() * treasuryBps) / 10_000) : 0;
    let bucketLamports: number;
    if (typeof bucketBps === 'number') {
      bucketLamports = bucketBps > 0 ? Math.floor((claimed.toNumber() * bucketBps) / 10_000) : 0;
    } else if (bucketEnabled) {
      bucketLamports = claimed.toNumber() - treasuryLamports;
    } else {
      bucketLamports = 0;
    }
    const creatorRetainLamports = claimed.toNumber() - treasuryLamports - bucketLamports;

    const ixs: TransactionInstruction[] = [];
    let actualTreasury = 0;
    let actualBucket = 0;
    if (treasuryLamports > 0 && !treasurySelf) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: treasuryDest,
          lamports: treasuryLamports,
        }),
      );
      actualTreasury = treasuryLamports;
    }
    if (bucketLamports > 0 && !bucketSelf) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: bucketDest,
          lamports: bucketLamports,
        }),
      );
      actualBucket = bucketLamports;
    }

    if (ixs.length === 0) {
      log.info(
        {
          claimSig: claimSignature.slice(0, 12),
          treasurySelf,
          bucketEnabled,
          bucketBps,
          bucketSelf,
          retainedInCreatorLamports: creatorRetainLamports,
        },
        'split has nothing to do (all destinations are creator-self or disabled); skipping tx',
      );
      return;
    }

    const result = await this.deps.exec.execute(
      creator,
      ixs,
      // Two transfers max; pin tiny CU + 0 priority — bookkeeping op.
      { computeUnitLimit: 2_000, priorityMicroLamports: 0, skipPreflight: false, maxRetries: 2 },
    );
    this.deps.store.recordSplit({
      ts: Date.now(),
      creator: creator.publicKey.toBase58(),
      treasuryDest: treasuryDest.toBase58(),
      bucketDest: bucketDest.toBase58(),
      treasuryLamports: String(actualTreasury),
      bucketLamports: String(actualBucket),
      signature: result.signature,
    });
    log.info(
      {
        sig: result.signature.slice(0, 12),
        claimSig: claimSignature.slice(0, 12),
        treasurySol: lamportsToSolStr(new BN(actualTreasury)),
        bucketSol: lamportsToSolStr(new BN(actualBucket)),
        creatorRetainedSol: lamportsToSolStr(new BN(creatorRetainLamports)),
      },
      'split succeeded',
    );
  }

  // ---------- phase: dip-detection ------------------------------------

  private async tickDip(): Promise<void> {
    const pool = this.requirePool();

    // Sample unit MUST stay consistent across the rolling window — the dip
    // tracker is unit-agnostic, so mixing USD-per-token from Jupiter with
    // SOL-per-token from on-chain reserves silently corrupts the rolling
    // high (e.g. SOL≈$170 turns a switch into a ~99.4% fake dip). We
    // standardize on SOL-per-token, which is also the unit the buyback
    // path actually cares about (we pay with SOL).
    let price = await this.deps.oracle.getPriceInSol(pool.baseMint);
    let source: 'jupiter' | 'pumpswap-reserves' = 'jupiter';
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      // Jupiter Price V3 sometimes lacks a quote (low-cap pump.fun tokens
      // missing from the SOL-pair index, transient API hiccups, etc.). Fall
      // back to the on-chain pumpswap pool reserves — same unit, no third
      // party. Either source produces SOL-per-token, so they're commensurable.
      const fallback = await this.derivePriceFromReserves(pool);
      if (fallback === undefined) {
        log.debug({ mint: pool.baseMint.toBase58() }, 'price probe returned no value (jupiter + pumpswap both empty)');
        return;
      }
      price = fallback;
      source = 'pumpswap-reserves';
    }

    // If the source flipped, wipe the window. Even with both sources in the
    // same unit, Jupiter's aggregated mid-price and a pure spot-pool reserve
    // can disagree by a few percent on illiquid pairs — enough to fake a tier
    // and fire a buyback we never intended. Trade off: ~`dipReferenceWindowSec`
    // of warm-up after every switch, which is the right call for safety.
    if (this.lastPriceSource && this.lastPriceSource !== source) {
      log.warn(
        { from: this.lastPriceSource, to: source, samplesCleared: this.dip.size() },
        'price source switched; resetting dip window to avoid cross-source false positives',
      );
      this.dip.reset();
    }
    this.lastPriceSource = source;

    const dropped = this.dip.push(price);
    log.info(
      {
        priceSol: +price.toFixed(12),
        source,
        highSol: this.dip.high(),
        drawdownPct: +(this.dip.drawdownPct() * 100).toFixed(3),
        samples: this.dip.size(),
        dropped,
      },
      'dip sample',
    );
  }

  /**
   * Compute the spot price (token in SOL) from the pumpswap pool reserves.
   * Returns undefined if the pool is empty or reserves can't be read.
   *
   * This is the dip-tracker's fallback when Jupiter has no quote — the
   * common case for pump.fun tokens that aren't on Jupiter's strict list.
   */
  private async derivePriceFromReserves(pool: ResolvedPool): Promise<number | undefined> {
    try {
      const pumpswap = this.deps.venues.get('pumpswap') as PumpSwapVenue;
      const { baseReserve, quoteReserve } = await pumpswap.getReserves(
        this.cfg.pool,
        // Any pubkey works for ATA derivation; reuse the buyback-hot key so
        // the SDK's account-info caching can amortize across this call and
        // the manual / auto buyback flows.
        this.cfg.wallets.buybackHot.publicKey,
      );
      if (baseReserve.isZero() || quoteReserve.isZero()) return undefined;
      // priceInSol = (quote / 10^quoteDec) / (base / 10^baseDec)
      // Use Number for the division — for any reasonable reserve sizes we're
      // well within Number precision (Solana caps total supply at u64 ≈ 1e19,
      // and after decimal-scaling the resulting double has 15+ sig figs).
      const num = Number(quoteReserve.toString()) / Math.pow(10, pool.quoteDecimals);
      const den = Number(baseReserve.toString()) / Math.pow(10, pool.baseDecimals);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return undefined;
      return num / den;
    } catch (e) {
      log.warn(
        { err: (e as Error).message.slice(0, 200) },
        'pumpswap reserves probe failed; dip sample skipped',
      );
      return undefined;
    }
  }

  // ---------- phase: phased buyback tranches --------------------------

  private async tickTranches(): Promise<void> {
    if (this.dip.empty) return;

    const drawdown = this.dip.drawdownPct();
    if (drawdown <= 0) return;

    const now = Date.now();
    const bucketBalance = await this.deps.rpc.getBalance(
      this.cfg.wallets.buybackHot.publicKey,
    );

    // Walk tiers from largest drawdown to smallest. The first tier whose
    // drawdown is satisfied AND whose cooldown is elapsed AND that fits in
    // the bucket gets fired. Then we mark all *smaller-or-equal-index*
    // tiers as fired so we don't immediately re-fire a small tier just
    // because the price is still down.
    const tiersDesc = [...this.cfg.buyback.tiers]
      .map((t, idx) => ({ ...t, idx }))
      .sort((a, b) => b.drawdownPct - a.drawdownPct);

    for (const tier of tiersDesc) {
      if (drawdown < tier.drawdownPct) continue;
      const last = this.tierLastFired.get(tier.idx) ?? 0;
      if (now - last < tier.cooldownMs) continue;

      const trancheLamports = Math.round(tier.trancheSol * LAMPORTS_PER_SOL);
      const reserve = this.swapReserveLamports();
      if (bucketBalance < trancheLamports + reserve) {
        log.info(
          {
            tier: tier.idx,
            need: trancheLamports + reserve,
            have: bucketBalance,
          },
          'tier triggered but bucket too small; skipping',
        );
        continue;
      }

      await this.fireTranche(tier.idx, tier, drawdown, trancheLamports);
      // After a successful (or even attempted) higher tier, mark all
      // smaller-drawdown tiers fired too so they don't re-fire on the same
      // dip event.
      const firedAt = Date.now();
      for (const t of this.cfg.buyback.tiers
        .map((t, idx) => ({ idx, drawdownPct: t.drawdownPct }))
        .filter((t) => t.drawdownPct <= tier.drawdownPct)) {
        this.tierLastFired.set(t.idx, firedAt);
        this.deps.store.setTierFired(t.idx, firedAt);
      }
      // Only fire one tier per tick to keep the loop predictable.
      return;
    }
  }

  private async fireTranche(
    tierIdx: number,
    tier: { drawdownPct: number; trancheSol: number; cooldownMs: number },
    observedDrawdown: number,
    trancheLamports: number,
  ): Promise<void> {
    const pool = this.requirePool();
    const venueId = this.cfg.buyback.venue;
    const venue = this.deps.venues.get(venueId);

    const slip = jitterSlip(this.cfg.buyback.slippageBps, this.cfg.buyback.slippageJitter);
    const amountIn = new BN(trancheLamports);

    if (this.runtimeDryRun) {
      log.info(
        {
          tier: tierIdx,
          drawdownPct: +(observedDrawdown * 100).toFixed(2),
          trancheSol: tier.trancheSol,
          venue: venueId,
          slip,
        },
        'DRY RUN: would fire tranche',
      );
      this.deps.store.recordBuyback({
        ts: Date.now(),
        bucket: this.cfg.wallets.buybackHot.publicKey.toBase58(),
        miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
        tier: tierIdx,
        drawdownPct: observedDrawdown,
        lamportsIn: amountIn.toString(),
        baseTokensOut: '0',
        swapSignature: 'dry-run',
        sweepSignature: null,
        live: 0,
      });
      return;
    }

    // Build the swap. WSOL → base mint. For Jupiter the poolId field is
    // ignored (Jupiter routes across all pools); for pumpswap we pass the
    // real pool id we resolved at startup.
    const built = await venue.buildSwap({
      poolId: this.cfg.pool,
      inputMint: NATIVE_MINT,
      outputMint: pool.baseMint,
      amountIn,
      user: this.cfg.wallets.buybackHot.publicKey,
      slippageBps: slip,
    });

    let luts: import('@solana/web3.js').AddressLookupTableAccount[] = [];
    if (
      venueId === 'jupiter' &&
      built.addressLookupTables &&
      built.addressLookupTables.length > 0
    ) {
      luts = await (venue as JupiterVenue).loadLuts(built.addressLookupTables);
    }

    let swapSig: string;
    try {
      const result = await this.deps.exec.execute(
        this.cfg.wallets.buybackHot,
        built.instructions,
        {
          useJito: this.cfg.buyback.useJito,
          computeUnitLimit: this.cfg.buyback.computeUnitLimit,
          skipPreflight: false,
          maxRetries: 2,
        },
        built.signers ?? [],
        luts,
      );
      swapSig = result.signature;
    } catch (e) {
      log.warn(
        {
          tier: tierIdx,
          drawdown: observedDrawdown,
          err: (e as Error).message.slice(0, 800),
        },
        'tranche swap failed',
      );
      return;
    }

    // Look up the actual base-token balance landed in the bucket so the
    // record reflects what we got, not what we asked for.
    const bucketBaseBalance = await this.readBucketBaseBalance(pool.baseMint);

    this.deps.store.recordBuyback({
      ts: Date.now(),
      bucket: this.cfg.wallets.buybackHot.publicKey.toBase58(),
      miningTreasury: this.cfg.wallets.miningTreasury.toBase58(),
      tier: tierIdx,
      drawdownPct: observedDrawdown,
      lamportsIn: amountIn.toString(),
      baseTokensOut: bucketBaseBalance.toString(),
      swapSignature: swapSig,
      sweepSignature: null,
      live: 1,
    });
    const buybackId = this.deps.store.lastBuybackId();

    log.info(
      {
        tier: tierIdx,
        drawdownPct: +(observedDrawdown * 100).toFixed(2),
        trancheSol: tier.trancheSol,
        baseTokensOut: bucketBaseBalance.toString(),
        sig: swapSig.slice(0, 12),
      },
      'tranche fired',
    );

    // Sweep the bucket's full base-token balance to the mining treasury.
    // Self-healing: sweeps any leftover from a prior failed sweep too.
    const sweepSig = await this.sweepBoughtTokensToMiningTreasury(
      pool.baseMint,
      pool.baseDecimals,
    ).catch((e) => {
      log.warn(
        { err: (e as Error).message.slice(0, 500) },
        'mining-treasury sweep failed; will retry next buyback',
      );
      return undefined;
    });
    if (sweepSig && buybackId !== undefined) {
      this.deps.store.attachSweepSignature(buybackId, sweepSig);
    }
  }

  // ---------- helpers --------------------------------------------------

  private async sweepBoughtTokensToMiningTreasury(
    baseMint: PublicKey,
    baseDecimals: number,
  ): Promise<string | undefined> {
    const balance = await this.readBucketBaseBalance(baseMint);
    if (balance.isZero()) return undefined;

    const fromAta = await getAssociatedTokenAddress(
      baseMint,
      this.cfg.wallets.buybackHot.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );
    const toAta = await getAssociatedTokenAddress(
      baseMint,
      this.cfg.wallets.miningTreasury,
      false,
      TOKEN_PROGRAM_ID,
    );

    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        this.cfg.wallets.buybackHot.publicKey,
        toAta,
        this.cfg.wallets.miningTreasury,
        baseMint,
        TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        fromAta,
        baseMint,
        toAta,
        this.cfg.wallets.buybackHot.publicKey,
        BigInt(balance.toString()),
        baseDecimals,
        [],
        TOKEN_PROGRAM_ID,
      ),
    ];

    const result = await this.deps.exec.execute(
      this.cfg.wallets.buybackHot,
      ixs,
      // Sweeps don't need priority and use minimal CU.
      { computeUnitLimit: 30_000, priorityMicroLamports: 0, skipPreflight: false, maxRetries: 2 },
    );
    log.info(
      {
        amount: balance.toString(),
        sig: result.signature.slice(0, 12),
      },
      'swept to mining treasury',
    );
    return result.signature;
  }

  /**
   * Read the buyback bucket's base-token balance (atomic). Returns BN(0) if
   * the wallet doesn't yet have an ATA — e.g. before the first buyback ever
   * lands.
   */
  private async readBucketBaseBalance(baseMint: PublicKey): Promise<BN> {
    try {
      const result = await this.deps.rpc.withRetry((c: Connection) =>
        c.getParsedTokenAccountsByOwner(this.cfg.wallets.buybackHot.publicKey, { mint: baseMint }),
      );
      if (!result.value.length) return new BN(0);
      let max = new BN(0);
      for (const a of result.value) {
        const data = a.account.data as {
          parsed?: { info?: { tokenAmount?: { amount?: string } } };
        };
        const amt = data.parsed?.info?.tokenAmount?.amount ?? '0';
        const bn = new BN(String(amt));
        if (bn.gt(max)) max = bn;
      }
      return max;
    } catch (e) {
      log.warn(
        {
          mint: baseMint.toBase58().slice(0, 8),
          err: (e as Error).message.slice(0, 200),
        },
        'bucket base-balance probe failed; treating as zero',
      );
      return new BN(0);
    }
  }

  private async resolvePool(): Promise<void> {
    const pumpswap = this.deps.venues.get('pumpswap') as PumpSwapVenue;
    const pool = await pumpswap.getPool(this.cfg.pool);

    // The pumpswap getPool uses our internal PoolRef shape; coinCreator
    // isn't on it, so re-fetch the raw account to get it.
    const onlinePool = await fetchRawPoolCoinCreator(pumpswap, this.cfg.pool);

    if (
      this.cfg.coinCreator &&
      !this.cfg.coinCreator.equals(onlinePool)
    ) {
      throw new Error(
        `config.coinCreator (${this.cfg.coinCreator.toBase58()}) does not match on-chain pool coin_creator (${onlinePool.toBase58()})`,
      );
    }

    // The "creator wallet must equal on-chain coin_creator" warn used to
    // live here unconditionally; it's now emitted only inside the
    // claimModel detection below, where it actually matters (legacy-amm
    // path needs the equality, sharing-config path doesn't).

    this.resolvedPool = {
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      baseDecimals: pool.baseDecimals,
      quoteDecimals: pool.quoteDecimals,
      coinCreator: onlinePool,
    };

    // Detect whether this pool has been migrated to the sharing-config
    // (multi-recipient) fee-distribution model. The presence of a non-null
    // SharingConfig PDA at `["sharing-config", mint]` (under the pfee
    // program) is the canonical signal: pump-fun's migration flow creates
    // this account atomically with `transfer_creator_fees_to_pump`, and
    // attempting `pump_amm:collect_coin_creator_fee` against a migrated
    // pool returns AnchorError 6048 `CreatorVaultMigratedToSharingConfig`.
    let sharing: Awaited<ReturnType<PumpBondingClient['readSharingConfig']>> = null;
    try {
      sharing = await this.pumpBonding.readSharingConfig(pool.baseMint);
    } catch (e) {
      log.warn(
        { err: (e as Error).message.slice(0, 200) },
        'sharing-config probe errored; assuming legacy claim path',
      );
    }
    this.claimModel = sharing ? 'sharing-config' : 'legacy-amm';
    this.sharingShareholders = sharing
      ? sharing.shareholders.map((s) => s.recipient)
      : null;

    if (sharing) {
      const myBps =
        sharing.shareholders.find((s) =>
          s.recipient.equals(this.cfg.wallets.creator.publicKey),
        )?.bps ?? 0;
      log.info(
        {
          claimModel: 'sharing-config',
          shareholders: sharing.shareholders.map((s) => ({
            recipient: s.recipient.toBase58(),
            bps: s.bps,
          })),
          configuredCreator: this.cfg.wallets.creator.publicKey.toBase58(),
          configuredCreatorBps: myBps,
          adminRevoked: sharing.adminRevoked,
        },
        'pool uses sharing-config fee distribution',
      );
      if (myBps === 0) {
        log.warn(
          { creator: this.cfg.wallets.creator.publicKey.toBase58() },
          'configured creator wallet is NOT a shareholder; engine will still trigger distributes (permissionless) but the creator wallet will receive 0 lamports per claim — bound split will be a no-op',
        );
      }
    } else if (
      !onlinePool.equals(this.cfg.wallets.creator.publicKey)
    ) {
      // Legacy path: the creator wallet MUST equal the on-chain coin_creator
      // because collect_coin_creator_fee requires it as a signer. With the
      // sharing-config path, this constraint goes away — the bonding curve
      // program is the only signer needed.
      log.warn(
        {
          creator: this.cfg.wallets.creator.publicKey.toBase58(),
          onChain: onlinePool.toBase58(),
        },
        'configured creator wallet does not match on-chain coin_creator; legacy claim phase will fail until reconciled',
      );
    }

    log.info(
      {
        baseMint: pool.baseMint.toBase58(),
        quoteMint: pool.quoteMint.toBase58(),
        baseDecimals: pool.baseDecimals,
        coinCreator: onlinePool.toBase58(),
        claimModel: this.claimModel,
      },
      'pool resolved',
    );
  }

  private requirePool(): ResolvedPool {
    if (!this.resolvedPool) throw new Error('pool not resolved yet (engine not started?)');
    return this.resolvedPool;
  }
}

// -- helpers --------------------------------------------------------------

/**
 * The PumpSwapVenue's getPool() doesn't surface `coinCreator`. Read it via the
 * underlying online SDK directly. We reach in once at startup; not hot path.
 */
async function fetchRawPoolCoinCreator(
  pumpswap: PumpSwapVenue,
  poolInput: PublicKey,
): Promise<PublicKey> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const online = (pumpswap as unknown as { online: any }).online;
  // Resolve the input (could be a token mint) by reusing getPool, which
  // caches the canonical resolution.
  const resolved = await pumpswap.getPool(poolInput);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await online.fetchPool(resolved.poolId);
  if (!raw?.coinCreator) {
    throw new Error(
      `pumpswap pool ${resolved.poolId.toBase58()} has no coinCreator field`,
    );
  }
  return raw.coinCreator as PublicKey;
}

function jitterSlip(baseBps: number, jitter: number): number {
  if (!jitter || jitter <= 0) return baseBps;
  return Math.max(1, Math.round(baseBps * randomFloat(1 - jitter, 1 + jitter)));
}

function lamportsToSolStr(lamports: BN): string {
  return bnToDecimal(lamports, 9).toFixed(6);
}

// Suppress unused-import warnings when neither Jupiter LUTs nor decimalToBn
// are exercised by a particular branch in a one-off run.
void decimalToBn;
