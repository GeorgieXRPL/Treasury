// One-shot helper to seed an empty treasury vault with placeholder
// `creator-1` and `buyback-1` keypairs so the engine can boot. Operator is
// expected to immediately replace both via the dashboard's Wallets panel
// (use the "replace existing label if present" checkbox).
import { Keypair } from '@solana/web3.js';
import { Vault, defaultVaultPath } from '@amm/core';

const passphrase = process.env.TREASURY_VAULT_PASSPHRASE;
const vaultPath = process.env.TREASURY_VAULT_PATH ?? defaultVaultPath();
if (!passphrase) {
  console.error('TREASURY_VAULT_PASSPHRASE env var is required.');
  process.exit(1);
}

const vault = new Vault(vaultPath);
await vault.unlock(passphrase);

const ensure = async (label: string, tag: string) => {
  if (vault.get(label)) {
    console.log(`  ${label}: already present, leaving as-is`);
    return;
  }
  const kp = Keypair.generate();
  await vault.importFromSecretKey(label, kp.secretKey, [tag, 'placeholder']);
  console.log(`  ${label}: ${kp.publicKey.toBase58()}  (PLACEHOLDER \u2014 replace immediately)`);
};

console.log(`vault: ${vaultPath}`);
await ensure('creator-1', 'creator');
await ensure('buyback-1', 'buyback');
await ensure('treasury-1', 'treasury');
await ensure('mining-cold-1', 'mining');

console.log('\ndone. labels in vault:');
for (const w of vault.list()) console.log(`  ${w.label.padEnd(20)} ${w.publicKey} [${w.tags.join(', ')}]`);

console.log('\nNEXT STEPS (do this BEFORE sending any funds):');
console.log('  1. Open http://127.0.0.1:4319');
console.log('  2. Go to the Wallets card.');
console.log('  3. For BOTH creator-1 and buyback-1: paste your real base58 secret,');
console.log('     tick "replace existing label if present", click Import.');
console.log('  4. Verify the dashboard shows the right pubkeys before unpausing.');
