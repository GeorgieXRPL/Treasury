import http from 'node:http';
import type { AddressInfo } from 'node:net';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import type { RpcManager, TxExecutor, Vault } from '@amm/core';
import { fetchTextDirect, fetchTextThroughProxy } from '@amm/core';
import { LAMPORTS_PER_SOL, createLogger, logBuffer } from '@amm/shared';
import type { BuybackEngine } from '../engine/buyback-engine.js';
import type { SnapshotBuilder } from './snapshot.js';
import { renderIndexHtml } from './ui.js';

const log = createLogger('treasury:web');

export interface WebServerOptions {
  host: string;
  port: number;
  /** Optional shared secret for control endpoints. Read endpoints stay open. */
  token?: string;
  /** When true, all mutating endpoints return 403. */
  readOnly: boolean;
}

export interface WebServerDeps {
  engine: BuybackEngine;
  snapshots: SnapshotBuilder;
  /**
   * Already-unlocked treasury vault. The web server uses it for in-process
   * vault management (list/import/generate/remove) so the user doesn't have
   * to drop into the AMM CLI for routine wallet edits. Writes are gated by
   * the same token + readOnly checks as engine controls.
   */
  vault: Vault;
  /** Used by the SOL-sweep endpoint to read balances + sign+send transfers. */
  rpc: RpcManager;
  exec: TxExecutor;
}

/**
 * Tiny stdlib HTTP server (no fastify, no express) bolted onto the engine.
 *
 * Routes:
 *   GET  /                       single-page UI (vanilla JS, no build step)
 *   GET  /api/snapshot           full state: engine + on-chain + recent rows
 *   GET  /api/health             { ok: true }
 *   POST /api/control/dryrun     body: { value: boolean } -> set dry-run
 *   POST /api/control/tick       wake the loop now
 *   POST /api/control/claim      reset claim cooldown + wake loop
 *
 * Security model:
 *   - Bind 127.0.0.1 by default (cfg.web.host). Never exposes a port externally.
 *   - Optional `cfg.web.token` (or TREASURY_WEB_TOKEN env) gates the mutating
 *     endpoints. Read endpoints stay open since they only return public data.
 *   - For VPS deploy, leave host=127.0.0.1 and reach the dashboard via
 *     `ssh -L 4318:127.0.0.1:4318 user@vps`. See ROTATION.md.
 */
export class TreasuryWebServer {
  private server: http.Server | null = null;
  private readonly indexHtml: string;
  private readonly engine: BuybackEngine;
  private readonly snapshots: SnapshotBuilder;
  private readonly vault: Vault;
  private readonly rpc: RpcManager;
  private readonly exec: TxExecutor;

  constructor(deps: WebServerDeps, private readonly opts: WebServerOptions) {
    this.engine = deps.engine;
    this.snapshots = deps.snapshots;
    this.vault = deps.vault;
    this.rpc = deps.rpc;
    this.exec = deps.exec;
    this.indexHtml = renderIndexHtml({ token: opts.token });
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address() as AddressInfo;
    log.info(
      {
        url: `http://${this.opts.host}:${addr.port}/`,
        readOnly: this.opts.readOnly,
        tokenProtected: Boolean(this.opts.token),
      },
      'web UI listening',
    );
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
    log.info('web UI stopped');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${this.opts.host}`);
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return sendHtml(res, 200, this.indexHtml);
      }
      if (method === 'GET' && path === '/api/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/snapshot') {
        const snap = await this.snapshots.build();
        return sendJson(res, 200, snap);
      }

      if (method === 'GET' && path === '/api/logs') {
        // Polled by the dashboard's LOGS panel. `since` is an epoch-ms cursor
        // returned by the previous response; the first call passes 0 and gets
        // the most recent `limit` entries. Returns the new tip so the client
        // can advance.
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200));
        const { entries, tip } = logBuffer.recent(limit, since);
        return sendJson(res, 200, { entries, tip, size: logBuffer.size() });
      }

      if (method === 'GET' && path === '/api/diag/proxy') {
        // Compares egress IP through the configured TOR_PROXY (the "proxied"
        // path that every RPC / Jupiter / Jito request takes) against a
        // freshly-built direct dispatcher. If the two IPs match, Tor is NOT
        // in path even when TOR_PROXY is set — usually because Tor Browser
        // isn't running on the configured port. Surfaces both IPs to the UI
        // so the user can confirm with a click before flipping dryRun off.
        const torEnv = process.env.TOR_PROXY?.trim() ?? '';
        // ipify returns the bare IP as text/plain. Hardcoded so this can't
        // be silently neutered by a misconfigured custom URL.
        const url = 'https://api.ipify.org';
        const [proxied, direct] = await Promise.all([
          fetchTextThroughProxy(url).then((s) => s.trim()).catch((e) => `error: ${(e as Error).message.slice(0, 200)}`),
          fetchTextDirect(url).then((s) => s.trim()).catch((e) => `error: ${(e as Error).message.slice(0, 200)}`),
        ]);
        const proxiedOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(proxied);
        const directOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(direct);
        const tunneled = proxiedOk && directOk && proxied !== direct;
        return sendJson(res, 200, {
          torEnv: torEnv || null,
          torConfigured: torEnv.length > 0,
          proxiedIp: proxied,
          directIp: direct,
          tunneled,
          message: !torEnv
            ? 'TOR_PROXY is unset; both calls go direct'
            : tunneled
            ? 'Tor is in path: proxied egress IP differs from direct'
            : proxiedOk && directOk
            ? 'TOR_PROXY is set but egress IPs MATCH — Tor is NOT in path. Is Tor Browser running on the configured port?'
            : 'one or both probes failed; check error strings above',
        });
      }

      if (method === 'GET' && path === '/api/vault/wallets') {
        return sendJson(res, 200, { wallets: this.listWallets() });
      }

      if (method === 'POST' && path.startsWith('/api/vault/')) {
        if (this.opts.readOnly) {
          return sendJson(res, 403, { error: 'web is read-only (cfg.web.readOnly = true)' });
        }
        if (!this.checkToken(req, url)) {
          return sendJson(res, 401, { error: 'missing or invalid token' });
        }
        const body = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
        try {
          switch (path) {
            case '/api/vault/import':
              return sendJson(res, 200, await this.handleImport(body));
            case '/api/vault/import-keypair-file':
              return sendJson(res, 200, await this.handleImportKeypairArray(body));
            case '/api/vault/generate':
              return sendJson(res, 200, await this.handleGenerate(body));
            case '/api/vault/remove':
              return sendJson(res, 200, await this.handleRemove(body));
            case '/api/vault/transfer-sol':
              return sendJson(res, 200, await this.handleTransferSol(body));
            default:
              return sendJson(res, 404, { error: 'unknown vault endpoint' });
          }
        } catch (e) {
          // VaultError messages are short and safe to surface; everything else
          // gets truncated to avoid leaking long stack traces.
          return sendJson(res, 400, { error: (e as Error).message.slice(0, 300) });
        }
      }

      if (method === 'POST' && path.startsWith('/api/control/')) {
        if (this.opts.readOnly) {
          return sendJson(res, 403, { error: 'web is read-only (cfg.web.readOnly = true)' });
        }
        if (!this.checkToken(req, url)) {
          return sendJson(res, 401, { error: 'missing or invalid token' });
        }
        const body = await readJson(req).catch(() => ({}));
        switch (path) {
          case '/api/control/dryrun': {
            const value = Boolean((body as { value?: unknown }).value);
            this.engine.setDryRun(value);
            return sendJson(res, 200, { ok: true, dryRun: value });
          }
          case '/api/control/skip-buybacks': {
            const value = Boolean((body as { value?: unknown }).value);
            this.engine.setSkipBuybacks(value);
            return sendJson(res, 200, { ok: true, skipBuybacks: value });
          }
          case '/api/control/tick': {
            this.engine.triggerTickSoon();
            return sendJson(res, 200, { ok: true });
          }
          case '/api/control/claim': {
            this.engine.forceClaimNow();
            return sendJson(res, 200, { ok: true });
          }
          case '/api/control/claim-live': {
            const r = await this.engine.forceLiveClaim();
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          case '/api/control/buyback-live': {
            const b = body as {
              sol?: unknown;
              lamports?: unknown;
              slippageBps?: unknown;
              sweepAfter?: unknown;
              liveDespiteDryRun?: unknown;
              confirm?: unknown;
            };
            if (!b.confirm) {
              return sendJson(res, 400, { ok: false, error: 'confirm=true is required' });
            }
            let lamports: number;
            if (typeof b.lamports === 'number') lamports = Math.floor(b.lamports);
            else if (typeof b.sol === 'number' || (typeof b.sol === 'string' && b.sol.length)) {
              const sol = Number(b.sol);
              if (!Number.isFinite(sol) || sol <= 0) {
                return sendJson(res, 400, { ok: false, error: 'sol must be a positive number' });
              }
              lamports = Math.floor(sol * 1_000_000_000);
            } else {
              return sendJson(res, 400, { ok: false, error: 'provide sol or lamports' });
            }
            const slippageBps =
              typeof b.slippageBps === 'number' && Number.isFinite(b.slippageBps)
                ? Math.floor(b.slippageBps)
                : undefined;
            const r = await this.engine.forceBuyback({
              lamports,
              slippageBps,
              sweepAfter: Boolean(b.sweepAfter),
              liveDespiteDryRun: Boolean(b.liveDespiteDryRun),
            });
            return sendJson(res, r.ok ? 200 : 400, r);
          }
          default:
            return sendJson(res, 404, { error: 'unknown control endpoint' });
        }
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      log.error({ err: (e as Error).message.slice(0, 800) }, 'request crashed');
      try {
        sendJson(res, 500, { error: (e as Error).message.slice(0, 200) });
      } catch {
        // best-effort
      }
    }
  }

  private checkToken(req: http.IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true;
    const headerVal = req.headers['x-treasury-token'];
    const headerToken = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const queryToken = url.searchParams.get('token');
    return headerToken === this.opts.token || queryToken === this.opts.token;
  }

  // -- vault helpers ----------------------------------------------------

  /**
   * Project the vault contents into a JSON-safe shape. **Never** includes the
   * secret key — only label, pubkey, tags, createdAt. Uses the existing
   * `getKeypair` to derive the pubkey so we don't have to import bs58 just
   * for the projection.
   */
  private listWallets(): Array<{ label: string; pubkey: string; tags: string[]; createdAt: number }> {
    return this.vault.list().map((w) => {
      const kp = this.vault.getKeypair(w.label);
      return {
        label: w.label,
        pubkey: kp ? kp.publicKey.toBase58() : '',
        tags: [...w.tags],
        createdAt: w.createdAt,
      };
    });
  }

  private parseTags(input: unknown): string[] {
    if (Array.isArray(input)) return input.map((t) => String(t).trim()).filter(Boolean);
    if (typeof input === 'string')
      return input
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    return [];
  }

  private async handleImport(body: Record<string, unknown>): Promise<unknown> {
    const label = String(body.label ?? '').trim();
    let secret = String(body.secretBase58 ?? body.secret ?? '').trim();
    const tags = this.parseTags(body.tags);
    const replace = Boolean(body.replace);
    if (!label) throw new Error('label is required');
    if (!secret) throw new Error('secretBase58 is required');

    if (replace && this.vault.get(label)) {
      await this.vault.remove(label);
    }
    try {
      // Validate before storing so the user gets a clear error rather than a
      // mysterious "label exists" later. importFromBase58 also validates, but
      // we want the failure to happen before any partial state.
      Keypair.fromSecretKey(bs58.decode(secret));
    } catch {
      // Wipe the malformed secret from our local before throwing so it isn't
      // captured in any retained closure / stack frame.
      secret = '';
      throw new Error('invalid base58 secret key');
    }
    await this.vault.importFromBase58(label, secret, tags);
    secret = ''; // proactively clear the in-memory copy
    const w = this.vault.get(label);
    const kp = this.vault.getKeypair(label);
    log.info({ label, tags }, 'wallet imported via web');
    return {
      ok: true,
      label,
      pubkey: kp ? kp.publicKey.toBase58() : '',
      tags: w ? [...w.tags] : tags,
    };
  }

  private async handleImportKeypairArray(body: Record<string, unknown>): Promise<unknown> {
    const label = String(body.label ?? '').trim();
    const arrIn = body.keypair;
    const tags = this.parseTags(body.tags);
    const replace = Boolean(body.replace);
    if (!label) throw new Error('label is required');
    if (!Array.isArray(arrIn) || arrIn.length !== 64)
      throw new Error('keypair must be a 64-element number array (Solana CLI keypair format)');
    const bytes = Uint8Array.from(arrIn.map((n) => Number(n)));

    if (replace && this.vault.get(label)) {
      await this.vault.remove(label);
    }
    await this.vault.importFromSecretKey(label, bytes, tags);
    const kp = this.vault.getKeypair(label);
    log.info({ label, tags }, 'wallet imported (keypair JSON) via web');
    return { ok: true, label, pubkey: kp ? kp.publicKey.toBase58() : '', tags };
  }

  private async handleGenerate(body: Record<string, unknown>): Promise<unknown> {
    const prefix = String(body.prefix ?? 'wallet').trim() || 'wallet';
    const tags = this.parseTags(body.tags);
    const count = Math.max(1, Math.min(10, Number(body.count ?? 1) || 1));
    const labels = await this.vault.generate(count, prefix, tags);
    const created = labels.map((label) => {
      const kp = this.vault.getKeypair(label);
      return { label, pubkey: kp ? kp.publicKey.toBase58() : '', tags };
    });
    log.info({ prefix, tags, count }, 'wallets generated via web');
    return { ok: true, created };
  }

  private async handleRemove(body: Record<string, unknown>): Promise<unknown> {
    const label = String(body.label ?? '').trim();
    if (!label) throw new Error('label is required');
    await this.vault.remove(label);
    log.info({ label }, 'wallet removed via web');
    return { ok: true, label };
  }

  /**
   * Move SOL from one vault wallet to any destination. Source MUST be a vault
   * label (we need its secret key); destination may be a vault label OR a
   * raw base58 pubkey.
   *
   * Requires `confirm: true` in the body — a deliberate "yes I really mean
   * to send live funds" handshake that the dashboard form supplies via a
   * required checkbox. Without it the endpoint refuses to send.
   *
   * Amount: either explicit `lamports` (or `sol`) OR `sweepAll: true`. When
   * sweeping, we leave `reserveLamports` (default 1_000_000 = 0.001 SOL) in
   * the source to cover the next tx fee + rent floor.
   *
   * The endpoint is intentionally NOT gated by the engine's dry-run flag —
   * the engine flag controls the auto-loop; this is a manual one-off
   * action that has its own per-call confirmation.
   */
  private async handleTransferSol(body: Record<string, unknown>): Promise<unknown> {
    const fromLabel = String(body.from ?? '').trim();
    const toRaw = String(body.to ?? '').trim();
    const confirm = Boolean(body.confirm);
    const sweepAll = Boolean(body.sweepAll);
    const reserveLamports = Math.max(
      0,
      Math.floor(Number(body.reserveLamports ?? 1_000_000)),
    );
    if (!fromLabel) throw new Error('from (vault label) is required');
    if (!toRaw) throw new Error('to (vault label or pubkey) is required');
    if (!confirm) {
      throw new Error('confirm=true is required to send a real transfer');
    }

    const fromKp = this.vault.getKeypair(fromLabel);
    if (!fromKp) throw new Error(`vault has no wallet labelled '${fromLabel}'`);
    if (fromLabel === toRaw) throw new Error('from and to are the same wallet');

    let toPubkey: PublicKey;
    try {
      toPubkey = new PublicKey(toRaw);
    } catch {
      const kp = this.vault.getKeypair(toRaw);
      if (!kp) throw new Error(`'${toRaw}' is not a valid pubkey or known vault label`);
      toPubkey = kp.publicKey;
    }
    if (toPubkey.equals(fromKp.publicKey)) {
      throw new Error('from and to resolve to the same pubkey');
    }

    const fromBalance = await this.rpc.getBalance(fromKp.publicKey);

    let lamports: number;
    if (sweepAll) {
      lamports = fromBalance - reserveLamports;
      if (lamports <= 0) {
        throw new Error(
          `sweep refused: balance ${fromBalance} is at or below reserve ${reserveLamports}`,
        );
      }
    } else if (typeof body.lamports === 'number') {
      lamports = Math.floor(Number(body.lamports));
    } else if (body.sol !== undefined && body.sol !== null && body.sol !== '') {
      const sol = Number(body.sol);
      if (!Number.isFinite(sol) || sol <= 0) throw new Error('sol must be a positive number');
      lamports = Math.floor(sol * LAMPORTS_PER_SOL);
    } else {
      throw new Error('provide one of: sweepAll=true, lamports, or sol');
    }

    if (lamports <= 0) throw new Error('lamports must be > 0');
    if (lamports + 5_000 > fromBalance) {
      throw new Error(
        `insufficient: requested ${lamports} + 5000 fee > balance ${fromBalance} (lamports)`,
      );
    }

    const ix = SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey,
      lamports,
    });

    log.info(
      {
        from: fromKp.publicKey.toBase58(),
        fromLabel,
        to: toPubkey.toBase58(),
        lamports,
        sol: (lamports / LAMPORTS_PER_SOL).toFixed(9),
        sweepAll,
      },
      'manual SOL transfer initiated',
    );

    const result = await this.exec.execute(
      fromKp,
      [ix],
      // Bookkeeping op — pin tiny CU + 0 priority. skipPreflight false so a
      // bad blockhash / overdraft surfaces clearly without burning fees.
      { computeUnitLimit: 1_500, priorityMicroLamports: 0, skipPreflight: false, maxRetries: 2 },
    );

    log.info(
      { sig: result.signature.slice(0, 12), from: fromLabel, to: toPubkey.toBase58().slice(0, 8), lamports },
      'manual SOL transfer landed',
    );

    return {
      ok: true,
      signature: result.signature,
      from: fromKp.publicKey.toBase58(),
      to: toPubkey.toBase58(),
      lamports,
      sol: (lamports / LAMPORTS_PER_SOL).toFixed(9),
    };
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 64 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as unknown;
}
