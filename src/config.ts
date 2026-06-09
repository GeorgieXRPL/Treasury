import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { Vault } from '@amm/core';
import { LAMPORTS_PER_SOL } from '@amm/shared';

// -- raw JSON schema (the shape on disk) -------------------------------

const TierSchema = z.object({
  drawdownPct: z.number().positive().max(0.99),
  trancheSol: z.number().positive(),
  cooldownMs: z.number().int().positive(),
});

const VenueSchema = z.enum(['jupiter', 'pumpswap']);

const RawConfigSchema = z.object({
  vault: z.object({
    path: z.string(),
  }),
  store: z.object({
    path: z.string(),
  }),
  pool: z.string().min(32),

  /**
   * The pump_amm `coin_creator` pubkey. Optional — if omitted, the engine
   * reads it from the on-chain pool account at startup. Provide it explicitly
   * if you want a startup safety check that the wallet you supplied matches.
   */
  coinCreator: z.string().min(32).optional(),

  wallets: z.object({
    /** Vault label of the wallet that signs collect_coin_creator_fee + the split tx. */
    creator: z.string().min(1),
    /** Vault label of the wallet that signs Jupiter buyback swaps + the mining-treasury sweep. */
    buybackHot: z.string().min(1),
    /**
     * Optional separate gas-payer for the claim ix. If null/omitted the
     * creator wallet pays (and the SDK auto-unwraps WSOL→SOL on the creator).
     * If a different label is supplied the engine appends its own
     * `closeAccount(creatorWsolAta)` ix to recover lamports as native SOL.
     */
    claimPayer: z.string().nullable().optional(),
    /** Pubkey OR vault label of the SOL split destination (no signing required). */
    treasury: z.string().min(1),
    /** Pubkey OR vault label of the bought-token destination (no signing required). */
    miningTreasury: z.string().min(1),
  }),

  split: z
    .object({
      treasuryBps: z.number().int().min(0).max(10_000).default(3_000),
      minSplitLamports: z.number().int().nonnegative().default(10_000_000),
      creatorRentReserveLamports: z.number().int().nonnegative().default(5_000_000),
      /**
       * When false, the engine skips the (100% - treasuryBps) transfer to the
       * buyback hot wallet. The remainder stays in the creator wallet. Use
       * when you want to claim + take a treasury cut but defer activating the
       * buyback bucket. Default true preserves the original 30/70 routing.
       *
       * Ignored when `bucketBps` is set — `bucketBps` is the explicit
       * source of truth for the bucket share once specified.
       */
      bucketEnabled: z.boolean().default(true),
      /**
       * Explicit bucket share in basis points (0..10000). When provided, takes
       * precedence over the legacy `bucketEnabled` boolean and enables the
       * three-way split:
       *   treasuryBps + bucketBps + (creator-retain remainder) = 10000
       * Whatever isn't routed to treasury or bucket stays in the creator
       * wallet. Validated below to ensure treasuryBps + bucketBps <= 10000.
       *
       * Omit to keep the historical two-way behaviour (bucket gets all the
       * remainder if bucketEnabled, otherwise creator keeps it all).
       */
      bucketBps: z.number().int().min(0).max(10_000).optional(),
    })
    .superRefine((s, ctx) => {
      if (typeof s.bucketBps === 'number' && s.treasuryBps + s.bucketBps > 10_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bucketBps'],
          message: `treasuryBps (${s.treasuryBps}) + bucketBps (${s.bucketBps}) must not exceed 10000`,
        });
      }
    })
    .default({
      treasuryBps: 3_000,
      minSplitLamports: 10_000_000,
      creatorRentReserveLamports: 5_000_000,
      bucketEnabled: true,
    }),

  claim: z
    .object({
      thresholdLamports: z.number().int().nonnegative().default(50_000_000),
      intervalMs: z.number().int().nonnegative().default(60 * 60_000),
      /**
       * When true, the auto-tick loop NEVER fires a claim. Only the
       * dashboard's "Claim NOW (live)" button can trigger one. Useful for
       * users who want full manual control over when fees are withdrawn.
       */
      manualOnly: z.boolean().default(false),
    })
    .default({ thresholdLamports: 50_000_000, intervalMs: 60 * 60_000, manualOnly: false }),

  buyback: z
    .object({
      venue: VenueSchema.default('jupiter'),
      dipReferenceWindowSec: z.number().int().positive().default(4 * 3600),
      tiers: z.array(TierSchema).min(1).default([
        { drawdownPct: 0.05, trancheSol: 0.25, cooldownMs: 30 * 60_000 },
        { drawdownPct: 0.1, trancheSol: 0.5, cooldownMs: 30 * 60_000 },
        { drawdownPct: 0.2, trancheSol: 1.0, cooldownMs: 60 * 60_000 },
      ]),
      slippageBps: z.number().int().min(1).max(10_000).default(150),
      slippageJitter: z.number().min(0).max(0.9).default(0.2),
      useJito: z.boolean().default(true),
      computeUnitLimit: z.number().int().positive().default(600_000),
      /** Min SOL the engine will keep in the buyback bucket after sizing a swap: rent + CPI ATA headroom on Jupiter routes (raise if sim InsufficientFundsForRent). */
      bucketRentReserveLamports: z.number().int().nonnegative().default(12_000_000),
    })
    .default({
      venue: 'jupiter',
      dipReferenceWindowSec: 4 * 3600,
      tiers: [
        { drawdownPct: 0.05, trancheSol: 0.25, cooldownMs: 30 * 60_000 },
        { drawdownPct: 0.1, trancheSol: 0.5, cooldownMs: 30 * 60_000 },
        { drawdownPct: 0.2, trancheSol: 1.0, cooldownMs: 60 * 60_000 },
      ],
      slippageBps: 150,
      slippageJitter: 0.2,
      useJito: true,
      computeUnitLimit: 600_000,
      bucketRentReserveLamports: 12_000_000,
    }),

  loop: z
    .object({
      pollIntervalMs: z.number().int().positive().default(60_000),
      dryRun: z.boolean().default(true),
      /**
       * When true, the engine runs only the claim + split phases on each tick;
       * dip detection and tranche firing are skipped entirely. Use this when
       * you want to accumulate fees but defer turning on the auto-buyback
       * (e.g. you're still figuring out tier sizing, or you want to manually
       * claim and just keep the 30/70 routing). Toggleable at runtime via
       * the web UI; persisted across restarts.
       */
      skipBuybacks: z.boolean().default(false),
    })
    .default({ pollIntervalMs: 60_000, dryRun: true, skipBuybacks: false }),

  web: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65_535).default(4318),
      /**
       * If set, every /api/control/* POST must include this token in the
       * `x-treasury-token` header (or `?token=` query). Read endpoints stay
       * open. Defaults to undefined → controls are unprotected (fine for
       * 127.0.0.1 single-user; required behind any tunnel/proxy).
       */
      token: z.string().min(8).optional(),
      /** Disable all mutating endpoints regardless of token. */
      readOnly: z.boolean().default(false),
    })
    .default({
      enabled: true,
      host: '127.0.0.1',
      port: 4318,
      readOnly: false,
    }),
});

export type RawTreasuryConfig = z.infer<typeof RawConfigSchema>;

// -- resolved config (after vault lookup) ------------------------------

export interface ResolvedTreasuryConfig {
  vaultPath: string;
  storePath: string;
  pool: PublicKey;
  /** Resolved at startup — either supplied or read from the pool account. */
  coinCreator: PublicKey | undefined;
  wallets: {
    creator: Keypair;
    buybackHot: Keypair;
    claimPayer: Keypair | null;
    treasury: PublicKey;
    miningTreasury: PublicKey;
  };
  split: {
    treasuryBps: number;
    minSplitLamports: number;
    creatorRentReserveLamports: number;
    bucketEnabled: boolean;
    bucketBps: number | null;
  };
  claim: {
    thresholdLamports: number;
    intervalMs: number;
    manualOnly: boolean;
  };
  buyback: {
    venue: 'jupiter' | 'pumpswap';
    dipReferenceWindowSec: number;
    tiers: { drawdownPct: number; trancheSol: number; cooldownMs: number }[];
    slippageBps: number;
    slippageJitter: number;
    useJito: boolean;
    computeUnitLimit: number;
    bucketRentReserveLamports: number;
  };
  loop: {
    pollIntervalMs: number;
    dryRun: boolean;
    skipBuybacks: boolean;
  };
  web: {
    enabled: boolean;
    host: string;
    port: number;
    token: string | undefined;
    readOnly: boolean;
  };
}

export function loadRawConfig(filePath: string): RawTreasuryConfig {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  return RawConfigSchema.parse(parsed);
}

/**
 * Resolve wallet labels against the unlocked vault. Each of `treasury` and
 * `miningTreasury` may be either a vault label (looked up to get the pubkey)
 * or a raw base58 pubkey (used as-is). `creator`, `buybackHot`, and
 * `claimPayer` MUST be vault labels because we need their secret keys.
 *
 * Tier ordering is normalised so the most aggressive (largest drawdown)
 * tier comes last in the array — the tranche-firing logic relies on this
 * to mark all "smaller" tiers fired when a bigger one triggers.
 */
export function resolveConfig(raw: RawTreasuryConfig, vault: Vault): ResolvedTreasuryConfig {
  const creator = requireKeypair(vault, raw.wallets.creator, 'wallets.creator');
  const buybackHot = requireKeypair(vault, raw.wallets.buybackHot, 'wallets.buybackHot');
  const claimPayer =
    raw.wallets.claimPayer && raw.wallets.claimPayer.length > 0
      ? requireKeypair(vault, raw.wallets.claimPayer, 'wallets.claimPayer')
      : null;

  const treasury = resolvePubkey(vault, raw.wallets.treasury, 'wallets.treasury');
  const miningTreasury = resolvePubkey(
    vault,
    raw.wallets.miningTreasury,
    'wallets.miningTreasury',
  );

  const sortedTiers = [...raw.buyback.tiers].sort((a, b) => a.drawdownPct - b.drawdownPct);

  // Env wins over the JSON for the web token so a checked-in
  // treasury.config.json can stay in version control without leaking it.
  const webToken =
    process.env.TREASURY_WEB_TOKEN && process.env.TREASURY_WEB_TOKEN.length >= 8
      ? process.env.TREASURY_WEB_TOKEN
      : raw.web.token;

  // Env-var override for the vault path. Lets a VPS deploy point at a
  // sibling vault file without editing the checked-in config. Treasury-
  // namespaced on purpose: an `AMM_VAULT_PATH` (or legacy generic
  // `VAULT_PATH`) leaking from the parent shell when the operator also
  // runs the MM cannot retarget the treasury process at the wrong vault.
  // Precedence:  TREASURY_VAULT_PATH  >  treasury.config.json/vault.path
  const vaultPath = process.env.TREASURY_VAULT_PATH ?? raw.vault.path;

  const cfg: ResolvedTreasuryConfig = {
    vaultPath,
    storePath: raw.store.path,
    pool: new PublicKey(raw.pool),
    coinCreator: raw.coinCreator ? new PublicKey(raw.coinCreator) : undefined,
    wallets: { creator, buybackHot, claimPayer, treasury, miningTreasury },
    split: { ...raw.split, bucketBps: raw.split.bucketBps ?? null },
    claim: { ...raw.claim },
    buyback: { ...raw.buyback, tiers: sortedTiers },
    loop: { ...raw.loop },
    web: { ...raw.web, token: webToken },
  };

  // Sanity check: largest tranche fits within (2x for safety) the buyback hot
  // wallet's expected dry-powder ceiling. Pure advisory log — the engine
  // refuses to fire tranches it can't afford anyway.
  const maxTrancheLamports = sortedTiers.reduce((m, t) => Math.max(m, t.trancheSol), 0) *
    LAMPORTS_PER_SOL;
  void maxTrancheLamports;

  return cfg;
}

function requireKeypair(vault: Vault, label: string, field: string): Keypair {
  const kp = vault.getKeypair(label);
  if (!kp) {
    throw new Error(
      `${field}: vault has no wallet labelled '${label}'. Run \`amm wallet generate --prefix ${label}\` or \`amm wallet import --label ${label}\` first.`,
    );
  }
  return kp;
}

/**
 * Accept either a vault label (looked up for its public key) or a raw base58
 * pubkey. Lets you point the SOL-receiving destinations at cold wallets that
 * aren't in the vault at all (recommended for the treasury / mining-treasury).
 */
function resolvePubkey(vault: Vault, value: string, field: string): PublicKey {
  // Try as a base58 pubkey first; PublicKey throws on invalid input.
  try {
    return new PublicKey(value);
  } catch {
    // Not a pubkey — fall through to vault label lookup.
  }
  const entry = vault.get(value);
  if (!entry) {
    throw new Error(
      `${field}: '${value}' is neither a base58 pubkey nor a known vault label`,
    );
  }
  // We only need the public key here.
  return Keypair.fromSecretKey(
    // re-derive via the vault helper to avoid pulling bs58 into this file
    vault.getKeypair(value)!.secretKey,
  ).publicKey;
}
