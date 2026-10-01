#!/usr/bin/env node
// Regenerates docs/canvas.png: opens the shipped workflow in a real n8n editor and
// screenshots the canvas. Dev-only; nothing in the project depends on it.
//
// Needs Node 24+, an n8n install (N8N_BIN) and Playwright with a Chromium browser
// (set PLAYWRIGHT_MODULE to its index.mjs if it is not resolvable as "playwright").
//   N8N_BIN=.n8n-e2e/node_modules/.bin/n8n node scripts/canvas-screenshot.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const n8nBin = process.env.N8N_BIN || path.join(root, '.n8n-e2e/node_modules/.bin/n8n');
if (!existsSync(n8nBin)) {
  console.error('Set N8N_BIN to an n8n executable (see e2e/README.md).');
  process.exit(2);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = 15679;
const base = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'triage-canvas-'));

// Same workflow file, with credentials pointed at throwaway entries so the canvas shows no warnings.
const wf = JSON.parse(readFileSync(path.join(root, 'workflow/email-triage.workflow.json'), 'utf8'));
wf.id = 'emailTriageCanvas';
const creds = [
  ['gmailOAuth2', 'Gmail account'], ['googleSheetsOAuth2Api', 'Google Sheets account'],
  ['slackApi', 'Slack bot token'], ['httpHeaderAuth', 'Anthropic API key'],
].map(([type, name]) => ({ id: `c-${type}`, name, type, data: type === 'slackApi' ? { accessToken: 'x' } : type === 'httpHeaderAuth' ? { name: 'x-api-key', value: 'x' } : { clientId: 'x', clientSecret: 'x', oauthTokenData: { access_token: 'x', token_type: 'Bearer' } } }));
for (const n of wf.nodes) for (const t of Object.keys(n.credentials || {})) n.credentials[t].id = `c-${t}`;
writeFileSync(path.join(work, 'workflow.json'), JSON.stringify(wf));
writeFileSync(path.join(work, 'credentials.json'), JSON.stringify(creds));

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))),
  N8N_USER_FOLDER: path.join(work, 'home'), N8N_ENCRYPTION_KEY: 'canvas-key', N8N_PORT: String(PORT), N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false', N8N_HIRING_BANNER_ENABLED: 'false', N8N_SECURE_COOKIE: 'false',
};
const cli = (args) => execFileSync(process.execPath, [n8nBin, ...args], { env, stdio: 'pipe' });
cli(['import:credentials', `--input=${path.join(work, 'credentials.json')}`]);
cli(['import:workflow', `--input=${path.join(work, 'workflow.json')}`]);

const proc = spawn(process.execPath, [n8nBin, 'start'], { env, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await sleep(1000);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 640 }, deviceScaleFactor: 2 });
  const owner = { email: 'demo@example.com', firstName: 'Demo', lastName: 'User', password: 'Demo-pass-1234' };
  // /healthz answers before every route is registered, so retry until the setup route exists.
  let res;
  for (let i = 0; i < 90; i++) {
    res = await context.request.post(`${base}/rest/owner/setup`, { data: owner });
    if (res.status() !== 404) break;
    await sleep(1000);
  }
  if (!res.ok()) throw new Error(`owner setup failed: ${res.status()} ${await res.text()}`);
  const page = await context.newPage();
  await page.goto(`${base}/workflow/emailTriageCanvas`);
  await page.waitForSelector('.vue-flow__node', { timeout: 60000 });
  await sleep(1500);
  await page.keyboard.press('Escape');
  await page.keyboard.press('1'); // zoom to fit
  await sleep(1500);
  const out = path.join(root, 'docs/canvas.png');
  await page.screenshot({ path: out });
  console.log('wrote', out);
} finally {
  await browser?.close();
  proc.kill('SIGTERM');
  await sleep(1000);
  rmSync(work, { recursive: true, force: true });
}
