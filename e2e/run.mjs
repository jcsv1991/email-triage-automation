#!/usr/bin/env node
// End-to-end test: runs the shipped workflow file inside a REAL n8n instance.
//
//   Gmail Trigger -> ... -> Claude -> ... -> Sheets / Gmail labels + drafts / Slack
//
// Everything n8n talks to (Gmail, Sheets, Google OAuth, Slack, Anthropic) is answered by
// local fakes (e2e/fakes/servers.mjs), reached by redirecting n8n's outgoing connections,
// so the workflow file itself runs unmodified. Only the credential ids are swapped.
//
// Needs: Node >= 24 and n8n installed (see e2e/README.md). Run:  npm run e2e
//   --phase1-only        skip the second polling round (about 2 minutes shorter)
//   --workflow=<file>    test a different workflow file (used for mutation checks)
//   --n8n=<path>         n8n executable (or set N8N_BIN)
//   --keep               keep the temp folder and n8n log
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { startFakes, REDIRECT_HOSTS, TEST_ANTHROPIC_KEY, TEST_GOOGLE_TOKEN, TEST_SLACK_TOKEN } from './fakes/servers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const workflowPath = path.resolve(opt('workflow') || path.join(root, 'workflow/email-triage.workflow.json'));
const phase1Only = flag('phase1-only');
const FAKE_PORT = 18443;
const N8N_PORT = 15678;

// ------------------------------------------------------------------ report helpers
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✖ ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
};
const section = (t) => console.log(`\n${t}`);
const log = (m) => console.log(`[e2e] ${m}`);

async function waitFor(what, predicate, timeoutMs, everyMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(everyMs);
  }
  log(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${what}`);
  return false;
}

// ------------------------------------------------------------------ locate n8n
function locateN8n() {
  const candidates = [opt('n8n'), process.env.N8N_BIN, path.join(root, 'node_modules/.bin/n8n'), path.join(root, '.n8n-e2e/node_modules/.bin/n8n')].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return realpathSync(c);
  try {
    const found = execFileSync('which', ['n8n'], { encoding: 'utf8' }).trim();
    if (found) return realpathSync(found);
  } catch { /* not on PATH */ }
  console.error('n8n not found. Install it somewhere and point N8N_BIN at it, for example:\n  npm install --prefix .n8n-e2e n8n@2.41.4\n  N8N_BIN=.n8n-e2e/node_modules/.bin/n8n npm run e2e');
  process.exit(2);
}

// ------------------------------------------------------------------ main
const n8nBin = locateN8n();
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`n8n 2.x needs Node 24 or newer; this is Node ${process.versions.node}.`);
  process.exit(2);
}

const work = mkdtempSync(path.join(os.tmpdir(), 'triage-e2e-'));
const keep = flag('keep');
log(`work dir: ${work}`);

// 1. throwaway CA + server certificate for the fakes
const sanList = REDIRECT_HOSTS.map((h) => `DNS:${h}`).join(',');
writeFileSync(path.join(work, 'ext.cnf'), `subjectAltName=${sanList}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
const ossl = (args) => execFileSync('openssl', args, { cwd: work, stdio: 'pipe' });
ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Triage E2E Test CA']);
ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=triage-e2e-fakes']);
ossl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'ext.cnf']);

// 2. fakes + test emails
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const schema = JSON.parse(read('schema/triage_email.tool.json'));
const systemPrompt = read('prompts/system-prompt.txt').trim();
const triageByAddress = JSON.parse(read('e2e/fixtures/mock-triage.json'));

const fakes = await startFakes({
  port: FAKE_PORT,
  key: path.join(work, 'server.key'),
  cert: path.join(work, 'server.pem'),
  expected: { systemPrompt, schema },
  triageByAddress,
  missingLabels: ['Triage/other'], // lets us check graceful handling of a label that does not exist yet
});
const { state } = fakes;

const emailFiles = [
  ...readdirSync(path.join(root, 'samples/emails')).filter((f) => f.endsWith('.eml')).map((f) => path.join(root, 'samples/emails', f)),
  ...readdirSync(path.join(root, 'e2e/fixtures')).filter((f) => f.endsWith('.eml')).map((f) => path.join(root, 'e2e/fixtures', f)),
].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const emails = {};
for (const f of emailFiles) {
  const n = path.basename(f).slice(0, 2);
  const parsed = await simpleParser(readFileSync(f));
  emails[n] = { n, file: f, id: `msg-${n}`, thread: `thr-${n}`, from: parsed.from.value[0].address, subject: parsed.subject, rfcId: parsed.messageId };
  await fakes.addMessage({ id: `msg-${n}`, threadId: `thr-${n}`, emlPath: f });
}
const phase1 = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
const validOnes = ['01', '02', '03', '04', '05', '06', '07', '08'];
const urgentOnes = ['01', '04'];

// 3. workflow copy: identical except credential ids
const original = JSON.parse(readFileSync(workflowPath, 'utf8'));
const credFor = { gmailOAuth2: 'e2eGmail', googleSheetsOAuth2Api: 'e2eSheets', slackApi: 'e2eSlack', httpHeaderAuth: 'e2eAnthropic' };
const underTest = JSON.parse(JSON.stringify(original));
underTest.id = 'emailTriageE2E';
for (const node of underTest.nodes) {
  for (const type of Object.keys(node.credentials || {})) node.credentials[type].id = credFor[type];
}
writeFileSync(path.join(work, 'workflow.json'), JSON.stringify(underTest));

const googleData = { clientId: 'e2e-client', clientSecret: 'e2e-secret', oauthTokenData: { access_token: TEST_GOOGLE_TOKEN, token_type: 'Bearer', refresh_token: 'e2e-refresh' } };
writeFileSync(path.join(work, 'credentials.json'), JSON.stringify([
  { id: 'e2eGmail', name: 'Gmail account', type: 'gmailOAuth2', data: googleData },
  { id: 'e2eSheets', name: 'Google Sheets account', type: 'googleSheetsOAuth2Api', data: googleData },
  { id: 'e2eSlack', name: 'Slack bot token', type: 'slackApi', data: { accessToken: TEST_SLACK_TOKEN } },
  { id: 'e2eAnthropic', name: 'Anthropic API key', type: 'httpHeaderAuth', data: { name: 'x-api-key', value: TEST_ANTHROPIC_KEY } },
]));

// 4. n8n
// n8n must connect straight to the fakes, so remove every proxy setting inherited from the shell.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))),
  N8N_USER_FOLDER: path.join(work, 'n8n-home'),
  N8N_ENCRYPTION_KEY: 'e2e-test-encryption-key',
  N8N_PORT: String(N8N_PORT),
  N8N_LISTEN_ADDRESS: '127.0.0.1',
  N8N_DIAGNOSTICS_ENABLED: 'false',
  N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
  N8N_TEMPLATES_ENABLED: 'false',
  N8N_PERSONALIZATION_ENABLED: 'false',
  N8N_HIRING_BANNER_ENABLED: 'false',
  GENERIC_TIMEZONE: 'UTC',
  NODE_EXTRA_CA_CERTS: path.join(work, 'ca.pem'),
  NODE_OPTIONS: `--require=${path.join(root, 'e2e/fakes/redirect.cjs')}`,
  E2E_REDIRECT_HOSTS: REDIRECT_HOSTS.join(','),
  E2E_FAKE_PORT: String(FAKE_PORT),
};
const n8n = (args) => execFileSync(process.execPath, [n8nBin, ...args], { env, stdio: 'pipe', encoding: 'utf8' });

let n8nProc;
let exitCode = 1;
const logPath = path.join(work, 'n8n.log');
try {
  log('importing credentials and workflow into n8n');
  n8n(['import:credentials', `--input=${path.join(work, 'credentials.json')}`]);
  n8n(['import:workflow', `--input=${path.join(work, 'workflow.json')}`]);
  n8n(['publish:workflow', '--id=emailTriageE2E']);

  log('starting n8n');
  const out = createWriteStream(logPath);
  n8nProc = spawn(process.execPath, [n8nBin, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  n8nProc.stdout.pipe(out);
  n8nProc.stderr.pipe(out);
  let n8nExited = false;
  n8nProc.on('exit', () => (n8nExited = true));

  const healthy = await waitFor('n8n /healthz', async () => {
    if (n8nExited) throw new Error('n8n exited early, see ' + logPath);
    try {
      return (await fetch(`http://127.0.0.1:${N8N_PORT}/healthz`)).ok;
    } catch { return false; }
  }, 120000, 1000);
  assert.ok(healthy, 'n8n did not become healthy');
  log('n8n is up; waiting for the workflow to go live (first Gmail poll)');
  await waitFor('activation poll', () => state.gmail.listCalls >= 1, 30000, 250);
  log(`workflow live (Gmail polled ${state.gmail.listCalls}x). Delivering ${phase1.length} emails to the inbox`);

  // ---------------------------------------------------------------- phase 1
  fakes.release(phase1.map((n) => emails[n].id));
  const t0 = Date.now();
  const minAnthropic = 8 + 1 + 1; // 8 good, 1 bad answer, at least one attempt for the overloaded one
  const done1 = await waitFor('phase 1 to finish', () =>
    state.anthropic.requests.length >= minAnthropic && state.gmail.drafts.length >= 8 && state.slack.posts.length >= 4 && state.sheets.rows.length >= 9 && state.gmail.modifies.length >= 8,
  170000, 1000);
  log(`phase 1 ${done1 ? 'finished' : 'did NOT finish'} after ${Math.round((Date.now() - t0) / 1000)}s`);
  await sleep(6000); // let any stray extra calls show up before counting

  const draftFor = (n) => state.gmail.drafts.find((d) => d.threadId === emails[n].thread);
  const rowFor = (n) => state.sheets.rows.slice(1).find((r) => r[1] === emails[n].from);
  const postsWith = (s) => state.slack.posts.filter((p) => p.text.includes(s));
  const sentTo = (n) => state.anthropic.requests.filter((r) => r.sender === emails[n].from);

  section('Gmail: drafts, labels, and no sending');
  await check('nothing is ever sent: no send/insert/import call reached Gmail', () => {
    const bad = state.all.filter((r) => /gmail/.test(r.path) && (/\/(send|insert|import)$/.test(r.path) || /\/drafts\/[^/]+\/send/.test(r.path)));
    assert.deepEqual(bad, []);
    assert.ok(state.all.some((r) => r.path === '/gmail/v1/users/me/drafts' && r.method === 'POST'), 'expected draft creation calls');
  });
  await check('exactly one draft per valid email (8), none for the two failures', () => {
    assert.equal(state.gmail.drafts.length, 8);
    assert.deepEqual(state.gmail.drafts.map((d) => d.threadId).sort(), validOnes.map((n) => emails[n].thread));
  });
  await check('each draft is addressed to the sender, on the original thread, with the suggested reply as its body', () => {
    for (const n of validOnes) {
      const d = draftFor(n);
      assert.ok(d, `no draft for ${n}`);
      assert.deepEqual(d.to, [emails[n].from], `draft ${n} recipient`);
      assert.equal(d.subject, /^re:/i.test(emails[n].subject) ? emails[n].subject : `Re: ${emails[n].subject}`, `draft ${n} subject`);
      assert.equal(d.inReplyTo, emails[n].rfcId, `draft ${n} In-Reply-To`);
      assert.equal(d.text, triageByAddress[emails[n].from].suggested_reply.trimEnd(), `draft ${n} body`);
    }
  });
  await check('each valid email gets the label matching its category; a missing label is skipped without breaking the rest', () => {
    const want = { '01': 'Label_billing', '02': 'Label_technical', '03': 'Label_general', '04': 'Label_technical', '05': 'Label_general', '06': 'Label_technical', '07': 'Label_technical' };
    for (const [n, id] of Object.entries(want)) {
      const m = state.gmail.modifies.find((x) => x.messageId === emails[n].id);
      assert.deepEqual(m?.addLabelIds, [id], `label for ${n}`);
    }
    const other = state.gmail.modifies.find((x) => x.messageId === emails['08'].id);
    assert.deepEqual(other?.addLabelIds, [], 'email 08 (category other, label missing in this account) is asked for no label');
    assert.equal(state.gmail.modifies.length, 8);
    assert.ok(!state.gmail.modifies.some((x) => [emails['09'].id, emails['10'].id].includes(x.messageId)), 'failed emails must not be labelled');
    assert.ok(state.gmail.drafts.length === 8 && draftFor('08'), 'the missing label must not stop email 08 getting its draft');
  });
  await check('the account label list is fetched once for the whole batch, not once per email', () => {
    assert.equal(state.all.filter((r) => r.path === '/gmail/v1/users/me/labels').length, 1);
  });

  section('Google Sheets: the log');
  await check('one row per valid email with the right values, none for the failures', () => {
    assert.deepEqual(state.sheets.rows[0], ['Received', 'From', 'Subject', 'Category', 'Urgency', 'Summary', 'Flags', 'Thread ID']);
    assert.equal(state.sheets.rows.length, 9);
    for (const n of validOnes) {
      const r = rowFor(n);
      const t = triageByAddress[emails[n].from];
      assert.ok(r, `no row for ${n}`);
      assert.match(r[0], /^\d{4}-\d\d-\d\dT/, `row ${n} timestamp`);
      assert.equal(r[2], emails[n].subject, `row ${n} subject`);
      assert.equal(r[3], t.category, `row ${n} category`);
      assert.equal(r[4], t.urgency, `row ${n} urgency`);
      assert.equal(r[5], t.summary, `row ${n} summary`);
      assert.equal(r[7], emails[n].thread, `row ${n} thread`);
    }
    assert.ok(!state.sheets.rows.some((r) => /example\.test/.test(r[1])), 'failed emails must not be logged');
  });
  await check('prompt-injection attempts are flagged in the log (hidden and visible)', () => {
    assert.match(rowFor('05')[6], /hidden:ignore_instructions/);
    assert.match(rowFor('05')[6], /unicode_tag_characters/);
    assert.match(rowFor('06')[6], /ignore_instructions/);
    for (const n of ['01', '02', '03', '04', '07', '08']) assert.equal(rowFor(n)[6], '', `row ${n} should have no flags`);
  });

  section('Slack: alerts');
  await check('exactly the two high-urgency emails raise an urgent alert, each linking to its own draft and thread', () => {
    const urgent = state.slack.posts.filter((p) => p.text.includes(':red_circle:'));
    assert.equal(urgent.length, 2);
    for (const n of urgentOnes) {
      const d = draftFor(n);
      const p = urgent.find((x) => x.text.includes(emails[n].subject));
      assert.ok(p, `no urgent alert for ${n}`);
      assert.ok(p.text.includes(`#drafts?compose=${d.messageId}|Open the draft in Gmail`), `alert ${n} must link to draft ${d.messageId}\n${p.text}`);
      assert.ok(p.text.includes(`#all/${emails[n].thread}|Open the thread`), `alert ${n} thread link`);
      assert.ok(p.text.includes(`*Category:* ${triageByAddress[emails[n].from].category}`));
    }
  });
  await check('both failures (invalid answer, overloaded API) raise a manual-review alert with the reason', () => {
    const review = state.slack.posts.filter((p) => p.text.includes(':warning:'));
    assert.equal(review.length, 2);
    const bad = review.find((p) => p.text.includes(emails['09'].subject));
    const over = review.find((p) => p.text.includes(emails['10'].subject));
    assert.match(bad.text, /bad_enum: category="refunds"/);
    assert.match(over.text, /api_error: .*529/);
    assert.ok(bad.text.includes(`#all/${emails['09'].thread}`) && over.text.includes(`#all/${emails['10'].thread}`));
  });
  await check('nothing else is posted, to the configured channel, with the bot token', () => {
    assert.equal(state.slack.posts.length, 4);
    for (const p of state.slack.posts) {
      assert.equal(p.channel, '#support-alerts');
      assert.equal(p.authorization, `Bearer ${TEST_SLACK_TOKEN}`);
    }
  });
  await check('every character from an email that Slack treats as markup is escaped', () => {
    for (const p of state.slack.posts) {
      const without = p.text.replace(/<https:\/\/mail\.google\.com\/[^>|]+\|[^>]+>/g, '');
      assert.ok(!/[<>]/.test(without), `unescaped markup in: ${p.text}`);
    }
  });

  section('Claude API calls');
  await check('every request has the right headers, forced tool call, schema, system prompt and a clean <email> block', () => {
    assert.deepEqual(state.anthropic.shapeProblems, []);
    assert.ok(state.anthropic.requests.every((r) => r.model === 'claude-haiku-4-5-20251001'));
  });
  await check('one call per healthy email; the overloaded one was tried and escalated to a human, not dropped', () => {
    for (const n of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) assert.equal(sentTo(n).length, 1, `calls for ${n}`);
    // n8n only retries when the FIRST item of a batch fails (see README), so 1..3 attempts are all legitimate here.
    assert.ok(sentTo('10').length >= 1 && sentTo('10').length <= 3, `attempts for 10: ${sentTo('10').length}`);
  });
  await check('what Claude is sent is clean: no HTML, quoted history, signatures, footers or hidden text', () => {
    for (const r of state.anthropic.requests) assert.ok(!/<(?:div|p|br|img|span|html|style|table)\b|style=|&nbsp;/i.test(r.content.replace(/<\/?(?:email|from|subject|body)>/g, '')), `HTML leaked for ${r.sender}`);
    const c = (n) => sentTo(n)[0].content;
    assert.ok(c('01').includes('charged $49.00 twice') && !c('01').includes('iPhone'));
    assert.ok(c('02').includes('Token expired') && !/Dana|555 0142|CONFIDENTIALITY|fresh reset link/.test(c('02')));
    assert.ok(c('04').includes('CHECKOUT HAS BEEN DOWN') && !/preview text|unsubscribe|open\.gif|environment/i.test(c('04')));
    assert.ok(c('05').includes('customize the invoice template'));
    assert.ok(!/ignore all previous|SYSTEM NOTICE|5,000|refund|system prompt|New instructions/i.test(c('05')), 'hidden injection reached the model');
    assert.ok(c('06').includes('Ignore previous instructions'), 'visible text is passed through (and flagged), not silently rewritten');
  });

  section('n8n itself');
  await check('every call to an outside service was one the fakes implement, with valid credentials', () => {
    assert.deepEqual(state.unhandled, []);
    assert.deepEqual(state.all.filter((r) => r.badAuth).map((r) => `${r.method} ${r.host}${r.path}`), []);
    for (const h of ['www.googleapis.com', 'sheets.googleapis.com', 'slack.com', 'api.anthropic.com']) assert.ok(state.all.some((r) => r.host === h), `no traffic to ${h}`);
  });

  // ---------------------------------------------------------------- phase 2
  if (!phase1Only) {
    section('Second poll: a flaky API call recovers on retry, and old mail is not reprocessed');
    const before = { anthropic: state.anthropic.requests.length, drafts: state.gmail.drafts.length, posts: state.slack.posts.length, rows: state.sheets.rows.length, lists: state.gmail.lists.length };
    // Arrives alone, so it is the first (and only) item in its batch: n8n's retry-on-fail applies to it.
    fakes.release([emails['11'].id]);
    const done2 = await waitFor('phase 2 to finish', () => state.gmail.drafts.length > before.drafts && state.slack.posts.length > before.posts, 150000, 1000);
    log(`phase 2 ${done2 ? 'finished' : 'did NOT finish'}`);
    await waitFor('two more idle polls', () => state.gmail.lists.length >= before.lists + 3, 150000, 1000);
    await sleep(3000);
    await check('a single transient 529 from Claude is retried and the email is then processed exactly once, end to end', () => {
      assert.equal(sentTo('11').length, 2, 'expected one failed attempt and one successful retry');
      assert.equal(state.anthropic.requests.length, before.anthropic + 2);
      assert.equal(state.gmail.drafts.length, before.drafts + 1);
      assert.equal(state.sheets.rows.length, before.rows + 1);
      const d = draftFor('11');
      assert.ok(d && d.to[0] === emails['11'].from, 'draft for the retried email');
      const mine = state.slack.posts.filter((x) => x.text.includes(emails['11'].subject));
      assert.equal(mine.length, 1, 'one Slack post for the retried email');
      assert.ok(mine[0].text.includes(':red_circle:') && !mine[0].text.includes(':warning:'), 'urgent alert, not a manual-review alert');
      assert.ok(mine[0].text.includes(`#drafts?compose=${d.messageId}`), 'alert links to its own draft');
    });
    await check('Gmail kept returning already-handled mail on later polls, and none of it was processed twice', () => {
      const handled = new Set(phase1.map((n) => emails[n].id));
      const relisted = state.gmail.lists.slice(before.lists).flatMap((l) => l.returned).filter((id) => handled.has(id));
      assert.ok(relisted.length > 0, 'the fake should have re-listed some earlier mail to exercise de-duplication');
      for (const n of validOnes) assert.equal(state.gmail.drafts.filter((d) => d.threadId === emails[n].thread).length, 1, `drafts for ${n}`);
      assert.equal(state.anthropic.requests.length, before.anthropic + 2, 'no extra Claude calls');
      assert.equal(state.slack.posts.length, before.posts + 1, 'no extra Slack posts');
    });
  }

  await check('n8n logged no errors', () => {
    // Workflow-level problems only. n8n's own background calls to api.n8n.io (blocked here by design,
    // because it is not one of the faked hosts) log TLS noise that says nothing about the workflow.
    const lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => /There was a problem in '|Workflow execution (failed|errored)|Problem in node|NodeApiError|NodeOperationError|Unhandled|uncaught/i.test(l));
    assert.deepEqual(lines, []);
  });
} catch (err) {
  console.error('\n[e2e] setup or run failed:', err.message);
  results.push({ name: 'run completed', ok: false, err });
} finally {
  if (n8nProc && !n8nProc.killed) {
    n8nProc.kill('SIGTERM');
    await sleep(1500);
    if (n8nProc.exitCode === null) n8nProc.kill('SIGKILL');
  }
  await fakes.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${phase1Only ? ' (phase 1 only)' : ''}`);
  if (failed.length) {
    console.log(`n8n log kept at ${logPath}`);
    if (existsSync(logPath)) console.log('--- last lines of n8n log ---\n' + readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n'));
    if (state.unhandled.length) console.log('--- requests the fakes did not handle ---\n' + state.unhandled.join('\n'));
  } else if (!keep) {
    rmSync(work, { recursive: true, force: true });
  }
  exitCode = failed.length ? 1 : 0;
}
process.exit(exitCode);
