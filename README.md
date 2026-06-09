# @amm/treasury

Standalone PumpSwap creator-fee → 30/70 SOL split → phased token-buyback engine.

Runs as **its own process**, completely decoupled from the MM bot/orchestrator/dashboard.
Reuses the AMM repo's Solana plumbing (`@amm/core`, `@amm/venues`, `@amm/shared`)
for vault, RPC rotation, tx executor, Jupiter routing, and PumpSwap SDK glue.

## What it does

For a single PumpSwap pool you created (you are the `coin_creator`), every
poll tick (60s by default):

1. **Claim** — if the on-chain `coin_creator` vault has more than
   `claim.thresholdLamports`, sign and send `collect_coin_creator_fee`
   from the creator wallet. The pump-swap SDK auto-unwraps WSOL → native
   SOL on the creator wallet in the same tx (see "WSOL handling" below).
2. **Split** — read the creator wallet's lamport balance and route
   `treasuryBps` (default 30%) to the treasury wallet, the rest to the
   buyback hot wallet. Skips when either side is below `minSplitLamports`.
3. **Dip-detect** — sample the latest token price (Jupiter price oracle),
   maintain a rolling-window high (default 4h, persisted across restarts).
4. **Tranche** — for each configured dip tier (e.g. -5% / -10% / -20%),
   if the drawdown is satisfied, the per-tier cooldown has elapsed, and
   the buyback hot wallet has enough SOL: fire one Jupiter swap (WSOL →
   token), then sweep the bucket's full base-token balance to the
   mining-treasury wallet. Higher tiers fire one at a time per tick.

## Quick start

```bash
# from the repo root
pnpm install
pnpm --filter @amm/treasury build

# create a *separate* vault for treasury keys (do NOT reuse your MM vault)
mkdir .amm-treasury
VAULT_PATH=./.amm-treasury/vault.enc pnpm cli vault init
VAULT_PATH=./.amm-treasury/vault.enc pnpm cli wallet generate --prefix creator
VAULT_PATH=./.amm-treasury/vault.enc pnpm cli wallet generate --prefix buyback-hot

# fund the creator wallet with a small SOL float for tx fees, and
# arrange for it to be the coin_creator on your pump_amm pool
# (either it always was, or use admin_set_coin_creator on the pool).

# write your config
cp treasury/treasury.example.json treasury.config.json
# edit pool, wallets.treasury, wallets.miningTreasury

# sanity-check resolution before going live
pnpm --filter @amm/treasury start config-check -c treasury.config.json

# run in dry-run (default in the example config)
pnpm --filter @amm/treasury start start -c treasury.config.json

# observe a few ticks, then flip loop.dryRun to false (or use the web UI
# toggle, see below) and restart
```

## Web UI

Bundled into the same process as the engine — `treasury start` automatically
serves a dashboard at <http://127.0.0.1:4318/> by default. Bind/port are
configurable via `web.host` / `web.port` in `treasury.config.json` or the
`--web-host` / `--web-port` flags. Use `--no-web` to disable it entirely.

What the UI shows:

| Card | Live data |
| --- | --- |
| Status header | engine running/stopped, dry-run/live, in-tick/idle, last tick timestamp |
| Pool | resolved pool id, base mint, on-chain `coin_creator`, with copy buttons |
| Dip tracker | current price, rolling-window high, drawdown %, sample sparkline |
| Wallets | live SOL balances for creator / buyback-hot / treasury / mining cold |
| On-chain | unclaimed WSOL waiting in the creator vault, RPC probe latency, claim cadence |
| Tier ladder | each tier with cooldown bar; eligible tiers light up green |
| Recent activity | last 25 claims / splits / buybacks with Solscan links |

Controls (POST `/api/control/*` under the hood):

- **dry-run toggle** — flip without restarting; the next tick respects it.
  Persisted to the kv store so a restart preserves the runtime override.
- **tick now** — wakes the loop early so you don't have to wait out the
  poll interval to see a phase run.
- **force claim** — resets the claim cooldown so the next tick re-evaluates
  the on-chain vault, even if `claim.intervalMs` hasn't elapsed.

### Security model

The server binds to `127.0.0.1` only — never reachable from outside the box.
For VPS deploys reach the dashboard over an SSH tunnel:

```bash
ssh -L 4318:127.0.0.1:4318 user@your-vps   # then open http://127.0.0.1:4318/
```

For a defence-in-depth layer, set `TREASURY_WEB_TOKEN` in `treasury/.env`
(generate with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`).
With it set, every mutating endpoint requires the token in the
`x-treasury-token` header — the embedded UI threads it through automatically.
Read endpoints (`/api/snapshot`, `/api/health`) stay open since they only
return public chain data.

For a fully read-only dashboard (e.g. running a second instance for monitoring),
set `web.readOnly: true` in the config — the engine still runs, but every
control endpoint returns 403.

## Config reference (`treasury.config.json`)

| Path | Type | Default | Notes |
| --- | --- | --- | --- |
| `vault.path` | string | required | encrypted vault file (separate from MM vault) |
| `store.path` | string | required | sqlite db path (separate from MM store) |
| `pool` | string | required | pump_amm pool pubkey OR token mint (auto-resolved to canonical pool) |
| `coinCreator` | string? | derived | optional; if set, must match the pool's on-chain `coin_creator` |
| `wallets.creator` | string | required | vault label of the wallet that signs claims + splits |
| `wallets.buybackHot` | string | required | vault label of the wallet that signs swaps + sweeps |
| `wallets.claimPayer` | string \| null | null | optional separate gas-payer for the claim ix; null = creator pays |
| `wallets.treasury` | string | required | base58 pubkey **or** vault label — destination of the SOL split |
| `wallets.miningTreasury` | string | required | base58 pubkey **or** vault label — destination of bought tokens |
| `split.treasuryBps` | int 0..10000 | 3000 | 30% to treasury, 70% to buyback bucket |
| `split.minSplitLamports` | int | 10_000_000 | 0.01 SOL — skip dust splits |
| `split.creatorRentReserveLamports` | int | 5_000_000 | never drain creator below this |
| `claim.thresholdLamports` | int | 50_000_000 | 0.05 SOL — min vault balance to bother claiming |
| `claim.intervalMs` | int | 3_600_000 | min 1h between claim attempts |
| `buyback.venue` | "jupiter" \| "pumpswap" | jupiter | Jupiter routes across all venues — better fills, indistinguishable from retail |
| `buyback.dipReferenceWindowSec` | int | 14400 | 4h rolling-high window |
| `buyback.tiers[]` | array | (default ladder) | each `{ drawdownPct, trancheSol, cooldownMs }` |
| `buyback.slippageBps` | int | 150 | swap slippage |
| `buyback.slippageJitter` | float 0..0.9 | 0.2 | per-trade jitter on slippage |
| `buyback.useJito` | bool | true | bypass mempool, better landing odds |
| `buyback.computeUnitLimit` | int | 600_000 | swap CU limit |
| `buyback.bucketRentReserveLamports` | int | 12_000_000 | min SOL left in the bucket when sizing a swap (Jupiter→Pump CPI ATA rent; engine enforces ≥12M when `venue` is jupiter) |
| `loop.pollIntervalMs` | int | 60_000 | tick cadence |
| `loop.dryRun` | bool | **true** | safe default — flip after dry-run looks correct |

Tiers are sorted ascending by `drawdownPct` internally. Per tick, at most
one tier fires (the largest-drawdown tier whose conditions are met). After
firing, all tiers with smaller drawdown are also marked fired, so a -5%
trigger doesn't keep refiring while -20% is also currently true.

## WSOL handling

Verified by reading the SDK source
(`@pump-fun/pump-swap-sdk@1.15.0`'s `dist/sdk/onlinePumpAmm.js`):

- The on-chain `coin_creator` vault is **always WSOL** —
  `OnlinePumpAmmSdk.collectCoinCreatorFeeSolanaState` hardcodes
  `quoteMint = NATIVE_MINT`, regardless of the pool's actual quote mint.
- `OnlinePumpAmmSdk.getCoinCreatorVaultBalance` therefore returns WSOL
  lamports, directly comparable to a SOL lamport threshold.
- `PumpAmmSdk.collectCoinCreatorFee(state, payer)` already includes a
  `closeAccount(creatorWsolAta)` ix when `payer === coinCreator`. Closing
  a WSOL account transfers its balance to the owner as **native SOL**.
  After the claim tx confirms, `creator.getBalance()` is just `+claimedAmount`.

If you set `wallets.claimPayer` to a separate signer (so the creator
wallet can sit at near-zero balance), the SDK skips that auto-close.
The engine appends its own `closeAccount(creatorWsolAta)` ix in that
case, so the claim still resolves to native SOL on the creator wallet
either way.

## Tor / privacy proxy

Every outbound HTTP call the engine makes (RPC, Jupiter, Jito, the
diag probe itself) goes through a single shared `undici` dispatcher in
`packages/core/src/http.ts`. When `TOR_PROXY` is set, that dispatcher is
swapped for one that tunnels through SOCKS5 (`socks5h` for DNS-side
resolution) or HTTP/HTTPS, depending on the URL scheme.

**Why bother locally**: the creator wallet is signing claims and split
transfers from your home IP otherwise. Tor severs the IP-to-wallet
correlation at the egress, which is the cheapest privacy improvement
available without changing the wallet topology.

**Why NOT on VPS**: the VPS already has a stable, dedicated egress IP
that isn't yours; adding Tor introduces 200–1000ms of latency per
Jupiter quote and Jito send, which materially worsens fills. Leave
`TOR_PROXY` blank in `.env` on the VPS. The MM bot can run a separate
hop policy (e.g. residential proxy) if you want stronger isolation.

### Local dev: Tor Browser bundle (recommended on Windows)

Tor Browser ships with a fully configured `tor.exe` that listens on
`127.0.0.1:9150` whenever the browser is open. No service to install,
no torrc to edit.

1. Open Tor Browser. Wait for "Connect" to finish — the SOCKS listener
   is only up while the browser is running. If you close the browser,
   `127.0.0.1:9150` goes silent and the engine starts spamming
   `endpoint marked unhealthy`.
2. Verify the listener:

   ```powershell
   netstat -ano | findstr 127.0.0.1:9150
   # expect: TCP 127.0.0.1:9150 ... LISTENING <pid>
   ```

3. Set in `treasury/.env`:

   ```env
   TOR_PROXY=socks5h://127.0.0.1:9150
   ```

4. Restart the engine. On startup you should see:

   ```text
   info  [http]  routing http via tor  {"proxy":"socks5h://127.0.0.1:9150"}
   ```

5. Open the dashboard, click **Check Tor egress IP**. You want the green
   pill: `Tor active · proxied A.B.C.D ≠ direct W.X.Y.Z`. If it's red
   (`TOR FAIL ... egress IPs MATCH`), Tor Browser isn't actually running
   on the configured port — go back to step 1.

### Local dev: standalone Tor service

Same idea, different port (`9050`). Install via Chocolatey
(`choco install tor`), Scoop (`scoop install tor`), or direct from the
Tor Project. Once `tor.exe` is running as a service:

```env
TOR_PROXY=socks5h://127.0.0.1:9050
```

Verify with the dashboard button. The benefit over the browser bundle
is you don't need to keep a window open; the downside is one more
moving part to monitor.

### Verifying Tor is in path

The dashboard's **Check Tor egress IP** button hits `/api/diag/proxy`,
which fetches `https://api.ipify.org` twice — once through the engine's
shared dispatcher (Tor if configured), once through a freshly-built
direct dispatcher — and reports both:

| Pill colour | Meaning |
|-------------|---------|
| green `Tor active`   | proxied IP differs from direct IP — traffic is tunneled |
| red `TOR FAIL`       | proxied IP equals direct IP — Tor configured but NOT in path. Tor Browser probably not running. |
| amber `Tor NOT configured` | `TOR_PROXY` env is empty — engine traffic goes direct (the VPS default) |
| red `diag error`     | the proxy probe itself errored — check the `Logs` panel |

You can also call the endpoint directly:

```powershell
curl http://127.0.0.1:4318/api/diag/proxy
```

The diag uses ipify on purpose: it's tiny, has no captcha, returns
text/plain, and is hosted from a different ASN than every Solana RPC
provider so a stale cache won't accidentally make Tor look broken.

### Failure modes you'll actually hit

- **`endpoint marked unhealthy` log spam, every RPC call fails** — Tor
  Browser was closed (or never started) but `TOR_PROXY` is set. Either
  reopen Tor Browser or comment out `TOR_PROXY` and restart.
- **First swap latency is way higher than direct** — expected; Tor adds
  three relay hops. For accumulation buybacks (~0.25 SOL tranche on 30
  min cooldowns) this is fine. If you're firing rapid scalps, disable
  Tor for the engine.
- **Helius rejects the connection with `403`** — some RPCs blacklist
  known Tor exit nodes. The `RpcManager` will demote that endpoint and
  rotate to the next one in your pool. Make sure you have at least one
  RPC that tolerates Tor egress (the public `api.mainnet-beta.solana.com`
  generally does, Helius mostly does, Triton sometimes doesn't).
- **Jito bundle send 5xx errors** — same root cause; Jito's block
  engines can be picky about Tor exits. If this happens consistently,
  disable Tor for the buyback path. The simplest workaround for now is
  to just turn Tor off for live testing, since the buyback wallet is
  already separated from your home identity by the wallet derivation.

## Security model + multisig migration

Until you wire Squads V4, the operational risk model is:

- **`creator`** (hot) — keep topped up just enough to pay claim-tx fees
  (a few cents of SOL above the configured `creatorRentReserveLamports`).
  The split phase drains everything above the reserve every tick, so
  claimed fees don't sit on this wallet for long.
- **`buybackHot`** (hot) — only ever holds the 70% bucket. Cap it at
  `sum(tiers.trancheSol) * 2` of dry powder (engineered to refuse to
  fire a tranche that doesn't fit). Limited blast radius on compromise.
- **`treasury`** (can be cold from day one) — engine only ever transfers
  *to* it, never signs *from* it. Recommended to make this a Squads V4
  vault immediately.
- **`miningTreasury`** (can be cold from day one) — same deal; receive-only
  from the engine's perspective.

### Squads V4 migration path

The eventual hardened topology replaces `creator` (and optionally
`buybackHot`) with [Squads V4](https://docs.squads.so/main/v4/development/spending-limits)
vaults plus per-bot `SpendingLimit` PDAs:

1. Create a Squads vault and either fund it from the existing creator
   wallet, or — cleaner if you control the pump_amm `admin_set_coin_creator`
   authority — call `admin_set_coin_creator` to point the pool's
   `coin_creator` field at the Squads vault directly.
2. Add a `SpendingLimit` PDA on that Squads vault with the bot's hot
   key as the `member`, `amount = ~max_daily_claim + max_daily_buyback`,
   `period = ONE_DAY`, and `destinations = [treasuryWallet, buybackHotWallet]`
   (or unrestricted destinations if Jupiter routing is too dynamic).
3. Swap the engine's claim + split paths to build via
   `multisig.spendingLimitUse(...)` from `@sqds/multisig` instead of the
   direct ix path used today. The Jupiter buyback path stays unchanged
   — `buybackHot` remains a normal hot keypair (it only ever holds the
   70% bucket, capped per-tier as above).

Reference: [Squads V4 spending limits docs](https://docs.squads.so/main/v4/development/spending-limits)
and the [`@sqds/multisig` SDK](https://www.npmjs.com/package/@sqds/multisig).
This package leaves Squads integration as a follow-up so the v1 engine
can ship today.

## VPS deployment

Two patterns. Both run the engine as an unprivileged user with the vault
file outside the repo, owned by that user with `chmod 600`.

### systemd

Create the user + dirs:

```bash
sudo useradd --system --home /var/lib/treasury --shell /usr/sbin/nologin treasury
sudo mkdir -p /var/lib/treasury /etc/treasury
sudo chown -R treasury:treasury /var/lib/treasury
sudo chmod 700 /var/lib/treasury
```

Place your vault file at `/var/lib/treasury/vault.enc` (`chmod 600`,
owned by `treasury`) and your config at `/etc/treasury/config.json`.

`/etc/treasury/treasury.env` (`chmod 600`, owned by `root:treasury`):

```
TREASURY_VAULT_PASSPHRASE=...
RPC_HELIUS=https://mainnet.helius-rpc.com/?api-key=...
JITO_TIP_LAMPORTS=10000
LOG_LEVEL=info
```

`/etc/systemd/system/treasury.service`:

```
[Unit]
Description=AMM treasury / buyback engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=treasury
Group=treasury
EnvironmentFile=/etc/treasury/treasury.env
WorkingDirectory=/opt/amm
ExecStart=/usr/bin/pnpm --filter @amm/treasury start -- start -c /etc/treasury/config.json
Restart=on-failure
RestartSec=10
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/treasury
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now treasury
journalctl -u treasury -f
```

### pm2

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'treasury',
      cwd: '/opt/amm',
      script: 'pnpm',
      args: '--filter @amm/treasury start -- start -c /etc/treasury/config.json',
      env_file: '/etc/treasury/treasury.env',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
    },
  ],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 logs treasury
pm2 save
pm2 startup   # follow the printed instructions
```

## CLI

```
treasury start        -c <config>           start the engine loop
treasury status       -c <config> [-n N]    print recent claims/splits/buybacks
treasury config-check -c <config>           parse + resolve vault labels (no loop)
```

`status` is read-only and does **not** unlock the vault — handy for
running on the same VPS as the live engine without taking the vault
lock.

## Storage layout

The treasury writes to its own SQLite database at `store.path` with these
tables:

- `claims` — one row per successful `collect_coin_creator_fee` (records
  the *net* SOL gained by the creator wallet, immune to the SDK's
  internal WSOL accounting).
- `splits` — one row per 30/70 split tx.
- `buybacks` — one row per tranche (incl. dry-run rows for replay), with
  `live=1` for executed swaps and `live=0` for dry-run entries. The
  `sweepSignature` field is filled in when the post-buyback sweep to the
  mining treasury succeeds.
- `price_samples` — rolling-window high data; survives restarts.
- `tier_state` — per-tier `lastFiredAt` so cooldowns survive restarts.
- `kv` — small free-form state (e.g. `lastClaimAttemptAt`).

Schema is intentionally separate from `@amm/core/Store` so the MM bot
and the treasury engine never trip over each other's migrations.
