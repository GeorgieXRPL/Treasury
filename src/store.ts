import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type DatabaseT from 'better-sqlite3';
import { createLogger } from '@amm/shared';

const log = createLogger('treasury:store');

// Same trick as @amm/core/store: load the native binding via createRequire so
// any future bundler that traces this file doesn't try to rewrite the
// `__dirname` better-sqlite3 reads at runtime.
const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Database: typeof DatabaseT = requireFromHere('better-sqlite3') as any;

export interface ClaimRecord {
  id: number;
  ts: number;
  creator: string;
  vaultBalanceLamportsBefore: string; // BN as string
  creatorLamportsBefore: string;
  creatorLamportsAfter: string;
  /** Net SOL gained by the creator wallet (lamports). Authoritative claim size. */
  claimedLamports: string;
  signature: string;
}

export interface SplitRecord {
  id: number;
  ts: number;
  creator: string;
  treasuryDest: string;
  bucketDest: string;
  treasuryLamports: string;
  bucketLamports: string;
  signature: string;
}

export interface BuybackRecord {
  id: number;
  ts: number;
  bucket: string;
  miningTreasury: string;
  tier: number;
  drawdownPct: number;
  lamportsIn: string;
  baseTokensOut: string;
  swapSignature: string;
  sweepSignature: string | null;
  /** Whether the swap was actually executed (false in dry-run). */
  live: number;
}

export interface PriceSample {
  ts: number;
  priceUsd: number;
}

export interface TierState {
  tierIndex: number;
  lastFiredAt: number;
}

/**
 * Tiny SQLite-backed persistence layer for the treasury engine. Lives at the
 * configured `filePath` (default `./treasury/.data/treasury.db`) and is
 * physically separate from the MM `@amm/core/Store` so the schemas can evolve
 * independently and a treasury db reset never disturbs MM history.
 *
 * Tables:
 *   - claims          one row per successful collect_coin_creator_fee
 *   - splits          one row per successful 30/70 split tx
 *   - buybacks        one row per buyback (incl. dry-run rows for replay)
 *   - price_samples   rolling-window high data, persisted across restarts
 *   - tier_state      per-tier lastFiredAt for cooldown enforcement across restarts
 *   - kv              free-form key/value for misc engine state (lastClaimAt, etc.)
 */
export class TreasuryStore {
  private db: DatabaseT.Database;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    log.info({ path: filePath }, 'treasury store opened');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        creator TEXT NOT NULL,
        vaultBalanceLamportsBefore TEXT NOT NULL,
        creatorLamportsBefore TEXT NOT NULL,
        creatorLamportsAfter TEXT NOT NULL,
        claimedLamports TEXT NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_claims_ts ON claims(ts);

      CREATE TABLE IF NOT EXISTS splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        creator TEXT NOT NULL,
        treasuryDest TEXT NOT NULL,
        bucketDest TEXT NOT NULL,
        treasuryLamports TEXT NOT NULL,
        bucketLamports TEXT NOT NULL,
        signature TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_splits_ts ON splits(ts);

      CREATE TABLE IF NOT EXISTS buybacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        bucket TEXT NOT NULL,
        miningTreasury TEXT NOT NULL,
        tier INTEGER NOT NULL,
        drawdownPct REAL NOT NULL,
        lamportsIn TEXT NOT NULL,
        baseTokensOut TEXT NOT NULL,
        swapSignature TEXT NOT NULL,
        sweepSignature TEXT,
        live INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_buybacks_ts ON buybacks(ts);

      CREATE TABLE IF NOT EXISTS price_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        priceUsd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_samples_ts ON price_samples(ts);

      CREATE TABLE IF NOT EXISTS tier_state (
        tierIndex INTEGER PRIMARY KEY,
        lastFiredAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
  }

  // -- claims ------------------------------------------------------------

  recordClaim(c: Omit<ClaimRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO claims
         (ts, creator, vaultBalanceLamportsBefore, creatorLamportsBefore, creatorLamportsAfter, claimedLamports, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.ts,
        c.creator,
        c.vaultBalanceLamportsBefore,
        c.creatorLamportsBefore,
        c.creatorLamportsAfter,
        c.claimedLamports,
        c.signature,
      );
  }

  recentClaims(limit = 50): ClaimRecord[] {
    return this.db
      .prepare(`SELECT * FROM claims ORDER BY id DESC LIMIT ?`)
      .all(limit) as ClaimRecord[];
  }

  // -- splits ------------------------------------------------------------

  recordSplit(s: Omit<SplitRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO splits
         (ts, creator, treasuryDest, bucketDest, treasuryLamports, bucketLamports, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.ts,
        s.creator,
        s.treasuryDest,
        s.bucketDest,
        s.treasuryLamports,
        s.bucketLamports,
        s.signature,
      );
  }

  recentSplits(limit = 50): SplitRecord[] {
    return this.db
      .prepare(`SELECT * FROM splits ORDER BY id DESC LIMIT ?`)
      .all(limit) as SplitRecord[];
  }

  // -- buybacks ----------------------------------------------------------

  recordBuyback(b: Omit<BuybackRecord, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO buybacks
         (ts, bucket, miningTreasury, tier, drawdownPct, lamportsIn, baseTokensOut, swapSignature, sweepSignature, live)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.ts,
        b.bucket,
        b.miningTreasury,
        b.tier,
        b.drawdownPct,
        b.lamportsIn,
        b.baseTokensOut,
        b.swapSignature,
        b.sweepSignature,
        b.live,
      );
  }

  recentBuybacks(limit = 50): BuybackRecord[] {
    return this.db
      .prepare(`SELECT * FROM buybacks ORDER BY id DESC LIMIT ?`)
      .all(limit) as BuybackRecord[];
  }

  /** Update the sweepSignature for the most recent buyback that lacks one. */
  attachSweepSignature(buybackId: number, sweepSignature: string): void {
    this.db
      .prepare(`UPDATE buybacks SET sweepSignature = ? WHERE id = ?`)
      .run(sweepSignature, buybackId);
  }

  /** Returns the lastInsertRowid from the latest `recordBuyback` call. */
  lastBuybackId(): number | undefined {
    const row = this.db.prepare(`SELECT MAX(id) AS id FROM buybacks`).get() as
      | { id: number | null }
      | undefined;
    return row?.id ?? undefined;
  }

  // -- price samples (for the rolling-window high) -----------------------

  appendPriceSample(s: PriceSample): void {
    this.db
      .prepare(`INSERT INTO price_samples (ts, priceUsd) VALUES (?, ?)`)
      .run(s.ts, s.priceUsd);
  }

  /** Return all samples with `ts >= cutoffMs`, oldest first. */
  loadPriceSamples(cutoffMs: number): PriceSample[] {
    return this.db
      .prepare(`SELECT ts, priceUsd FROM price_samples WHERE ts >= ? ORDER BY ts ASC`)
      .all(cutoffMs) as PriceSample[];
  }

  /** Drop samples older than `cutoffMs`. Cheap; runs on every loop tick. */
  prunePriceSamples(cutoffMs: number): void {
    this.db.prepare(`DELETE FROM price_samples WHERE ts < ?`).run(cutoffMs);
  }

  // -- tier state (per-tier lastFiredAt) ---------------------------------

  setTierFired(tierIndex: number, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO tier_state (tierIndex, lastFiredAt) VALUES (?, ?)
         ON CONFLICT(tierIndex) DO UPDATE SET lastFiredAt = excluded.lastFiredAt`,
      )
      .run(tierIndex, ts);
  }

  loadTierState(): TierState[] {
    return this.db.prepare(`SELECT tierIndex, lastFiredAt FROM tier_state`).all() as TierState[];
  }

  // -- kv ----------------------------------------------------------------

  setKv(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO kv (k, v, updatedAt) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(value), Date.now());
  }

  getKv<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(key) as
      | { v: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.v) as T;
  }

  close(): void {
    this.db.close();
  }
}
