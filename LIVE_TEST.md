# LIVE TEST — your first real claim, step by step

This doc is the "do exactly these steps in this order" guide for taking the
treasury engine live for the first time. Read top to bottom. Do not skip.

If anything in here surprises you, **stop and ask** before clicking the live
button. Once SOL moves on chain, it's gone.

---

## What the engine will and won't do (right now)

Your current `treasury.config.json` is in **safe / manual mode**:

- `claim.manualOnly: true` → the engine **will never auto-claim**. The only
  way a claim happens is if you press the green **"Claim NOW (live)"** button
  in the dashboard.
- `loop.dryRun: false` → live mode is on. When you press the button, it sends
  a real transaction.
- `loop.skipBuybacks: true` → no dip detection, no auto-buybacks. Even if the
  token tanks 50% the engine does nothing.
- `split.bucketEnabled: false` → after a successful claim, the 30% treasury
  cut moves to `treasury-1`; the remaining 70% **stays in the creator wallet
  (BxWEm...)**. Nothing flows to the buyback bucket until you flip this on.
- `wallets.treasury` → `treasury-1` (cold) — gets the 30% cut on each claim.
- `wallets.miningTreasury` → `mining-cold-1` (cold) — only matters once
  buybacks are enabled (it's where bought tokens get swept). Doesn't move SOL.

In English: **you press the button → engine asks the chain to release the
fees → if it lands, 30% lamports go to the cold treasury wallet, 70% stay in
BxWEm. Nothing else happens. That's it.**

---

## Step 0 — sanity check (do this once)

Before you start the engine, eyeball these:

1. **Vault has the right BxWEm secret in `creator-1`.**
   The dashboard's Vault panel shows the public key for each label. Confirm
   `creator-1`'s pubkey matches `BxWEmpYdTx6sYW1uFf7qwgZ45tKEByfPQdDw4xjCaDtc`
   (truncated: `BxWEmp...jCaDtc`).
   If it doesn't, you need to remove and re-import — see "Re-importing the
   creator wallet" below.

2. **Tor is OFF for this test.**
   Open `treasury/.env`. The line `TOR_PROXY=socks5h://127.0.0.1:9150` should
   be commented out (start with `#`). If it isn't, comment it out, save the
   file. (Already done in the latest edit, but double-check.)

3. **Helius RPC key is filled in.**
   `treasury/.env` → `RPC_HELIUS=https://mainnet.helius-rpc.com/?api-key=...`
   should not be blank.

4. **You have a tiny amount of SOL in BxWEm to pay tx fees.**
   The claim needs ~0.001 SOL of headroom for the network fee + simulation
   priority. You have 0.0857 SOL — plenty.

---

## Step 1 — start the engine

In a fresh PowerShell window, from the repo root:

```powershell
pnpm --filter @amm/treasury start start -c "C:/dev/AMM/treasury.config.json" --web-port 4319
```

(Yes, `start start` is correct — first `start` is the pnpm script, second is
the CLI subcommand.)

**Watch the startup log**. You should see, roughly in order:

```
vault unlocked   wallets:4
rpc manager initialised   endpoints: helius, public
treasury store opened
web UI listening   url: http://127.0.0.1:4319/
treasury engine starting
pool resolved   coinCreator: ...
```

You'll likely also see this warning:

```
WARN  configured creator wallet does not match on-chain coin_creator;
      claim phase will fail until reconciled
```

That's expected and you can ignore it for now. You've already chosen to let
the chain decide whether BxWEm has authority. The engine will let you try.

If you see `endpoint marked unhealthy` repeating — Tor is still on or your
Helius URL is wrong. Fix that before continuing.

**Leave this terminal window open. Don't close it. The engine runs as long
as that window is alive.** To stop it later, focus the window and press
`Ctrl+C` once.

---

## Step 2 — open the dashboard

In your browser: **http://127.0.0.1:4319/**

Verify the badges in the top-right strip:

- `running` (green) — engine is alive
- `live` (red/orange) — dryRun is OFF
- `no buybacks` (yellow) — buybacks disabled
- `manual claims only` (yellow) — auto-claim is OFF
- `no bucket route (70% stays in creator)` (yellow) — split is treasury-only

If any badge is missing or wrong, **stop and tell me**.

In the **WALLETS** panel, confirm:

| role           | should be             |
| -------------- | --------------------- |
| creator (hot)  | `BxWEmp...jCaDtc`     |
| buyback hot    | `ENNpVC...ceM8qq`     |
| treasury (cold)| `EuhGfb...9bJhGg`     |
| mining (cold)  | `6h1eY7...joohuL`     |

If treasury or mining still show `BxWEmp...jCaDtc` you're running an old
engine. Stop it (`Ctrl+C` in the terminal) and start it again — the config
on disk is correct, the live process just needs to re-read it.

In the **on-chain** panel, check:

- `unclaimed (vault)` shows non-zero SOL → there are fees waiting
- `claim mode` shows "manual only (button)"
- `split routing` shows "30% treasury / rest stays in creator"

If `unclaimed (vault)` shows `0.000000 SOL`, there's nothing to claim and
clicking the button will return "creator vault is empty".

---

## Step 3 — press the button

In the **CONTROLS** panel, click the green **"⚡ Claim NOW (live)"** button.

Internally, what happens:

1. Engine reads the on-chain creator-fee-vault balance.
2. Engine builds the `collect_coin_creator_fee` instruction signed by
   `creator-1` (your BxWEm wallet).
3. Engine **simulates** the tx against the mainnet RPC. **Simulation is
   free — no SOL leaves your wallet at this stage.**
4. **Two outcomes:**
   - **Simulation succeeds** → the tx is sent on chain. Network fee +
     priority fee land (≈ 0.000086 SOL total). The vault SOL transfers to
     your BxWEm wallet. Then a second tx fires that splits 30% to
     `treasury-1`. Both signatures appear in the dashboard's "recent
     activity" panel.
   - **Simulation fails** → button shows red error like "Custom program
     error: 0xN" or "wallet not authority". **No fee is paid. Nothing
     moves on chain.** You'll know definitively that BxWEm doesn't have
     fee-collection authority on this token.

That's the whole test. Either it works and you'll see your BxWEm balance
go up by approximately the unclaimed amount, or it doesn't and the chain
tells you exactly why.

---

## Step 4 — verify

After the button shows a green success message:

1. Click the tx link in the **recent activity → claims** row to open
   Solscan. Confirm:
   - The signer is BxWEm
   - The "balance changes" tab shows BxWEm went up by the claimed amount
2. The **wallets** panel will refresh in 5–10 seconds and show:
   - `creator (hot) BxWEmp...jCaDtc` balance increased by claim - 30% - fees
   - `treasury (cold) EuhGfb...9bJhGg` balance increased by 30% of claim
3. The on-chain `unclaimed (vault)` value drops to 0.000000 SOL.

Now `Ctrl+C` the engine in the terminal window. You're done with the test.

---

## What if it fails

The button will show one of these errors. Here's what each means.

### `creator vault is empty (nothing to claim)`

The on-chain coin-creator vault has no SOL in it. Either no trades have
happened on the pool since the last claim, or you're looking at the wrong
pool. Not a wallet-authority issue.

### `simulation failed: ... Custom program error: 0x... logs: ...`

Pump_amm rejected the tx. The most likely cause: BxWEm is not the on-chain
`coin_creator`. The logs in the error will say something like
`coin_creator constraint violated`. **Zero SOL was spent.**

If this happens: copy the full error and send it to me. The error code +
logs will tell us exactly which constraint failed and we'll know how to
move forward (e.g. import the AaxFwx... key, or run `set_creator` from
AaxFwx... to BxWEm).

### `Insufficient funds`

BxWEm doesn't have enough SOL for the claim tx fee. Send ~0.005 SOL to it
and retry.

### `Blockhash not found` / `Node is behind` / `429`

Transient RPC issue. The executor retries 2x automatically. If you see this
in the final error, just click the button again.

### `endpoint marked unhealthy` (in the engine log)

Your RPC endpoints are failing. Check that:

- Tor is genuinely off (no `TOR_PROXY` line uncommented in `treasury/.env`)
- Helius URL in `treasury/.env` is valid (paste it into a browser; it should
  return `{"jsonrpc":"2.0","error":...,"id":null}` — that's correct, the
  GET method just isn't supported but the host responded).

---

## Re-importing the creator wallet

If `creator-1` in the vault doesn't show `BxWEmp...jCaDtc`:

1. In the dashboard's **Vault · wallets** panel, click **remove** next to
   `creator-1`. Confirm.
2. Use the **Import existing keypair** form:
   - Label: `creator-1`
   - Tags: `creator`
   - Paste your BxWEm secret key (base58 string OR JSON array `[1,2,3,...]`).
3. Click **import**. The pubkey column should now show `BxWEmp...jCaDtc`.
4. **Restart the engine** (`Ctrl+C` in the terminal, then run the start
   command again from Step 1). The vault is read once at startup; the
   running engine still has the old keypair in memory until restart.

---

## Turning on auto-mode later

When you're satisfied the manual claim works and you want to flip on the
full system:

| What you want                                  | Edit in `treasury.config.json` |
| ---------------------------------------------- | ------------------------------ |
| Auto-claim every hour when vault > 0.05 SOL    | `claim.manualOnly: false`      |
| Send the 70% to the buyback bucket too         | `split.bucketEnabled: true`    |
| Turn on dip-detected auto-buybacks             | `loop.skipBuybacks: false`     |

Restart the engine after each change.

You can also flip `dryRun` and `skipBuybacks` live from the dashboard's
toggles without restarting (they persist across restarts via the SQLite
store).

---

## Emergency stop

If anything starts behaving in a way you don't like:

1. Focus the engine terminal window. Press `Ctrl+C` once. The engine
   gracefully stops within ~1 second. No new transactions will be sent.
2. If you can't get to the terminal: in the dashboard, flip the **dry-run**
   toggle ON. Future ticks will simulate-only. Then go kill the terminal.
3. Worst case: kill the process by PID. From any PowerShell window:

   ```powershell
   Get-Process node | Where-Object { $_.MainWindowTitle -match "treasury" } | Stop-Process -Force
   ```

   (Or just close the terminal window — Windows will SIGINT it.)
