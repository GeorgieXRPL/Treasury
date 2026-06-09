#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Command } from 'commander';

// Load treasury/.env explicitly from this package's root, NOT process.cwd().
// This makes the engine behave the same whether invoked from the repo root
// (`pnpm --filter @amm/treasury start ...`), from inside the treasury folder,
// or from a systemd unit on the VPS where cwd is whatever WorkingDirectory= is
// set to. Existing process env wins (override:false) so VPS env vars or
// systemd EnvironmentFile= takes precedence over a stale local .env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is .../treasury/src (tsx) or .../treasury/dist (built). Either
// way, ../.env from here is the package root .env file.
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: false });

import { password } from '@inquirer/prompts';
import {
  PriceOracle,
  RpcManager,
  TxExecutor,
  Vault,
  VaultError,
} from '@amm/core';
import { PumpSwapVenue, VenueRegistry } from '@amm/venues';
import { createLogger } from '@amm/shared';
import BN from 'bn.js';
import { loadRawConfig, resolveConfig, type RawTreasuryConfig } from './config.js';
import { TreasuryStore } from './store.js';
import { BuybackEngine } from './engine/buyback-engine.js';
import { SnapshotBuilder } from './web/snapshot.js';
import { TreasuryWebServer } from './web/server.js';

const log = createLogger('treasury:cli');

/**
 * Matches `resolveConfig`'s precedence: env `TREASURY_VAULT_PATH` overrides JSON
 * `vault.path`. Relative overrides resolve against the **`treasury.config.json`**
 * file's directory (not process.cwd()), so `./.amm-treasury/vault.enc` works
 * from repo root configs even when cwd is `treasury/`.
 */
function resolveTreasuryVaultFilePath(configPathArg: string, raw: RawTreasuryConfig): string {
  const configDir = path.dirname(path.resolve(configPathArg));
  const fromEnv = process.env.TREASURY_VAULT_PATH?.trim();
  const pick =
    fromEnv && fromEnv.length > 0 ? fromEnv : raw.vault.path.trim();
  return path.isAbsolute(pick) ? pick : path.resolve(configDir, pick);
}

async function unlockVault(vaultPath: string): Promise<Vault> {
  const v = new Vault(vaultPath);
  if (!(await v.exists())) {
    throw new Error(
      `no vault at ${v.path}. Create it with \`amm vault init\` against this path (set VAULT_PATH=${v.path}) or copy an existing vault file here.`,
    );
  }
  const passphrase =
    process.env.TREASURY_VAULT_PASSPHRASE ??
    (await password({ message: 'treasury vault passphrase:', mask: '*' }));
  try {
    await v.unlock(passphrase);
  } catch (e) {
    if (e instanceof VaultError && e.code === 'BAD_PASSPHRASE') {
      throw new Error('bad passphrase');
    }
    throw e;
  }
  return v;
}

const program = new Command();
program
  .name('treasury')
  .description('PumpSwap creator-fee claim + 30/70 split + phased buyback engine')
  .version('0.1.0');

program
  .command('start')
  .description('start the treasury engine loop (long-running)')
  .requiredOption('-c, --config <path>', 'path to treasury.config.json')
  .option('--no-web', 'disable the local web UI')
  .option('--web-host <host>', 'override web bind host (default 127.0.0.1)')
  .option('--web-port <port>', 'override web bind port (default 4318)')
  .action(
    async (opts: {
      config: string;
      web?: boolean;
      webHost?: string;
      webPort?: string;
    }) => {
      const raw = loadRawConfig(opts.config);
      const vault = await unlockVault(resolveTreasuryVaultFilePath(opts.config, raw));
      const cfg = resolveConfig(raw, vault);

      const rpc = new RpcManager();
      const exec = new TxExecutor(rpc);
      const oracle = new PriceOracle();
      const venues = new VenueRegistry(rpc.pickConnection());
      const store = new TreasuryStore(cfg.storePath);

      const engine = new BuybackEngine(cfg, { rpc, exec, venues, oracle, store });

      // CLI flag wins over JSON. `--no-web` sets opts.web === false (commander).
      const webEnabled = opts.web === false ? false : cfg.web.enabled;
      let web: TreasuryWebServer | null = null;
      if (webEnabled) {
        const host = opts.webHost ?? cfg.web.host;
        const port = opts.webPort ? parseInt(opts.webPort, 10) : cfg.web.port;
        const snapshots = new SnapshotBuilder(
          engine,
          store,
          rpc,
          venues.get('pumpswap') as PumpSwapVenue,
        );
        web = new TreasuryWebServer(
          { engine, snapshots, vault, rpc, exec },
          {
            host,
            port,
            token: cfg.web.token,
            readOnly: cfg.web.readOnly,
          },
        );
        await web.start();
        const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
        console.log(`\n  treasury web UI ready  →  ${url}\n`);
      }

      const shutdown = async (sig: string) => {
        log.info({ sig }, 'shutdown signal received; stopping engine gracefully');
        try {
          if (web) await web.stop();
          await engine.stop();
        } finally {
          store.close();
          process.exit(0);
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));

      await engine.start();
      // start() returns once the loop has begun; the loop owns its own
      // promise. Park here forever — only signal handlers exit.
      await new Promise<void>(() => undefined);
    },
  );

program
  .command('status')
  .description('print recent claims / splits / buybacks (read-only)')
  .requiredOption('-c, --config <path>', 'path to treasury.config.json')
  .option('-n, --limit <n>', 'rows per section', '10')
  .action(async (opts: { config: string; limit: string }) => {
    const raw = loadRawConfig(opts.config);
    // Status is read-only; no vault unlock needed.
    const store = new TreasuryStore(raw.store.path);
    const limit = Math.max(1, parseInt(opts.limit, 10) || 10);

    const claims = store.recentClaims(limit);
    const splits = store.recentSplits(limit);
    const buybacks = store.recentBuybacks(limit);

    console.log(`\nclaims (last ${claims.length}):`);
    for (const c of claims) {
      console.log(
        `  ${new Date(c.ts).toISOString()}  +${fmtSol(c.claimedLamports)} SOL  ${c.signature.slice(0, 16)}…`,
      );
    }
    console.log(`\nsplits (last ${splits.length}):`);
    for (const s of splits) {
      console.log(
        `  ${new Date(s.ts).toISOString()}  treasury=${fmtSol(s.treasuryLamports)} bucket=${fmtSol(s.bucketLamports)} ${s.signature.slice(0, 16)}…`,
      );
    }
    console.log(`\nbuybacks (last ${buybacks.length}):`);
    for (const b of buybacks) {
      const live = b.live ? 'LIVE' : 'DRY ';
      console.log(
        `  ${new Date(b.ts).toISOString()}  ${live} tier=${b.tier} dd=${(b.drawdownPct * 100).toFixed(2)}% in=${fmtSol(b.lamportsIn)} out=${b.baseTokensOut}  ${b.swapSignature.slice(0, 16)}…`,
      );
    }
    store.close();
  });

program
  .command('config-check')
  .description('parse + validate the config file (resolves vault labels) without starting the loop')
  .requiredOption('-c, --config <path>', 'path to treasury.config.json')
  .action(async (opts: { config: string }) => {
    const raw = loadRawConfig(opts.config);
    const vault = await unlockVault(resolveTreasuryVaultFilePath(opts.config, raw));
    const cfg = resolveConfig(raw, vault);
    console.log('config OK');
    console.log(`  pool:           ${cfg.pool.toBase58()}`);
    console.log(`  creator:        ${cfg.wallets.creator.publicKey.toBase58()}`);
    console.log(`  buyback hot:    ${cfg.wallets.buybackHot.publicKey.toBase58()}`);
    console.log(`  treasury dest:  ${cfg.wallets.treasury.toBase58()}`);
    console.log(`  mining dest:    ${cfg.wallets.miningTreasury.toBase58()}`);
    const splitDesc = cfg.split.bucketEnabled
      ? `${cfg.split.treasuryBps / 100}% to treasury / ${(10_000 - cfg.split.treasuryBps) / 100}% to bucket`
      : `${cfg.split.treasuryBps / 100}% to treasury / rest stays in creator (bucket DISABLED)`;
    console.log(`  split:          ${splitDesc}`);
    console.log(
      `  claim:          mode=${cfg.claim.manualOnly ? 'manual-only (button)' : 'auto'} threshold=${(cfg.claim.thresholdLamports / 1e9).toFixed(4)} SOL interval=${Math.round(cfg.claim.intervalMs / 60_000)}min`,
    );
    console.log(
      `  tiers:          ${cfg.buyback.tiers
        .map((t) => `[${(t.drawdownPct * 100).toFixed(1)}% / ${t.trancheSol} SOL / ${t.cooldownMs / 1000}s]`)
        .join(' ')}`,
    );
    console.log(`  dryRun:         ${cfg.loop.dryRun}`);
    console.log(`  skipBuybacks:   ${cfg.loop.skipBuybacks}`);
    console.log(
      `  web:            ${cfg.web.enabled ? `http://${cfg.web.host}:${cfg.web.port}/` : 'disabled'}` +
        (cfg.web.token ? ' (token-protected)' : '') +
        (cfg.web.readOnly ? ' (read-only)' : ''),
    );

    // Surface dangerous combinations explicitly so a glance tells the user
    // whether they're about to point a loaded gun at their wallet.
    const warnings: string[] = [];
    if (!cfg.loop.dryRun && !cfg.loop.skipBuybacks && !cfg.claim.manualOnly) {
      warnings.push('FULL AUTO: dryRun=false, skipBuybacks=false, manualOnly=false. Engine will auto-claim, auto-split, AND auto-buyback on dips.');
    }
    if (!cfg.loop.dryRun && cfg.split.bucketEnabled && !cfg.wallets.treasury.equals(cfg.wallets.creator.publicKey)) {
      // OK — funds will leave creator
    }
    if (cfg.split.bucketEnabled && cfg.wallets.buybackHot.publicKey.equals(cfg.wallets.creator.publicKey)) {
      warnings.push('split.bucketEnabled=true but buybackHot == creator — bucket transfer will self-send (waste 5k lamports per claim).');
    }
    if (warnings.length) {
      console.log('\n  warnings:');
      for (const w of warnings) console.log(`    !  ${w}`);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});

function fmtSol(lamports: string | number | BN): string {
  const n = typeof lamports === 'string' ? Number(lamports) : typeof lamports === 'number' ? lamports : Number(lamports.toString());
  return (n / 1_000_000_000).toFixed(6);
}
