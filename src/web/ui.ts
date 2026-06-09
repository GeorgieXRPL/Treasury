/**
 * The treasury web UI is a single HTML file with inline CSS + vanilla JS.
 * No build step, no React, no bundler. The whole thing fits in this string
 * so `tsc` doesn't need to copy any non-ts assets to dist/.
 *
 * The token (if any) is injected at render time so the page-side fetch()
 * calls can set the `x-treasury-token` header. We do NOT echo the token
 * anywhere visible — just store it in a non-enumerable window prop.
 */
export function renderIndexHtml(opts: { token?: string }): string {
  const tokenLiteral = JSON.stringify(opts.token ?? '');
  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>treasury · buyback engine</title>
  <style>${INLINE_CSS}</style>
</head>
<body>
  <header>
    <div class="title">
      <span class="logo">●</span>
      <h1>treasury · buyback engine</h1>
    </div>
    <div class="meta">
      <span id="badge-status" class="badge badge-stopped">stopped</span>
      <span id="badge-mode" class="badge badge-dry">dry-run</span>
      <span id="badge-skip" class="badge badge-idle" style="display:none">no buybacks</span>
      <span id="badge-manual" class="badge badge-warn-soft" style="display:none">manual claims only</span>
      <span id="badge-nobucket" class="badge badge-warn-soft" style="display:none">no bucket route</span>
      <span id="badge-flight" class="badge badge-idle">idle</span>
      <span class="muted" id="updated">—</span>
    </div>
  </header>

  <main>
    <section class="grid grid-3">
      <article class="card">
        <h2>Pool</h2>
        <dl id="pool-dl"></dl>
      </article>

      <article class="card">
        <h2>Dip tracker</h2>
        <div class="big-row">
          <div><span class="big" id="dip-current">—</span><span class="muted"> current</span></div>
          <div><span class="big" id="dip-high">—</span><span class="muted"> ${'window high'}</span></div>
          <div><span class="big bad" id="dip-drawdown">—</span><span class="muted"> drawdown</span></div>
        </div>
        <canvas id="dip-spark" width="640" height="80"></canvas>
        <div class="muted small" id="dip-meta">—</div>
      </article>

      <article class="card">
        <h2>Controls</h2>
        <div class="control-row">
          <label class="switch">
            <input type="checkbox" id="ctrl-dry" />
            <span>dry-run</span>
          </label>
          <label class="switch">
            <input type="checkbox" id="ctrl-skip" />
            <span>skip buybacks (claim + split only)</span>
          </label>
        </div>
        <div class="control-row">
          <button id="ctrl-tick" class="btn">tick now</button>
          <button id="ctrl-claim" class="btn btn-warn">force claim cooldown</button>
          <button id="ctrl-claim-live" class="btn btn-danger-solid">⚡ Claim NOW (live)</button>
          <button id="ctrl-tor-check" class="btn">Check Tor egress IP</button>
          <span id="tor-result" class="tor-pill" style="display:none"></span>
        </div>
        <p class="muted small">
          <strong>dry-run</strong> flips immediately; the next tick respects it.
          <strong>skip buybacks</strong> runs only claim + split each tick — no
          dip sampling, no swaps, the bucket just accumulates SOL.
          <strong>tick now</strong> wakes the loop without waiting out the poll interval.
          <strong>force claim cooldown</strong> resets the claim-attempt timer
          so the next tick re-evaluates the on-chain vault (still respects dry-run).
          <strong>Claim NOW (live)</strong> bypasses everything and signs a real
          collect_coin_creator_fee tx immediately — only works if the vault has
          the secret for the on-chain coin_creator.
        </p>
        <p id="ctrl-msg" class="msg"></p>

        <details class="ctrl-details">
          <summary>$ Manual buyback (test) — fire one swap from the bucket</summary>
          <p class="muted small">
            Bypasses dip detection, tier cooldowns, and tier amounts. Use to
            sanity-check the swap path (Jupiter routing, slippage, RPC) on a
            small amount before flipping <code>skipBuybacks</code> to false.
            Honors the engine's dry-run by default; check
            <em>force live</em> to send for real even with dry-run on.
          </p>
          <form id="buyback-form" class="form-grid">
            <label>amount <span class="muted small">(SOL out of bucket)</span>
              <input type="text" name="sol" placeholder="0.05" autocomplete="off" required />
            </label>
            <label>slippage <span class="muted small">(bps; blank = config default)</span>
              <input type="text" name="slippageBps" placeholder="150" autocomplete="off" />
            </label>
            <label class="full inline">
              <input type="checkbox" name="sweepAfter" />
              <span>sweep tokens to mining-treasury after swap (default OFF for tests)</span>
            </label>
            <label class="full inline">
              <input type="checkbox" name="liveDespiteDryRun" />
              <span>force live (override engine dry-run for THIS swap only)</span>
            </label>
            <label class="full inline">
              <input type="checkbox" name="confirm" required />
              <span><strong>I confirm</strong> this is a live buyback test</span>
            </label>
            <div class="form-actions">
              <button type="submit" class="btn btn-danger-solid">Buyback NOW</button>
              <span class="msg" id="buyback-msg"></span>
            </div>
          </form>
        </details>
      </article>
    </section>

    <section class="grid grid-2">
      <article class="card">
        <h2>Wallets</h2>
        <table id="wallets-tbl" class="kv-tbl">
          <tbody></tbody>
        </table>
      </article>

      <article class="card">
        <h2>On-chain</h2>
        <dl id="onchain-dl"></dl>
      </article>
    </section>

    <section class="card">
      <h2>Tier ladder</h2>
      <div id="tiers" class="tiers-grid"></div>
    </section>

    <section class="card">
      <h2>Vault · wallets</h2>
      <p class="muted small no-margin-top">
        Manage the encrypted wallet store at
        <code>.amm-treasury/vault.enc</code>. Imports and removals take effect
        on disk immediately, but the running engine still uses the wallets it
        loaded at startup — restart the engine after changes for the new
        keypair to be used in live tx signing.
      </p>
      <div class="tbl-wrap" style="max-height: 280px; margin-top: 10px;">
        <table id="vault-tbl" class="data-tbl">
          <thead>
            <tr><th>label</th><th>pubkey</th><th>tags</th><th>actions</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <details class="vault-form">
        <summary>+ Import a wallet from a base58 secret key</summary>
        <form id="vault-import-form" class="form-grid">
          <label>label
            <input type="text" name="label" placeholder="creator-1" autocomplete="off" required />
          </label>
          <label>tags <span class="muted small">(comma-separated)</span>
            <input type="text" name="tags" placeholder="creator" autocomplete="off" />
          </label>
          <label class="full">base58 secret key <span class="muted small">(masked, never echoed)</span>
            <input type="password" name="secretBase58" autocomplete="off" required />
          </label>
          <label class="full inline">
            <input type="checkbox" name="replace" />
            <span>replace existing label if present (removes the old wallet first)</span>
          </label>
          <div class="form-actions">
            <button type="submit" class="btn">import</button>
            <span class="msg" id="vault-import-msg"></span>
          </div>
        </form>
      </details>

      <details class="vault-form">
        <summary>+ Import from Solana CLI keypair JSON (paste the [...,...,...] array)</summary>
        <form id="vault-import-json-form" class="form-grid">
          <label>label
            <input type="text" name="label" placeholder="creator-1" autocomplete="off" required />
          </label>
          <label>tags <span class="muted small">(comma-separated)</span>
            <input type="text" name="tags" placeholder="creator" autocomplete="off" />
          </label>
          <label class="full">keypair JSON array
            <textarea name="keypair" rows="3" placeholder="[123, 45, 67, ... 64 numbers ...]" required></textarea>
          </label>
          <label class="full inline">
            <input type="checkbox" name="replace" />
            <span>replace existing label if present</span>
          </label>
          <div class="form-actions">
            <button type="submit" class="btn">import</button>
            <span class="msg" id="vault-import-json-msg"></span>
          </div>
        </form>
      </details>

      <details class="vault-form">
        <summary>+ Generate a new throwaway wallet (random keypair)</summary>
        <form id="vault-generate-form" class="form-grid">
          <label>label prefix
            <input type="text" name="prefix" placeholder="buyback-hot" value="wallet" autocomplete="off" required />
          </label>
          <label>tags <span class="muted small">(comma-separated)</span>
            <input type="text" name="tags" placeholder="buyback-hot" autocomplete="off" />
          </label>
          <div class="form-actions">
            <button type="submit" class="btn">generate</button>
            <span class="msg" id="vault-generate-msg"></span>
          </div>
        </form>
      </details>

      <details class="vault-form vault-form-danger">
        <summary>$ Move SOL between wallets (live transfer)</summary>
        <p class="muted small" style="padding: 10px 14px 0;">
          Sign and send a real <code>SystemProgram.transfer</code> from a
          vault wallet to any destination. Useful for sweeping a wallet
          back to your main, topping up the buyback bucket, or recovering
          SOL stuck somewhere. Source must be a vault label (we need its
          secret key); destination can be a vault label OR a raw base58
          pubkey. Bypasses the engine's dry-run flag — this form has its
          own confirmation checkbox.
        </p>
        <form id="vault-transfer-form" class="form-grid">
          <label>from <span class="muted small">(vault label)</span>
            <select name="from" id="transfer-from" required></select>
          </label>
          <label>to <span class="muted small">(vault label or pubkey)</span>
            <input type="text" name="to" placeholder="creator-1 or BxWE..." autocomplete="off" required />
          </label>
          <label>amount <span class="muted small">(SOL)</span>
            <input type="text" name="sol" placeholder="0.5" autocomplete="off" />
          </label>
          <label>reserve <span class="muted small">(lamports kept in source when sweeping)</span>
            <input type="text" name="reserveLamports" placeholder="1000000" value="1000000" autocomplete="off" />
          </label>
          <label class="full inline">
            <input type="checkbox" name="sweepAll" id="transfer-sweep" />
            <span>sweep all (ignores amount; sends balance minus reserve)</span>
          </label>
          <label class="full inline">
            <input type="checkbox" name="confirm" required />
            <span><strong>I confirm</strong> this is a live transfer of real SOL</span>
          </label>
          <div class="form-actions">
            <button type="submit" class="btn btn-danger-solid">send</button>
            <span class="msg" id="vault-transfer-msg"></span>
          </div>
        </form>
      </details>
    </section>

    <section class="grid grid-3 stretch">
      <article class="card">
        <h2>Recent claims</h2>
        <div class="tbl-wrap">
          <table id="claims-tbl" class="data-tbl">
            <thead><tr><th>when</th><th>+ SOL</th><th>tx</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </article>
      <article class="card">
        <h2>Recent splits</h2>
        <div class="tbl-wrap">
          <table id="splits-tbl" class="data-tbl">
            <thead><tr><th>when</th><th>treasury</th><th>bucket</th><th>tx</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </article>
      <article class="card">
        <h2>Recent buybacks</h2>
        <div class="tbl-wrap">
          <table id="buybacks-tbl" class="data-tbl">
            <thead><tr><th>when</th><th>tier</th><th>dd</th><th>SOL in</th><th>tx</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </article>
    </section>

    <section class="card">
      <div class="logs-head">
        <h2 class="no-margin">Logs</h2>
        <div class="logs-controls">
          <label class="logs-ctrl">
            <span>min level</span>
            <select id="logs-level">
              <option value="10">debug</option>
              <option value="20">debug+</option>
              <option value="30" selected>info+</option>
              <option value="40">warn+</option>
              <option value="50">error</option>
            </select>
          </label>
          <label class="logs-ctrl">
            <span>filter</span>
            <input type="text" id="logs-filter" placeholder="mod or msg substring" autocomplete="off" />
          </label>
          <label class="logs-ctrl inline">
            <input type="checkbox" id="logs-pause" />
            <span>pause</span>
          </label>
          <label class="logs-ctrl inline">
            <input type="checkbox" id="logs-autoscroll" checked />
            <span>auto-scroll</span>
          </label>
          <button id="logs-clear" class="btn btn-tiny">clear view</button>
          <span class="muted small" id="logs-meta">—</span>
        </div>
      </div>
      <div id="logs-pane" class="logs-pane"></div>
    </section>
  </main>

  <footer>
    <span class="muted small">
      127.0.0.1 only · poll every 3s · close the tab to stop watching
    </span>
  </footer>

  <script>
    window.__TREASURY_TOKEN__ = ${tokenLiteral};
    ${INLINE_JS}
  </script>
</body>
</html>`;
}

const INLINE_CSS = `
  :root {
    --bg: #0e1116;
    --bg-card: #161b22;
    --bg-card-hover: #1c2230;
    --bg-input: #0b0e13;
    --border: #2a313c;
    --border-strong: #3a4252;
    --fg: #e6edf3;
    --fg-muted: #8b949e;
    --fg-dim: #6e7681;
    --accent: #58a6ff;
    --good: #3fb950;
    --warn: #d29922;
    --bad: #f85149;
    --dry: #79c0ff;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-card);
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header .title { display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: 0.2px; }
  .logo { color: var(--accent); font-size: 18px; }
  header .meta { display: flex; align-items: center; gap: 10px; }
  main { padding: 20px 24px 60px; max-width: 1500px; margin: 0 auto; }
  footer { text-align: center; padding: 16px; }

  .grid { display: grid; gap: 16px; margin-bottom: 16px; }
  .grid-2 { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .stretch > .card { display: flex; flex-direction: column; }
  @media (max-width: 1100px) {
    .grid-3, .grid-2 { grid-template-columns: 1fr; }
  }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .card h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--fg-muted);
    font-weight: 600;
    margin: 0 0 12px;
  }

  dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
  dl dt { color: var(--fg-muted); font-size: 12px; align-self: center; }
  dl dd { margin: 0; font-family: var(--mono); font-size: 12.5px; }
  dl dd.mono-trunc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .big-row { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 8px; }
  .big-row > div { display: flex; align-items: baseline; gap: 6px; }
  .big { font-size: 22px; font-weight: 600; font-family: var(--mono); }
  .big.good { color: var(--good); }
  .big.bad  { color: var(--bad); }
  .big.warn { color: var(--warn); }
  .muted { color: var(--fg-muted); }
  .small { font-size: 12px; }

  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border: 1px solid transparent;
    font-family: var(--mono);
  }
  .badge-running { background: rgba(63,185,80,0.12); color: var(--good); border-color: rgba(63,185,80,0.4); }
  .badge-stopped { background: rgba(248,81,73,0.12); color: var(--bad);  border-color: rgba(248,81,73,0.4); }
  .badge-dry     { background: rgba(121,192,255,0.12); color: var(--dry); border-color: rgba(121,192,255,0.4); }
  .badge-live    { background: rgba(210,153,34,0.12);  color: var(--warn); border-color: rgba(210,153,34,0.4); }
  .badge-idle    { background: rgba(110,118,129,0.12); color: var(--fg-dim); border-color: rgba(110,118,129,0.4); }
  .badge-busy    { background: rgba(88,166,255,0.12);  color: var(--accent); border-color: rgba(88,166,255,0.4); }
  .badge-warn-soft { background: rgba(210,153,34,0.12); color: var(--warn); border-color: rgba(210,153,34,0.4); }

  .tor-pill {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid;
    font-size: 12px;
    font-family: var(--mono);
  }
  .tor-pending { background: rgba(110,118,129,0.12); color: var(--fg-dim); border-color: rgba(110,118,129,0.4); }
  .tor-ok      { background: rgba(63,185,80,0.12);   color: var(--good);   border-color: rgba(63,185,80,0.4); }
  .tor-warn    { background: rgba(210,153,34,0.12);  color: var(--warn);   border-color: rgba(210,153,34,0.4); }
  .tor-bad     { background: rgba(248,81,73,0.12);   color: var(--bad);    border-color: rgba(248,81,73,0.4); }

  .control-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
  .switch input { width: 16px; height: 16px; accent-color: var(--accent); }

  .btn {
    background: var(--bg-input);
    color: var(--fg);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 6px 12px;
    font: inherit;
    cursor: pointer;
    transition: background 80ms;
  }
  .btn:hover { background: var(--bg-card-hover); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-warn { color: var(--warn); border-color: rgba(210,153,34,0.45); }
  .btn-warn:hover { background: rgba(210,153,34,0.08); }
  .btn-danger-solid {
    background: rgba(248,81,73,0.12);
    color: var(--bad);
    border-color: rgba(248,81,73,0.45);
    font-weight: 600;
  }
  .btn-danger-solid:hover { background: rgba(248,81,73,0.22); }

  .msg { margin: 6px 0 0; font-size: 12px; min-height: 1em; color: var(--fg-muted); }
  .msg.ok  { color: var(--good); }
  .msg.err { color: var(--bad); }

  .kv-tbl { width: 100%; border-collapse: collapse; }
  .kv-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12.5px; vertical-align: middle; }
  .kv-tbl tr:last-child td { border-bottom: none; }
  .kv-tbl td.role { color: var(--fg-muted); width: 28%; font-family: -apple-system, sans-serif; font-size: 12px; }
  .kv-tbl td.bal  { text-align: right; width: 28%; }
  .kv-tbl .pk     { display: inline-block; max-width: 38ch; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
  .copy-btn {
    background: none; border: none; color: var(--fg-dim); cursor: pointer;
    padding: 0 4px; font-family: var(--mono); font-size: 11px;
  }
  .copy-btn:hover { color: var(--accent); }

  .tiers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  .tier {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
  .tier.met        { border-color: rgba(210,153,34,0.5); }
  .tier.eligible   { border-color: rgba(63,185,80,0.6); background: rgba(63,185,80,0.05); }
  .tier .head { display: flex; justify-content: space-between; margin-bottom: 8px; font-weight: 600; }
  .tier .head .dd { color: var(--accent); font-family: var(--mono); }
  .tier .head .sol { color: var(--fg); font-family: var(--mono); font-size: 13px; }
  .tier .meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--fg-muted); margin-bottom: 6px; }
  .tier .bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .tier .bar > span { display: block; height: 100%; background: var(--accent); transition: width 250ms; }
  .tier.eligible .bar > span { background: var(--good); }

  .tbl-wrap { max-height: 360px; overflow: auto; }
  .data-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .data-tbl th, .data-tbl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .data-tbl th { font-weight: 600; color: var(--fg-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; background: var(--bg-card); }
  .data-tbl td.mono { font-family: var(--mono); }
  .data-tbl td.num  { text-align: right; font-family: var(--mono); }
  .data-tbl a { color: var(--accent); text-decoration: none; font-family: var(--mono); }
  .data-tbl a:hover { text-decoration: underline; }
  .data-tbl tr.dry { opacity: 0.55; }
  .data-tbl tr.dry td:first-child::before { content: "DRY · "; color: var(--dry); font-size: 10px; }

  #dip-spark {
    width: 100%;
    height: 80px;
    margin-top: 4px;
    border-radius: 6px;
    background: var(--bg-input);
    display: block;
  }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 5px; }

  .no-margin-top { margin-top: 0; }
  code { font-family: var(--mono); background: var(--bg-input); padding: 1px 5px; border-radius: 3px; font-size: 12px; }

  .vault-form {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
    padding: 0;
  }
  .vault-form summary {
    cursor: pointer;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--accent);
    user-select: none;
    list-style: none;
  }
  .vault-form summary::-webkit-details-marker { display: none; }
  .vault-form summary:hover { background: rgba(88,166,255,0.06); }
  .vault-form[open] summary { border-bottom: 1px solid var(--border); }
  .vault-form-danger summary { color: var(--bad); border-color: rgba(248,81,73,0.4); }
  .vault-form-danger summary:hover { background: rgba(248,81,73,0.06); }
  .vault-form-danger[open] summary { border-bottom-color: rgba(248,81,73,0.4); }

  .ctrl-details {
    margin-top: 12px;
    border: 1px solid rgba(248,81,73,0.3);
    border-radius: 6px;
    overflow: hidden;
  }
  .ctrl-details summary {
    cursor: pointer;
    padding: 8px 12px;
    background: rgba(248,81,73,0.06);
    color: var(--bad);
    font-size: 12px;
    font-weight: 600;
    list-style: none;
    user-select: none;
  }
  .ctrl-details summary::-webkit-details-marker { display: none; }
  .ctrl-details summary:hover { background: rgba(248,81,73,0.1); }
  .ctrl-details[open] summary { border-bottom: 1px solid rgba(248,81,73,0.3); }
  .ctrl-details > p { padding: 10px 14px 0; margin: 0; }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
    padding: 14px;
  }
  .form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-muted); }
  .form-grid label.full { grid-column: 1 / -1; }
  .form-grid label.inline { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
  .form-grid label.inline input { width: 16px; height: 16px; accent-color: var(--accent); }
  .form-grid input[type="text"], .form-grid input[type="password"], .form-grid textarea {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .form-grid input:focus, .form-grid textarea:focus { outline: none; border-color: var(--accent); }
  .form-grid textarea { resize: vertical; min-height: 60px; }
  .form-actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .btn-danger {
    background: var(--bg-input);
    border: 1px solid rgba(248,81,73,0.4);
    color: var(--bad);
    border-radius: 4px;
    padding: 3px 8px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .btn-danger:hover { background: rgba(248,81,73,0.1); }
  .tag-pill { display: inline-block; padding: 1px 6px; margin-right: 3px; border-radius: 3px; font-size: 10px; background: rgba(88,166,255,0.15); color: var(--accent); font-family: var(--mono); }

  .no-margin { margin: 0; }
  .logs-head {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .logs-controls {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-left: auto;
  }
  .logs-ctrl { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.4px; }
  .logs-ctrl.inline { cursor: pointer; }
  .logs-ctrl select, .logs-ctrl input[type="text"] {
    background: var(--bg-input);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 6px;
    font: inherit;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .logs-ctrl input[type="text"] { width: 200px; }
  .logs-ctrl select:focus, .logs-ctrl input:focus { outline: none; border-color: var(--accent); }
  .logs-ctrl input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--accent); margin: 0; }
  .btn-tiny { background: var(--bg-input); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font: inherit; font-size: 11px; cursor: pointer; }
  .btn-tiny:hover { background: var(--bg-card-hover); border-color: var(--border-strong); }

  .logs-pane {
    height: 360px;
    overflow: auto;
    background: #06080c;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.45;
    white-space: pre;
  }
  .log-row { display: block; }
  .log-row .ts { color: var(--fg-dim); }
  .log-row .mod { color: var(--accent); }
  .log-row .msg { color: var(--fg); }
  .log-row .fields { color: var(--fg-muted); }
  .log-debug .lvl { color: var(--fg-dim); }
  .log-debug .msg { color: var(--fg-muted); }
  .log-info  .lvl { color: var(--good); }
  .log-warn  .lvl { color: var(--warn); }
  .log-warn  { background: rgba(210,153,34,0.05); }
  .log-error .lvl { color: var(--bad); }
  .log-error { background: rgba(248,81,73,0.08); }
  .log-row .lvl { display: inline-block; min-width: 5ch; text-align: left; font-weight: 600; }
  .logs-empty { color: var(--fg-dim); padding: 6px; }
`;

const INLINE_JS = `
  (() => {
    const TOKEN = window.__TREASURY_TOKEN__ || "";
    const POLL_MS = 3000;
    const SOL = 1_000_000_000;

    const $  = (id) => document.getElementById(id);
    const fmtSol = (lam) => {
      if (lam === null || lam === undefined) return "—";
      const n = typeof lam === "string" ? Number(lam) : lam;
      if (!Number.isFinite(n)) return "—";
      return (n / SOL).toFixed(6) + " SOL";
    };
    const fmtPct = (frac) => (frac * 100).toFixed(2) + "%";
    const fmtTs = (ms) => {
      if (!ms) return "—";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    };
    const fmtAgo = (ms) => {
      if (!ms) return "never";
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.round(s / 60) + "m ago";
      return Math.round(s / 3600) + "h ago";
    };
    const fmtDur = (ms) => {
      if (ms <= 0) return "ready";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + "s";
      if (s < 3600) return Math.round(s / 60) + "m";
      return Math.round(s / 3600) + "h";
    };
    const truncPk = (pk) => pk ? pk.slice(0, 6) + "…" + pk.slice(-6) : "—";
    const truncSig = (sig) => sig ? sig.slice(0, 8) + "…" + sig.slice(-6) : "—";

    async function api(path, opts) {
      const init = opts || {};
      init.headers = Object.assign({}, init.headers || {}, {
        "content-type": "application/json",
      });
      if (TOKEN) init.headers["x-treasury-token"] = TOKEN;
      const r = await fetch(path, init);
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
      return body;
    }

    function setStatusBadges(snap) {
      const eng = snap.engine;
      const status = $("badge-status");
      status.textContent = eng.running ? "running" : "stopped";
      status.className = "badge " + (eng.running ? "badge-running" : "badge-stopped");

      const mode = $("badge-mode");
      mode.textContent = eng.dryRun ? "dry-run" : "live";
      mode.className = "badge " + (eng.dryRun ? "badge-dry" : "badge-live");

      const skip = $("badge-skip");
      if (eng.skipBuybacks) {
        skip.style.display = "";
        skip.textContent = "no buybacks";
        skip.className = "badge badge-warn-soft";
      } else {
        skip.style.display = "none";
      }

      const manual = $("badge-manual");
      manual.style.display = eng.config.claimManualOnly ? "" : "none";

      const noBucket = $("badge-nobucket");
      const tBps = eng.config.treasuryBps || 0;
      const bBps = (typeof eng.config.bucketBps === "number")
        ? eng.config.bucketBps
        : (eng.config.bucketEnabled ? (10000 - tBps) : 0);
      const cBps = 10000 - tBps - bBps;
      if (cBps > 0) {
        noBucket.style.display = "";
        noBucket.textContent = (cBps / 100) + "% stays in creator";
      } else {
        noBucket.style.display = "none";
      }

      const flight = $("badge-flight");
      flight.textContent = eng.inFlight ? "in tick" : "idle";
      flight.className = "badge " + (eng.inFlight ? "badge-busy" : "badge-idle");

      $("updated").textContent =
        "updated " + fmtTs(snap.serverMs) + " · last tick " + fmtAgo(eng.lastTickAtMs);
    }

    function setPool(snap) {
      const dl = $("pool-dl");
      const p = snap.engine.pool;
      if (!p) {
        dl.innerHTML = '<dt>state</dt><dd class="muted">resolving…</dd>';
        return;
      }
      const modelLabel = p.claimModel === "sharing-config"
        ? '<span class="badge badge-warn-soft">sharing-config</span>'
        : p.claimModel === "legacy-amm"
        ? '<span class="badge badge-idle">legacy-amm</span>'
        : '<span class="badge badge-idle">unknown</span>';
      dl.innerHTML =
        '<dt>pool</dt><dd class="mono-trunc">' + p.poolId + copyBtn(p.poolId) + '</dd>' +
        '<dt>base mint</dt><dd class="mono-trunc">' + p.baseMint + copyBtn(p.baseMint) + '</dd>' +
        '<dt>base dec</dt><dd>' + p.baseDecimals + '</dd>' +
        '<dt>coin_creator</dt><dd class="mono-trunc">' + p.coinCreator + copyBtn(p.coinCreator) + '</dd>' +
        '<dt>claim path</dt><dd>' + modelLabel + '</dd>';
    }

    function copyBtn(text) {
      return ' <button class="copy-btn" data-copy="' + text + '" title="copy">⧉</button>';
    }

    function setDip(snap) {
      const d = snap.engine.dip;
      const fmtSol = (v) => "◎" + Number(v).toFixed(10);
      $("dip-current").textContent = d.current === null ? "—" : fmtSol(d.current);
      $("dip-high").textContent = d.high === null ? "—" : fmtSol(d.high);
      $("dip-drawdown").textContent = fmtPct(d.drawdownPct);
      const src = d.lastSource || "—";
      $("dip-meta").textContent =
        d.samples + " samples · SOL/token · src " + src + " · window " +
        Math.round(d.windowSec / 60) + "m · poll " + Math.round(snap.engine.pollIntervalMs / 1000) + "s";

      drawSpark($("dip-spark"), d.series);
    }

    function drawSpark(canvas, series) {
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!series || series.length < 2) {
        ctx.fillStyle = "#6e7681";
        ctx.font = "12px ui-monospace,Menlo";
        ctx.fillText("not enough samples", 8, h / 2 + 4);
        return;
      }
      let lo = Infinity, hi = -Infinity;
      for (const s of series) { if (s.priceUsd < lo) lo = s.priceUsd; if (s.priceUsd > hi) hi = s.priceUsd; }
      if (hi === lo) { hi = lo + 1; lo = lo - 1; }
      const t0 = series[0].ts, t1 = series[series.length - 1].ts;
      const xRange = Math.max(1, t1 - t0);

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#58a6ff";
      ctx.fillStyle = "rgba(88,166,255,0.12)";

      const path = new Path2D();
      const fill = new Path2D();
      fill.moveTo(0, h);
      for (let i = 0; i < series.length; i++) {
        const s = series[i];
        const x = ((s.ts - t0) / xRange) * w;
        const y = h - ((s.priceUsd - lo) / (hi - lo)) * (h - 8) - 4;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        fill.lineTo(x, y);
      }
      fill.lineTo(w, h);
      fill.closePath();
      ctx.fill(fill);
      ctx.stroke(path);
    }

    function setWallets(snap) {
      const w = snap.engine.wallets;
      const b = snap.onChain.balances;
      const tbody = $("wallets-tbl").querySelector("tbody");
      const rows = [
        ["creator (hot)",     w.creator,        b.creatorLamports],
        ["buyback hot",       w.buybackHot,     b.buybackHotLamports],
        ["treasury (cold)",   w.treasury,       b.treasuryLamports],
        ["mining (cold)",     w.miningTreasury, b.miningTreasuryLamports],
      ];
      tbody.innerHTML = rows.map(([role, pk, lam]) => {
        return '<tr>' +
          '<td class="role">' + role + '</td>' +
          '<td><span class="pk" title="' + pk + '">' + truncPk(pk) + '</span>' + copyBtn(pk) + '</td>' +
          '<td class="bal">' + fmtSol(lam) + '</td>' +
        '</tr>';
      }).join("");
    }

    function setOnChain(snap) {
      const oc = snap.onChain;
      const cfg = snap.engine.config;
      const claimMode = cfg.claimManualOnly ? "manual only (button)" : "auto";
      const _tBps = cfg.treasuryBps || 0;
      const _bBps = (typeof cfg.bucketBps === "number")
        ? cfg.bucketBps
        : (cfg.bucketEnabled ? (10000 - _tBps) : 0);
      const _cBps = 10000 - _tBps - _bBps;
      const splitMode = (_tBps / 100) + "% treasury / " +
        (_bBps / 100) + "% bucket / " +
        (_cBps / 100) + "% stays in creator";
      const dl = $("onchain-dl");
      // Sharing-config pools accumulate fees in two places: the pump_amm
      // WSOL ATA (where every swap deposits its share) and the bonding-curve
      // creator_vault PDA (what distribute_creator_fees reads). Pump.fun's
      // own UI shows the SUM. Surface the breakdown so the operator can
      // verify it matches what they see on pump.fun.
      const breakdownLine = oc.unclaimedBreakdown
        ? '<dt class="muted">&nbsp;&nbsp;↳ pump_amm</dt><dd class="muted">' +
            fmtSol(oc.unclaimedBreakdown.pumpAmmLamports) + '</dd>' +
          '<dt class="muted">&nbsp;&nbsp;↳ bonding vault</dt><dd class="muted">' +
            fmtSol(oc.unclaimedBreakdown.bondingLamports) + '</dd>'
        : '';
      dl.innerHTML =
        '<dt>unclaimed (total)</dt><dd>' + fmtSol(oc.unclaimedVaultLamports) + '</dd>' +
        breakdownLine +
        '<dt>RPC probe</dt><dd>' + (oc.probeMs === null ? "—" : oc.probeMs + " ms") + '</dd>' +
        '<dt>last on-chain probe</dt><dd>' + fmtAgo(oc.asOfMs) + '</dd>' +
        '<dt>last claim attempt</dt><dd>' + fmtAgo(snap.engine.lastClaimAttemptAtMs) + '</dd>' +
        '<dt>claim mode</dt><dd>' + claimMode + '</dd>' +
        '<dt>split routing</dt><dd>' + splitMode + '</dd>' +
        '<dt>claim threshold</dt><dd>' + fmtSol(cfg.claimThresholdLamports) + '</dd>' +
        '<dt>claim interval</dt><dd>' + Math.round(cfg.claimIntervalMs / 60000) + ' min</dd>';
    }

    function setTiers(snap) {
      const host = $("tiers");
      host.innerHTML = snap.engine.tiers.map((t) => {
        const cls = t.eligible ? "eligible" : (t.drawdownMet ? "met" : "");
        const cdPct = t.cooldownMs > 0
          ? Math.round((1 - t.cooldownRemainingMs / t.cooldownMs) * 100)
          : 100;
        return '<div class="tier ' + cls + '">' +
          '<div class="head"><span class="dd">-' + (t.drawdownPct * 100).toFixed(1) + '%</span>' +
          '<span class="sol">' + t.trancheSol + ' SOL</span></div>' +
          '<div class="meta"><span>cooldown ' + Math.round(t.cooldownMs / 60000) + 'm</span>' +
          '<span>' + (t.eligible ? "eligible" : (t.drawdownMet ? "cooldown " + fmtDur(t.cooldownRemainingMs) : "waiting")) + '</span></div>' +
          '<div class="bar"><span style="width:' + Math.max(2, cdPct) + '%"></span></div>' +
        '</div>';
      }).join("");
    }

    function setRecent(snap) {
      const claims = snap.recent.claims;
      const splits = snap.recent.splits;
      const buys = snap.recent.buybacks;
      const solscan = (sig) => '<a href="https://solscan.io/tx/' + sig + '" target="_blank" rel="noreferrer">' + truncSig(sig) + '</a>';

      $("claims-tbl").querySelector("tbody").innerHTML = claims.map((c) =>
        '<tr><td class="mono">' + fmtTs(c.ts) + '</td>' +
        '<td class="num">' + fmtSol(c.claimedLamports) + '</td>' +
        '<td>' + solscan(c.signature) + '</td></tr>'
      ).join("") || '<tr><td colspan="3" class="muted">no claims yet</td></tr>';

      $("splits-tbl").querySelector("tbody").innerHTML = splits.map((s) =>
        '<tr><td class="mono">' + fmtTs(s.ts) + '</td>' +
        '<td class="num">' + fmtSol(s.treasuryLamports) + '</td>' +
        '<td class="num">' + fmtSol(s.bucketLamports) + '</td>' +
        '<td>' + solscan(s.signature) + '</td></tr>'
      ).join("") || '<tr><td colspan="4" class="muted">no splits yet</td></tr>';

      $("buybacks-tbl").querySelector("tbody").innerHTML = buys.map((b) =>
        '<tr class="' + (b.live ? "" : "dry") + '">' +
        '<td class="mono">' + fmtTs(b.ts) + '</td>' +
        '<td>#' + b.tier + '</td>' +
        '<td>' + (b.drawdownPct * 100).toFixed(1) + '%</td>' +
        '<td class="num">' + fmtSol(b.lamportsIn) + '</td>' +
        '<td>' + (b.live ? solscan(b.swapSignature) : '<span class="muted mono">' + truncSig(b.swapSignature) + '</span>') + '</td></tr>'
      ).join("") || '<tr><td colspan="5" class="muted">no buybacks yet</td></tr>';
    }

    function showMsg(text, kind) {
      const el = $("ctrl-msg");
      el.textContent = text;
      el.className = "msg " + (kind || "");
      if (text) setTimeout(() => { if (el.textContent === text) { el.textContent = ""; el.className = "msg"; } }, 3500);
    }

    let dryToggleBusy = false;
    $("ctrl-dry").addEventListener("change", async (e) => {
      if (dryToggleBusy) return;
      dryToggleBusy = true;
      const value = e.target.checked;
      try {
        await api("/api/control/dryrun", { method: "POST", body: JSON.stringify({ value }) });
        showMsg("dry-run = " + value, "ok");
        await refresh();
      } catch (err) {
        showMsg("toggle failed: " + err.message, "err");
        e.target.checked = !value;
      } finally {
        dryToggleBusy = false;
      }
    });

    $("ctrl-tick").addEventListener("click", async () => {
      try { await api("/api/control/tick", { method: "POST" }); showMsg("tick requested", "ok"); }
      catch (err) { showMsg("tick failed: " + err.message, "err"); }
    });

    $("ctrl-tor-check").addEventListener("click", async () => {
      const pill = $("tor-result");
      const btn = $("ctrl-tor-check");
      btn.disabled = true;
      pill.style.display = "inline-block";
      pill.className = "tor-pill tor-pending";
      pill.textContent = "checking…";
      try {
        const r = await api("/api/diag/proxy");
        if (!r.torConfigured) {
          pill.className = "tor-pill tor-warn";
          pill.textContent = "Tor NOT configured · direct IP " + r.directIp;
          showMsg("TOR_PROXY env is unset; engine traffic goes direct", "err");
        } else if (r.tunneled) {
          pill.className = "tor-pill tor-ok";
          pill.textContent = "Tor active · proxied " + r.proxiedIp + " ≠ direct " + r.directIp;
          showMsg("Tor verified: traffic egresses via " + r.proxiedIp, "ok");
        } else {
          pill.className = "tor-pill tor-bad";
          pill.textContent = "TOR FAIL · proxied " + r.proxiedIp + " | direct " + r.directIp;
          showMsg("Tor configured but NOT in path: " + r.message, "err");
        }
      } catch (err) {
        pill.className = "tor-pill tor-bad";
        pill.textContent = "diag error";
        showMsg("Tor check failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
      }
    });

    $("ctrl-claim").addEventListener("click", async () => {
      if (!confirm("Reset claim cooldown? The next tick will re-evaluate the on-chain creator vault.")) return;
      try { await api("/api/control/claim", { method: "POST" }); showMsg("claim cooldown reset", "ok"); }
      catch (err) { showMsg("force claim failed: " + err.message, "err"); }
    });

    $("ctrl-claim-live").addEventListener("click", async () => {
      // Use the live snapshot to render a model-aware confirm dialog. Falls
      // back to a generic message if pool isn't resolved yet.
      const lastSnap = window.__LAST_SNAP__ || {};
      const model = lastSnap?.engine?.pool?.claimModel;
      const msg = model === "sharing-config"
        ? "This signs and sends a REAL pump:distribute_creator_fees transaction NOW.\\n\\n" +
          "It bypasses dry-run, the cooldown, and the threshold. The instruction is permissionless — " +
          "the bonding-curve program splits the creator vault across all sharing-config recipients " +
          "atomically. The configured creator wallet receives only its bps share (see Pool card).\\n\\n" +
          "Proceed?"
        : model === "legacy-amm"
        ? "This signs and sends a REAL pump_amm:collect_coin_creator_fee transaction NOW.\\n\\n" +
          "It bypasses dry-run, the cooldown, and the threshold. The vault wallet " +
          "labelled 'creator-1' MUST be the on-chain coin_creator or the tx will fail.\\n\\n" +
          "Proceed?"
        : "Pool model unknown (engine still resolving?). Proceed with claim attempt?";
      if (!confirm(msg)) return;
      const btn = $("ctrl-claim-live");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "claiming…";
      try {
        const r = await api("/api/control/claim-live", { method: "POST" });
        if (r.ok) {
          const sol = r.claimedLamports ? (Number(r.claimedLamports) / SOL).toFixed(6) : "?";
          showMsg("claim landed · +" + sol + " SOL · " + (r.signature || "").slice(0, 12) + "…", "ok");
          await refresh();
        } else {
          showMsg("claim failed: " + (r.error || "unknown"), "err");
        }
      } catch (err) {
        showMsg("claim failed: " + err.message, "err");
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    let skipToggleBusy = false;
    $("ctrl-skip").addEventListener("change", async (e) => {
      if (skipToggleBusy) return;
      skipToggleBusy = true;
      const value = e.target.checked;
      try {
        await api("/api/control/skip-buybacks", { method: "POST", body: JSON.stringify({ value }) });
        showMsg("skipBuybacks = " + value, "ok");
        await refresh();
      } catch (err) {
        showMsg("toggle failed: " + err.message, "err");
        e.target.checked = !value;
      } finally {
        skipToggleBusy = false;
      }
    });

    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-copy]");
      if (!t) return;
      const text = t.getAttribute("data-copy");
      navigator.clipboard.writeText(text).then(() => {
        const orig = t.textContent;
        t.textContent = "✓";
        setTimeout(() => { t.textContent = orig; }, 800);
      });
    });

    // -- vault management --------------------------------------------------

    async function loadWallets() {
      try {
        const j = await api("/api/vault/wallets");
        const tbody = $("vault-tbl").querySelector("tbody");
        if (!j.wallets || !j.wallets.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="muted">vault is empty</td></tr>';
        } else {
          tbody.innerHTML = j.wallets.map((w) => {
            const tags = (w.tags || []).map((t) => '<span class="tag-pill">' + t + '</span>').join("");
            return '<tr>' +
              '<td class="mono">' + w.label + '</td>' +
              '<td><span class="pk" title="' + w.pubkey + '">' + truncPk(w.pubkey) + '</span>' + copyBtn(w.pubkey) + '</td>' +
              '<td>' + (tags || '<span class="muted small">—</span>') + '</td>' +
              '<td><button class="btn-danger" data-remove="' + w.label + '">remove</button></td>' +
            '</tr>';
          }).join("");
        }
        // Repopulate the transfer-form's source dropdown. Preserve the user's
        // current selection so opening the wallets refresh interval mid-edit
        // doesn't surprise them.
        const sel = $("transfer-from");
        if (sel) {
          const prev = sel.value;
          const opts = (j.wallets || [])
            .map((w) => '<option value="' + w.label + '">' + w.label + ' (' + truncPk(w.pubkey) + ')</option>')
            .join("");
          sel.innerHTML = '<option value="" disabled selected>— pick a wallet —</option>' + opts;
          if (prev) {
            const restored = Array.from(sel.options).find((o) => o.value === prev);
            if (restored) sel.value = prev;
          }
        }
      } catch (err) {
        $("vault-tbl").querySelector("tbody").innerHTML =
          '<tr><td colspan="4" class="msg err">failed to load: ' + err.message + '</td></tr>';
      }
    }

    document.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-remove]");
      if (!t) return;
      const label = t.getAttribute("data-remove");
      if (!confirm("Remove wallet '" + label + "' from the vault? This cannot be undone unless you have the secret key elsewhere.")) return;
      try {
        await api("/api/vault/remove", { method: "POST", body: JSON.stringify({ label }) });
        await loadWallets();
        await refresh();
      } catch (err) {
        alert("remove failed: " + err.message);
      }
    });

    function setMsg(id, text, kind) {
      const el = $(id);
      // Accept inline HTML (only the OK path uses this for the Solscan link;
      // err paths only ever pass server-supplied error strings, which we
      // funnel through textContent below by wrapping in a text node).
      if (kind === "ok" && /<a /.test(text)) {
        el.innerHTML = text;
      } else {
        el.textContent = text;
      }
      el.className = "msg " + (kind || "");
      const snapshot = el.innerHTML;
      if (text) setTimeout(() => { if (el.innerHTML === snapshot) { el.textContent = ""; el.className = "msg"; } }, 6000);
    }

    function readForm(form) {
      const data = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === "checkbox") data[el.name] = el.checked;
        else data[el.name] = el.value;
      }
      return data;
    }

    $("vault-import-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readForm(e.target);
      try {
        const r = await api("/api/vault/import", { method: "POST", body: JSON.stringify(data) });
        setMsg("vault-import-msg", "imported '" + r.label + "' → " + truncPk(r.pubkey), "ok");
        e.target.reset();
        await loadWallets();
        await refresh();
      } catch (err) {
        setMsg("vault-import-msg", "import failed: " + err.message, "err");
      }
    });

    $("vault-import-json-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readForm(e.target);
      let kp;
      try { kp = JSON.parse(data.keypair); } catch (parseErr) {
        setMsg("vault-import-json-msg", "not valid JSON: " + parseErr.message, "err"); return;
      }
      data.keypair = kp;
      try {
        const r = await api("/api/vault/import-keypair-file", { method: "POST", body: JSON.stringify(data) });
        setMsg("vault-import-json-msg", "imported '" + r.label + "' → " + truncPk(r.pubkey), "ok");
        e.target.reset();
        await loadWallets();
        await refresh();
      } catch (err) {
        setMsg("vault-import-json-msg", "import failed: " + err.message, "err");
      }
    });

    $("vault-generate-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readForm(e.target);
      try {
        const r = await api("/api/vault/generate", { method: "POST", body: JSON.stringify(data) });
        const labels = (r.created || []).map((c) => c.label + " (" + truncPk(c.pubkey) + ")").join(", ");
        setMsg("vault-generate-msg", "generated: " + labels, "ok");
        e.target.reset();
        e.target.elements.prefix.value = "wallet";
        await loadWallets();
        await refresh();
      } catch (err) {
        setMsg("vault-generate-msg", "generate failed: " + err.message, "err");
      }
    });

    // Disable the SOL amount input while sweepAll is checked so users don't
    // think the typed amount matters in sweep mode.
    $("transfer-sweep").addEventListener("change", (e) => {
      const sweep = e.target.checked;
      const solInput = document.querySelector('#vault-transfer-form input[name="sol"]');
      solInput.disabled = sweep;
      solInput.placeholder = sweep ? "(ignored: sweeping all)" : "0.5";
    });

    $("vault-transfer-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readForm(e.target);
      // Native [required] handles missing label/pubkey/confirm. Belt-and-
      // braces guard for amount-or-sweep:
      if (!data.sweepAll && (!data.sol || Number(data.sol) <= 0)) {
        setMsg("vault-transfer-msg", "amount (SOL) is required unless 'sweep all' is checked", "err");
        return;
      }
      const fromLabel = data.from;
      const sweepDesc = data.sweepAll
        ? "ALL SOL (minus reserve " + (Number(data.reserveLamports) / 1e9).toFixed(6) + " SOL)"
        : data.sol + " SOL";
      if (!confirm("Send " + sweepDesc + " from '" + fromLabel + "' to '" + data.to + "'?\\n\\nThis is a LIVE transfer. There is no undo.")) {
        return;
      }
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "sending…";
      try {
        const r = await api("/api/vault/transfer-sol", { method: "POST", body: JSON.stringify(data) });
        const sigShort = (r.signature || "").slice(0, 12);
        const link = '<a href="https://solscan.io/tx/' + r.signature + '" target="_blank" rel="noreferrer">' + sigShort + '…</a>';
        setMsg("vault-transfer-msg", "sent " + r.sol + " SOL · " + link, "ok");
        // Reset everything except the source dropdown so the user can do another.
        e.target.elements.to.value = "";
        e.target.elements.sol.value = "";
        e.target.elements.sweepAll.checked = false;
        e.target.elements.sol.disabled = false;
        e.target.elements.sol.placeholder = "0.5";
        e.target.elements.confirm.checked = false;
        await refresh();
      } catch (err) {
        setMsg("vault-transfer-msg", "transfer failed: " + err.message, "err");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "send";
      }
    });

    async function refresh() {
      try {
        const snap = await api("/api/snapshot");
        // Stash for any handler that needs to inspect engine state at click
        // time (e.g. claim-live confirm dialog needs claimModel).
        window.__LAST_SNAP__ = snap;
        setStatusBadges(snap);
        setPool(snap);
        setDip(snap);
        setWallets(snap);
        setOnChain(snap);
        setTiers(snap);
        setRecent(snap);
        if (!dryToggleBusy) $("ctrl-dry").checked = snap.engine.dryRun;
        if (!skipToggleBusy) $("ctrl-skip").checked = snap.engine.skipBuybacks;
      } catch (err) {
        $("updated").textContent = "fetch failed: " + err.message;
      }
    }

    // -- manual buyback form ----------------------------------------------
    $("buyback-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = readForm(e.target);
      const sol = Number(data.sol);
      if (!Number.isFinite(sol) || sol <= 0) {
        setMsg("buyback-msg", "amount must be a positive number", "err");
        return;
      }
      const desc =
        sol + " SOL → token " +
        (data.sweepAfter ? "(then sweep to mining)" : "(no sweep)") +
        (data.liveDespiteDryRun ? " · FORCED LIVE" : " · honors engine dry-run");
      if (!confirm("Manual buyback test:\\n  " + desc + "\\n\\nProceed?")) return;

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "swapping…";
      try {
        const payload = {
          sol: sol,
          slippageBps: data.slippageBps ? Number(data.slippageBps) : undefined,
          sweepAfter: Boolean(data.sweepAfter),
          liveDespiteDryRun: Boolean(data.liveDespiteDryRun),
          confirm: true,
        };
        const r = await api("/api/control/buyback-live", { method: "POST", body: JSON.stringify(payload) });
        if (r.dryRun) {
          setMsg("buyback-msg", "DRY RUN: would swap " + sol + " SOL on " + r.venue + " (slip " + r.slippageBps + " bps)", "ok");
        } else {
          const sigShort = (r.swapSignature || "").slice(0, 12);
          const link = '<a href="https://solscan.io/tx/' + r.swapSignature + '" target="_blank" rel="noreferrer">' + sigShort + '…</a>';
          let msg = "swap landed · " + link + " · tokens out: " + (r.baseTokensOut || "0");
          if (r.sweepSignature) {
            const sweepShort = r.sweepSignature.slice(0, 12);
            const sweepLink = '<a href="https://solscan.io/tx/' + r.sweepSignature + '" target="_blank" rel="noreferrer">' + sweepShort + '…</a>';
            msg += " · sweep: " + sweepLink;
          }
          setMsg("buyback-msg", msg, "ok");
        }
        e.target.elements.confirm.checked = false;
        await refresh();
      } catch (err) {
        setMsg("buyback-msg", "buyback failed: " + err.message, "err");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Buyback NOW";
      }
    });

    // -- LOGS panel ---------------------------------------------------------
    // Polls /api/logs every 2s and appends new entries to the scroll pane.
    // Keeps a client-side cap of LOG_VIEW_MAX entries to avoid unbounded DOM
    // growth when the engine has been chatty for hours. Auto-scroll respects
    // user intent: if you've scrolled away from the bottom, new entries don't
    // yank you back unless you re-tick the auto-scroll checkbox.
    const LOG_POLL_MS = 2000;
    const LOG_VIEW_MAX = 800;
    let logCursor = 0;
    const logPane = $("logs-pane");
    const logLevelSel = $("logs-level");
    const logFilterIn = $("logs-filter");
    const logPauseChk = $("logs-pause");
    const logScrollChk = $("logs-autoscroll");
    const logMeta = $("logs-meta");

    function levelLabel(n) {
      if (n >= 60) return "fatal";
      if (n >= 50) return "error";
      if (n >= 40) return "warn ";
      if (n >= 30) return "info ";
      if (n >= 20) return "debug";
      return "trace";
    }
    function levelClass(n) {
      if (n >= 50) return "log-error";
      if (n >= 40) return "log-warn";
      if (n >= 30) return "log-info";
      return "log-debug";
    }
    function fmtLogTs(ms) {
      const d = new Date(ms);
      const pad = (n, w) => String(n).padStart(w || 2, "0");
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3);
    }
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    function fmtFields(f) {
      if (!f || typeof f !== "object") return "";
      try {
        const compact = JSON.stringify(f, (_k, v) => typeof v === "bigint" ? v.toString() : v);
        if (!compact || compact === "{}") return "";
        return " " + compact;
      } catch {
        return "";
      }
    }
    function entryMatchesFilter(e, filter) {
      if (!filter) return true;
      const hay = ((e.mod || "") + " " + (e.msg || "") + " " + (e.fields ? JSON.stringify(e.fields) : "")).toLowerCase();
      return hay.includes(filter);
    }
    function renderEntry(e) {
      const cls = levelClass(e.level);
      const lvl = levelLabel(e.level);
      const mod = e.mod ? "[" + e.mod + "] " : "";
      const fields = fmtFields(e.fields);
      const html =
        '<span class="log-row ' + cls + '">' +
          '<span class="ts">' + fmtLogTs(e.time) + '</span> ' +
          '<span class="lvl">' + lvl + '</span> ' +
          '<span class="mod">' + escapeHtml(mod) + '</span>' +
          '<span class="msg">' + escapeHtml(e.msg || "") + '</span>' +
          '<span class="fields">' + escapeHtml(fields) + '</span>' +
        '</span>';
      return html;
    }

    async function pollLogs() {
      if (logPauseChk.checked) return;
      let resp;
      try {
        resp = await api("/api/logs?since=" + logCursor + "&limit=200");
      } catch (err) {
        logMeta.textContent = "fetch failed: " + err.message;
        return;
      }
      const minLevel = Number(logLevelSel.value) || 30;
      const filter = (logFilterIn.value || "").trim().toLowerCase();
      const incoming = (resp.entries || []).filter((e) => e.level >= minLevel && entryMatchesFilter(e, filter));
      if (incoming.length) {
        // Detect "is the user pinned to the bottom" BEFORE we mutate the DOM.
        const nearBottom = (logPane.scrollHeight - logPane.scrollTop - logPane.clientHeight) < 24;
        const html = incoming.map(renderEntry).join("");
        // Append. If the empty placeholder is showing, clear it first.
        if (logPane.firstElementChild && logPane.firstElementChild.classList.contains("logs-empty")) {
          logPane.innerHTML = "";
        }
        logPane.insertAdjacentHTML("beforeend", html);
        // Trim to max so we don't drag old entries forever.
        const rows = logPane.children;
        if (rows.length > LOG_VIEW_MAX) {
          for (let i = 0, n = rows.length - LOG_VIEW_MAX; i < n; i++) rows[0].remove();
        }
        if (logScrollChk.checked && nearBottom) {
          logPane.scrollTop = logPane.scrollHeight;
        }
      }
      logCursor = resp.tip || logCursor;
      logMeta.textContent = "buffer " + (resp.size || 0) + " · view " + logPane.children.length + (logPauseChk.checked ? " (paused)" : "");
    }

    // Re-render existing entries when the level filter changes — easier to
    // wipe and re-fetch from the start than maintain a parallel store.
    function resetLogView() {
      logCursor = 0;
      logPane.innerHTML = '<span class="logs-empty">loading…</span>';
    }
    logLevelSel.addEventListener("change", () => { resetLogView(); pollLogs(); });
    logFilterIn.addEventListener("input", () => { resetLogView(); pollLogs(); });
    $("logs-clear").addEventListener("click", () => {
      logPane.innerHTML = '<span class="logs-empty">cleared (engine buffer is unaffected; new entries will appear)</span>';
      // Don't reset logCursor — we want to keep the buffer position so the
      // next poll only shows truly NEW entries, not rehydrate the cleared
      // history.
    });

    refresh();
    loadWallets();
    resetLogView();
    pollLogs();
    setInterval(refresh, POLL_MS);
    setInterval(pollLogs, LOG_POLL_MS);
    // Reload the vault list less often than the snapshot (it doesn't change unless
    // the user mutates it through this UI).
    setInterval(loadWallets, 30000);
  })();
`;
