# Rotation & VPS hardening

What you need to do **before** moving the treasury engine off your dev box and
onto a public VPS, and on what cadence to rotate things afterwards.

The threat model assumes:

- A VPS = a long-running, internet-reachable Linux box. Anyone with the SSH
  key, root password, panel login, or a 0-day in your distro can read every
  file on disk. Anything on disk is **eventually leaked**.
- Your dev box ≠ the VPS. Things you used safely locally (your personal
  Helius key, your everyday vault passphrase, your one-and-only RPC URL)
  must NOT be reused on the VPS.
- The pump_amm `coin_creator` can drain accumulated WSOL fees. Whoever
  controls that key controls all unclaimed creator-fee yield. Rotating
  it on-chain is hard (requires admin authority on the pool), so we
  isolate it tightly instead.

---

## TL;DR — pre-deploy checklist

Before you `scp` anything to the VPS, do these in order:

1. [ ] **Mint fresh RPC keys** dedicated to the treasury process. Never reuse
       the dev/MM keys.
2. [ ] **Generate a brand-new vault passphrase** (≥ 30 chars, password manager
       generated). Different from `VAULT_PASSPHRASE` (MM) and different from
       your local `TREASURY_VAULT_PASSPHRASE`.
3. [ ] **Re-encrypt the treasury vault** under the new passphrase before
       uploading (see "Re-encrypting the vault" below). Don't just `scp` the
       local `vault.enc` — re-key it first so a leak of either copy doesn't
       compromise the other.
4. [ ] **Generate a new buyback-hot wallet** on the VPS, fund it fresh.
       Don't reuse the local one — its pubkey may have been observed already
       in dev-net activity logs at your RPC provider.
5. [ ] **Confirm the cold treasury / mining-treasury pubkeys** are still
       multisig / hardware-backed and have NOT been used as transient hot
       wallets anywhere.
6. [ ] **Set `loop.dryRun: true`** in `treasury.config.json` for the first
       deploy. Verify a full claim → split → dip-sample loop happens. Then
       flip to `false`.
7. [ ] **Lock down file permissions:** `chmod 600` on `treasury/.env` and
       `.amm-treasury/vault.enc`. `chmod 700` on `.amm-treasury/`.
8. [ ] **Disable shell history persistence** for the deploy user (`unset
       HISTFILE` in `~/.bash_login`) so passphrases pasted at a prompt
       don't end up on disk.

---

## What lives where (and what's sensitive)

| File | Sensitivity | Action when moving to VPS |
| --- | --- | --- |
| `treasury/.env` | **CRITICAL** — has `TREASURY_VAULT_PASSPHRASE` and RPC keys | Create a *new* one on the VPS with rotated values. Do NOT `scp` the local one. |
| `.amm-treasury/vault.enc` | **CRITICAL** — encrypted creator + buyback-hot secret keys | Re-key under a new passphrase before upload (see below). |
| `treasury.config.json` | medium — has cold-wallet pubkeys, tier ladder | Safe to copy. Pubkeys are public by design. |
| `treasury/.data/treasury.db` | low — historical rows of claims/splits/buybacks | Don't copy. Let the VPS build its own state from scratch. |
| `treasury/dist/`, `treasury/node_modules/` | none | Don't copy. Run `pnpm install` + `pnpm --filter @amm/treasury build` on the VPS. |

---

## Things to rotate on every deploy

These rotate **once**, when promoting code from dev → VPS, or after any
suspected leak.

### 1. RPC keys

Why: your dev Helius key has been used to query random mints, devnet stuff,
the MM bot, etc. Its query history identifies you. Mint a clean key for the
treasury so the only addresses it ever asks about are the creator wallet,
buyback hot wallet, and the pumpfun pool — pattern that already exists
publicly on-chain anyway.

```text
# In Helius dashboard: create new project "treasury-vps", copy the URL.
# Edit treasury/.env on the VPS:
RPC_HELIUS=https://mainnet.helius-rpc.com/?api-key=<NEW-VPS-KEY>
```

If you also use Triton / Quicknode, repeat for each. Set the dev `RPC_*`
keys to read-only or rate-limited if the provider supports it.

### 2. Vault passphrase

Why: a passphrase typed into a local terminal can be exfiltrated by any
extension/tool/screen-recorder running on your dev box. The VPS passphrase
must have never been typed anywhere except your password manager.

```text
# In your password manager: generate a fresh entry, e.g.
#   "treasury-vps-vault-2026-05" → 64 random chars.
# The OLD passphrase still unlocks the OLD vault file. We re-encrypt
# the vault under the NEW passphrase below before shipping.
```

### 3. Buyback-hot wallet

Why: although the buyback hot wallet starts fresh on every deploy, its
pubkey appears in every Jupiter swap and sweep tx. If the dev-side hot
wallet was used during testing, its pubkey is forever associated with
your dev IP at the RPC provider. New deploy = new wallet.

```text
# On the VPS (after the vault is uploaded and unlockable):
$env:VAULT_PATH = "/srv/treasury/.amm-treasury/vault.enc"
amm wallet remove --label buyback-hot-1     # remove the dev wallet
amm wallet generate --prefix buyback-hot --tag buyback-hot
amm wallet list                              # note the new pubkey
# Fund the new pubkey with your initial dry powder (e.g. 1 SOL).
```

### 4. Creator wallet

Why: usually you **cannot** rotate this — it's pinned to the on-chain
`coin_creator` of your pump_amm pool, and only the pool admin can reassign
it via `admin_set_coin_creator`. So the creator key is the highest-value
secret on the box and the rotation strategy is "minimize blast radius
instead":

- Migrate to a Squads V4 multisig as `coin_creator` if/when pump_amm
  supports PDA-signed creator-fee claims (currently it does not — the
  creator must be a single keypair).
- Until then: keep the creator wallet's lamport float small (just enough
  for ~10 claim txs of headroom). The split phase auto-drains everything
  above `creatorRentReserveLamports` every tick, so even if the creator
  key leaks the attacker only steals the small float, not the
  accumulated fees.
- See "Multisig migration path" in `README.md`.

### 5. SSH access

Standard hygiene, but worth listing:

- Disable password SSH: `PasswordAuthentication no` in `/etc/ssh/sshd_config`
- Use a hardware-key-backed SSH key (YubiKey, Secretive, etc.) — not a
  plaintext `~/.ssh/id_ed25519`
- Allowlist your home/work IP in the VPS firewall if your provider supports it
- Rotate the SSH key whenever you change machines

---

## Things to rotate on a schedule

| Item | Cadence | How |
| --- | --- | --- |
| Vault passphrase | every 90 days, or after any suspected leak | re-encrypt vault (below) + update `treasury/.env` |
| RPC keys | every 90 days, or whenever the provider rotates their security | mint new key, edit `.env`, restart |
| Buyback-hot wallet | every 30 days, or when bucket lamport balance crosses `0` going up | `wallet remove` old + `wallet generate` new + fund + restart |
| Creator wallet | only on suspected compromise (drain the float, then `admin_set_coin_creator`) | requires pump_amm admin authority; not normally rotatable |
| Cold treasury / mining-treasury | only on suspected compromise of the cold key (e.g. hardware wallet retired) | move balances to a new cold wallet, edit `treasury.config.json`, restart |
| Tor circuit (if `TOR_PROXY` set) | automatic every 10 min by Tor; nothing to do | n/a |

---

## Re-encrypting the vault

Use this whenever you change the vault passphrase. Works for dev → VPS
hand-off and for in-place rotation on the VPS.

There's no first-class `vault rekey` command yet, so the safest path is
"export each wallet, re-import into a new vault":

```pwsh
# 1. Open the OLD vault and dump each wallet's secret key (DANGEROUS:
#    these go to your terminal, then your clipboard. Do this on a
#    machine without screen recording / clipboard managers.).
$env:VAULT_PATH = "C:\dev\AMM\.amm-treasury\vault.enc"
$env:VAULT_PASSPHRASE = "<old passphrase>"

pnpm cli wallet show --label creator-1
# copy "secret b58: <…>"

pnpm cli wallet show --label buyback-hot-1
# copy "secret b58: <…>"

# 2. Move the old vault aside.
Move-Item C:\dev\AMM\.amm-treasury\vault.enc C:\dev\AMM\.amm-treasury\vault.enc.bak

# 3. Create a fresh vault with the NEW passphrase.
$env:VAULT_PASSPHRASE = "<new passphrase>"
pnpm cli vault init --from-env

# 4. Re-import each wallet into the new vault.
pnpm cli wallet import --label creator-1     --tag creator      # paste old secret
pnpm cli wallet import --label buyback-hot-1 --tag buyback-hot  # paste old secret

# 5. Verify pubkeys match the old ones (otherwise the on-chain coin_creator
#    won't match anymore).
pnpm cli wallet list

# 6. Update .env (and the VPS .env) with the new passphrase.
#    Edit treasury/.env: TREASURY_VAULT_PASSPHRASE=<new passphrase>

# 7. Once the engine starts cleanly under the new passphrase, securely
#    delete the backup.
sdelete C:\dev\AMM\.amm-treasury\vault.enc.bak    # or `shred` on Linux
```

Then `scp` the new `vault.enc` to the VPS, putting it at the path
`treasury/.env` references via `VAULT_PATH`.

---

## VPS deploy quick-recipe

Linux (Ubuntu 24.04 LTS example) systemd unit:

```ini
# /etc/systemd/system/amm-treasury.service
[Unit]
Description=AMM treasury engine (PumpSwap fee claim + 30/70 split + phased buyback)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=treasury
Group=treasury
WorkingDirectory=/srv/AMM
EnvironmentFile=/srv/AMM/treasury/.env
ExecStart=/usr/bin/pnpm --filter @amm/treasury start start -c /srv/AMM/treasury.config.json
Restart=on-failure
RestartSec=15s

# Hardening — drop everything the engine doesn't need.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/srv/AMM/treasury/.data /srv/AMM/.amm-treasury
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

Then:

```bash
# As root, on the VPS:
useradd -r -m -d /srv/AMM -s /bin/bash treasury
chown -R treasury:treasury /srv/AMM
chmod 700 /srv/AMM/.amm-treasury /srv/AMM/treasury/.data
chmod 600 /srv/AMM/.amm-treasury/vault.enc /srv/AMM/treasury/.env

systemctl daemon-reload
systemctl enable --now amm-treasury
systemctl status amm-treasury
journalctl -u amm-treasury -f      # live log
```

To check engine state without restarting:

```bash
sudo -u treasury pnpm --filter @amm/treasury start status -c /srv/AMM/treasury.config.json -n 20
```

---

## What NOT to do

- ❌ Don't reuse `juicymelons` (your local MM passphrase) for the VPS treasury vault.
- ❌ Don't put `VAULT_PASSPHRASE=` and `TREASURY_VAULT_PASSPHRASE=` in the same env file on the VPS — they belong to different vaults and only the relevant one should be reachable from each process.
- ❌ Don't `scp` your local `treasury/.data/treasury.db`. Stale dip-tracker history would make the engine fire tranches against ghost prices.
- ❌ Don't run the engine as `root`. Make a dedicated `treasury` user; the engine never needs more than read on its own files and write on `.data/` and `.amm-treasury/` (latter only if you want to rotate keys in-place).
- ❌ Don't expose any ports. The engine has no inbound network surface — it only makes outbound RPC + Jito calls. If anything on the VPS firewall is open for "dashboard access", it's wrong.
- ❌ Don't enable cloud provider snapshots / backups on the disk holding `vault.enc` unless those snapshots are themselves encrypted with a key the cloud provider doesn't have. AWS/GCP/DigitalOcean snapshots = plaintext copies of your vault, by default.
