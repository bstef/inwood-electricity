#!/usr/bin/env node
/**
 * scripts/set-secrets.js
 *
 * Reads secrets from .env.secrets (never committed) and pushes them
 * to Cloudflare Pages via wrangler CLI.
 *
 * Usage:
 *   node scripts/set-secrets.js
 *
 * .env.secrets format:
 *   GMAIL_CLIENT_ID=your-client-id
 *   GMAIL_CLIENT_SECRET=your-client-secret
 *   GMAIL_REFRESH_TOKEN=your-refresh-token
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const secretsFile = path.join(__dirname, '..', '.env.secrets');

if (!fs.existsSync(secretsFile)) {
  console.error('❌  .env.secrets not found. Create it first (see README.md).');
  process.exit(1);
}

const lines = fs.readFileSync(secretsFile, 'utf8').split('\n').filter(l => l.includes('='));

for (const line of lines) {
  const [key, ...rest] = line.split('=');
  const value = rest.join('=').trim();
  if (!key || !value) continue;

  console.log(`⏳  Setting secret: ${key.trim()}`);
  try {
    execSync(
      `echo "${value}" | npx wrangler pages secret put ${key.trim()} --project-name inwood-electricity`,
      { stdio: 'inherit' }
    );
    console.log(`✅  ${key.trim()} set.\n`);
  } catch (e) {
    console.error(`❌  Failed to set ${key.trim()}:`, e.message);
  }
}
