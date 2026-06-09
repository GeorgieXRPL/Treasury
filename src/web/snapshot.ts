import { PublicKey } from '@solana/web3.js';
import { PumpBondingClient, PumpSwapVenue } from '@amm/venues';
import type { RpcManager } from '@amm/core';
import type { BuybackEngine, EngineSnapshot } from '../engine/buyback-engine.js';
import type { TreasuryStore, ClaimRecord, SplitRecord, BuybackRecord } from '../store.js';

export interface OnChainSnapshot {
  asOfMs: number;
  /** Lamports in each watched wallet, addressed by role. */
  balances: {
    creatorLamports: number | null;
    buybackHotLamports: number | null;
    treasuryLamports: number | null;
    miningTreasuryLamports: number | null;
  };
  /**
   * Total lamports waiting to be claimed across all upstream vaults.
   * For sharing-config pools this is the SUM of (a) the pump_amm WSOL
   * accumulator and (b) the bonding-curve `creator_vault` PDA — matching
   * what Pump.fun's "Creator rewards / Unclaimed" UI displays. For legacy
   * pools it's just the WSOL ATA balance.
   *
   * Null on probe failure (logged once, never throws — the UI must keep
   * working when RPC is flaky).
   */
  unclaimedVaultLamports: string | null;
  /**
   * Per-vault breakdown of the unclaimed total. Populated only for
   * sharing-config pools where the SOL is split across two on-chain
   * accounts. Helps diagnose stuck transfers (e.g. high `pumpAmmLamports`
   * with low `bondingLamports` means `transfer_creator_fees_to_pump`
   * hasn't fired recently).
   */
  unclaimedBreakdown: {
    pumpAmmLamports: string;
    bondingLamports: string;
  } | null;
  /**
   * RPC probe latency, ms. Useful diagnostic on the dashboard. `null` on probe
   * failure.
   */
  probeMs: number | null;
}

export interface FullSnapshot {
  serverMs: number;
  engine: EngineSnapshot;
  onChain: OnChainSnapshot;
  recent: {
    claims: ClaimRecord[];
    splits: SplitRecord[];
    buybacks: BuybackRecord[];
  };
}

/**
 * Bundles engine snapshot + on-chain balances + recent persisted activity
 * into one JSON-friendly object. Caches the on-chain probes for `cacheMs` so
 * a chatty UI poll doesn't melt the RPC budget. Engine snapshot itself is
 * never cached — it's in-process and free.
 */
export class SnapshotBuilder {
  private cachedOnChain: OnChainSnapshot | null = null;
  private cachedAt = 0;

  constructor(
    private readonly engine: BuybackEngine,
    private readonly store: TreasuryStore,
    private readonly rpc: RpcManager,
    private readonly pumpswap: PumpSwapVenue,
    private readonly opts: { cacheMs?: number; recentLimit?: number } = {},
  ) {}

  async build(): Promise<FullSnapshot> {
    const recentLimit = this.opts.recentLimit ?? 25;
    const cacheMs = this.opts.cacheMs ?? 7_000;
    const now = Date.now();

    let onChain: OnChainSnapshot;
    if (this.cachedOnChain && now - this.cachedAt < cacheMs) {
      onChain = this.cachedOnChain;
    } else {
      onChain = await this.probeOnChain();
      this.cachedOnChain = onChain;
      this.cachedAt = Date.now();
    }

    return {
      serverMs: Date.now(),
      engine: this.engine.getSnapshot(),
      onChain,
      recent: {
        claims: this.store.recentClaims(recentLimit),
        splits: this.store.recentSplits(recentLimit),
        buybacks: this.store.recentBuybacks(recentLimit),
      },
    };
  }

  private async probeOnChain(): Promise<OnChainSnapshot> {
    const snap = this.engine.getSnapshot();
    const start = Date.now();

    const tryBalance = async (pk: string | null): Promise<number | null> => {
      if (!pk) return null;
      try {
        return await this.rpc.getBalance(new PublicKey(pk));
      } catch {
        return null;
      }
    };

    const [creator, bucket, treasury, mining] = await Promise.all([
      tryBalance(snap.wallets.creator),
      tryBalance(snap.wallets.buybackHot),
      tryBalance(snap.wallets.treasury),
      tryBalance(snap.wallets.miningTreasury),
    ]);

    let unclaimedVaultLamports: string | null = null;
    let unclaimedBreakdown: OnChainSnapshot['unclaimedBreakdown'] = null;
    if (snap.pool) {
      try {
        if (snap.pool.claimModel === 'sharing-config') {
          // Sharing-config pools accumulate fees in TWO upstream vaults
          // before they hit any shareholder wallet:
          //   (a) pump_amm WSOL ATA (where every swap deposits its 0.05%
          //       creator-fee slice as wrapped SOL).
          //   (b) pump-bonding `creator_vault` PDA (native SOL — what
          //       `distribute_creator_fees` actually splits).
          // Pump.fun's "Unclaimed" UI shows the SUM. Reading only (b)
          // produces dust numbers that mislead the operator into thinking
          // there's nothing to claim, when in reality the bulk is sitting
          // in (a) waiting for `transfer_creator_fees_to_pump` to fire.
          const pumpBonding = new PumpBondingClient(this.rpc.pickConnection());
          const [inAmm, inBonding] = await Promise.all([
            this.pumpswap.getPumpAmmVaultLamports(new PublicKey(snap.pool.coinCreator)),
            pumpBonding.getCreatorVaultLamports(new PublicKey(snap.pool.baseMint)),
          ]);
          const total = inAmm.add(inBonding);
          unclaimedVaultLamports = total.toString();
          unclaimedBreakdown = {
            pumpAmmLamports: inAmm.toString(),
            bondingLamports: inBonding.toString(),
          };
        } else {
          // Legacy path: WSOL ATA owned by the on-chain coin_creator.
          const bn = await this.pumpswap.getCreatorVaultBalance(
            new PublicKey(snap.pool.coinCreator),
          );
          unclaimedVaultLamports = bn.toString();
        }
      } catch {
        unclaimedVaultLamports = null;
        unclaimedBreakdown = null;
      }
    }

    const probeMs = Date.now() - start;
    return {
      asOfMs: Date.now(),
      balances: {
        creatorLamports: creator,
        buybackHotLamports: bucket,
        treasuryLamports: treasury,
        miningTreasuryLamports: mining,
      },
      unclaimedVaultLamports,
      unclaimedBreakdown,
      probeMs,
    };
  }
}

