import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { workflow, nodeByName, runCodeNode, gmailTriggerItem, settingsValues } from './support/n8n-stub.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const schema = JSON.parse(read('schema/triage_email.tool.json'));
const systemPrompt = read('prompts/system-prompt.txt').trim();
const mockTriage = JSON.parse(read('e2e/fixtures/mock-triage.json'));
const samplesDir = new URL('../samples/emails/', import.meta.url);

describe('workflow file structure', () => {
  test('is in sync with the source files (run `npm run build` if this fails)', () => {
    const out = execFileSync(process.execPath, ['scripts/build-workflow.mjs', '--check'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.match(out, /up to date/);
  });

  test('node names and ids are unique, and every connection points at a real node', () => {
    const names = workflow.nodes.map((n) => n.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, names.length);
    for (const [from, outs] of Object.entries(workflow.connections)) {
      assert.ok(names.includes(from), `unknown source ${from}`);
      for (const branch of outs.main) for (const c of branch) assert.ok(names.includes(c.node), `unknown target ${c.node}`);
    }
  });

  test('has exactly one trigger and every non-note node is reachable from it', () => {
    const triggers = workflow.nodes.filter((n) => /Trigger$/.test(n.type));
    assert.equal(triggers.length, 1);
    const seen = new Set([triggers[0].name]);
    const queue = [triggers[0].name];
    while (queue.length) {
      const cur = queue.shift();
      for (const branch of workflow.connections[cur]?.main || []) {
        for (const c of branch) if (!seen.has(c.node)) { seen.add(c.node); queue.push(c.node); }
      }
    }
    for (const n of workflow.nodes.filter((x) => x.type !== 'n8n-nodes-base.stickyNote')) {
      assert.ok(seen.has(n.name), `${n.name} is unreachable`);
    }
  });

  test('it can never send an email: only label lookup, label add and draft create touch Gmail', () => {
    const gmail = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.gmail');
    const allowed = new Set(['label:getAll', 'message:addLabels', 'draft:create']);
    assert.ok(gmail.length >= 3);
    for (const n of gmail) assert.ok(allowed.has(`${n.parameters.resource}:${n.parameters.operation}`), `${n.name}: ${n.parameters.resource}:${n.parameters.operation}`);
    const banned = /emailSend|smtp|sendGrid|mailgun|postmark|gmailSend|outlook|imap/i;
    for (const n of workflow.nodes) assert.ok(!banned.test(n.type), `${n.name} (${n.type}) could send mail`);
    assert.ok(!/users\/me\/(messages|drafts)[^"']*send/i.test(JSON.stringify(workflow)));
  });

  test('contains no secrets: every credential is a placeholder', () => {
    const text = JSON.stringify(workflow);
    assert.ok(!/sk-ant-|xox[bpa]-|AIza[0-9A-Za-z_-]{20}|ya29\.|-----BEGIN/.test(text));
    for (const n of workflow.nodes) {
      for (const cred of Object.values(n.credentials || {})) assert.equal(cred.id, 'REPLACE_ME', n.name);
    }
  });

  test('every node that talks to an outside service declares the right credential', () => {
    const expected = {
      'n8n-nodes-base.gmailTrigger': 'gmailOAuth2',
      'n8n-nodes-base.gmail': 'gmailOAuth2',
      'n8n-nodes-base.googleSheets': 'googleSheetsOAuth2Api',
      'n8n-nodes-base.slack': 'slackApi',
      'n8n-nodes-base.httpRequest': 'httpHeaderAuth',
    };
    for (const n of workflow.nodes.filter((x) => expected[x.type])) {
      assert.deepEqual(Object.keys(n.credentials || {}), [expected[n.type]], n.name);
    }
  });

  test('Claude call: POST to the Messages API, retried, and failures flow on to validation', () => {
    const n = nodeByName('Claude: classify + draft');
    assert.equal(n.parameters.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(n.parameters.method, 'POST');
    assert.deepEqual(n.parameters.headerParameters.parameters, [{ name: 'anthropic-version', value: '2023-06-01' }]);
    assert.equal(n.retryOnFail, true);
    assert.equal(n.maxTries, 3);
    assert.equal(n.onError, 'continueRegularOutput');
  });

  test('a failed Claude step is routed to the manual-review alert, not to Gmail or the log', () => {
    const ifOut = workflow.connections['Schema valid?'].main;
    assert.equal(ifOut[0][0].node, 'Log to Google Sheets');
    assert.equal(ifOut[1][0].node, 'Format review alert');
    assert.deepEqual(workflow.connections['Format review alert'].main[0].map((c) => c.node), ['Slack: manual review alert']);
    assert.equal(workflow.connections['Slack: manual review alert'], undefined);
  });
});

describe('the code inside the Code nodes, run on the sample emails', () => {
  const files = readdirSync(samplesDir).filter((f) => f.endsWith('.eml')).sort();

  async function runPipeline(file, claudeResponder) {
    const item = { ...(await gmailTriggerItem(new URL(file, samplesDir).pathname, 'msg-' + file.slice(0, 2), 'thr-' + file.slice(0, 2))), ...settingsValues() };
    const ran = {};
    const sanitized = runCodeNode('Sanitize email', [item]);
    ran['Sanitize email'] = { all: [sanitized] };
    const built = runCodeNode('Build Claude request', sanitized, ran);
    ran['Build Claude request'] = { all: [built] };
    const response = claudeResponder(built[0].request);
    const validated = runCodeNode('Validate triage', [response], ran);
    ran['Validate triage'] = { all: [validated] };
    return { item, sanitized: sanitized[0], built: built[0], validated: validated[0], ran };
  }

  const canned = (request) => {
    const m = /<from>(?:.*&lt;(.+?)&gt;|(.+))<\/from>/.exec(request.messages[0].content);
    const sender = m[1] || m[2];
    return {
      type: 'message',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'triage_email', input: mockTriage[sender] }],
      usage: { input_tokens: 700, output_tokens: 150 },
    };
  };

  test('Sanitize email: maps Gmail Trigger fields to the clean record the rest of the workflow uses', async () => {
    const { sanitized } = await runPipeline('01-billing-double-charge.eml', canned);
    assert.equal(sanitized.id, 'msg-01');
    assert.equal(sanitized.threadId, 'thr-01');
    assert.equal(sanitized.from, 'marcus.webb@example.com');
    assert.equal(sanitized.fromName, 'Marcus Webb');
    assert.equal(sanitized.replyTo, 'marcus.webb@example.com');
    assert.equal(sanitized.subject, "Charged TWICE for my subscription - third time I'm writing");
    assert.equal(sanitized.settings.model, 'claude-haiku-4-5-20251001');
    assert.equal(sanitized.settings.labelPrefix, 'Triage/');
    assert.ok(sanitized.clean.userMessage.startsWith('<email>'));
    assert.ok(!('html' in sanitized) && !('text' in sanitized), 'the raw email body must not be carried downstream');
  });

  test('Build Claude request: forced tool call with the exact schema and system prompt from the repo files', async () => {
    const { built } = await runPipeline('02-technical-login-multipart.eml', canned);
    const r = built.request;
    assert.equal(r.model, 'claude-haiku-4-5-20251001');
    assert.equal(r.max_tokens, 1024);
    assert.equal(r.system, systemPrompt);
    assert.deepEqual(r.tools, [schema]);
    assert.deepEqual(r.tool_choice, { type: 'tool', name: 'triage_email' });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].role, 'user');
    assert.ok(r.messages[0].content.includes('Token expired'));
    assert.ok(!r.messages[0].content.includes('Dana'), 'quoted history must not be sent');
  });

  test('all eight samples go through sanitize, request, validate with canned answers', async () => {
    for (const f of files) {
      const { validated, sanitized } = await runPipeline(f, canned);
      assert.equal(validated.valid, true, `${f}: ${validated.errors}`);
      assert.deepEqual(validated.errors, []);
      assert.equal(validated.id, sanitized.id);
      assert.ok(!('request' in validated), 'the large request object is dropped after the API call');
      assert.deepEqual(validated.usage, { input_tokens: 700, output_tokens: 150 });
    }
  });

  test('hidden-injection sample: nothing from the hidden text is in the request, and the flag reaches the record', async () => {
    const { built, validated } = await runPipeline('05-injection-hidden-html.eml', canned);
    const sent = JSON.stringify(built.request.messages);
    assert.ok(!/ignore all previous|SYSTEM NOTICE|5,000|refund/i.test(sent));
    assert.ok(validated.clean.signals.includes('hidden:ignore_instructions'));
    assert.equal(validated.clean.suspicious, true);
  });

  test('Validate triage: a bad answer, an API error and a thrown HTTP error all become valid:false with reasons', async () => {
    const badEnum = (await runPipeline('01-billing-double-charge.eml', () => ({
      type: 'message', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'triage_email', input: { ...mockTriage['marcus.webb@example.com'], category: 'refunds' } }],
    }))).validated;
    assert.equal(badEnum.valid, false);
    assert.match(badEnum.errors[0], /^bad_enum: category/);
    assert.equal(badEnum.triage, null);
    assert.equal(badEnum.from, 'marcus.webb@example.com', 'email data survives so the alert can name the sender');

    const apiErr = (await runPipeline('03-general-onboarding-question.eml', () => ({ error: { message: '529 - {"type":"error","error":{"type":"overloaded_error"}}', name: 'NodeApiError' } }))).validated;
    assert.equal(apiErr.valid, false);
    assert.match(apiErr.errors[0], /^api_error: /);

    const textOnly = (await runPipeline('07-vague-short.eml', () => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure! Category: technical' }] }))).validated;
    assert.equal(textOnly.valid, false);
    assert.match(textOnly.errors[0], /^no_tool_call/);
  });

  test('Resolve label ID: matches <prefix><category> to the account labels, case-insensitively, and flags a missing one', async () => {
    const ran = {};
    const valid = [];
    for (const f of ['01-billing-double-charge.eml', '08-other-partnership.eml', '04-urgent-outage-html.eml']) {
      valid.push((await runPipeline(f, canned)).validated);
    }
    ran['Schema valid?'] = { all: [valid, []] };
    const labels = [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_1', name: 'Triage/Billing' }, { id: 'Label_2', name: 'Triage/technical' }];
    const out = runCodeNode('Resolve label ID', labels, ran).map((x) => x.json);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((o) => o.labelName), ['Triage/billing', 'Triage/other', 'Triage/technical']);
    assert.deepEqual(out.map((o) => o.labelId), ['Label_1', '', 'Label_2']);
    assert.equal(out[0].replySubject, "Re: Charged TWICE for my subscription - third time I'm writing");
    assert.equal(out[0].id, 'msg-01');
  });

  test('Resolve label ID: works when the label lookup itself failed (no labels at all)', async () => {
    const valid = [(await runPipeline('03-general-onboarding-question.eml', canned)).validated];
    const out = runCodeNode('Resolve label ID', [{ error: 'Insufficient Permission' }], { 'Schema valid?': { all: [valid, []] } }).map((x) => x.json);
    assert.equal(out[0].labelId, '');
  });

  test('Format review alert and Format urgent alert produce escaped Slack text', async () => {
    const bad = (await runPipeline('06-injection-visible-plain.eml', () => ({ error: 'boom' }))).validated;
    const review = runCodeNode('Format review alert', [bad])[0];
    assert.ok(review.text.startsWith(':warning: *Triage failed'));
    assert.ok(review.text.includes('api_error: boom'));
    assert.ok(review.text.includes('Possible prompt injection'));

    const good = (await runPipeline('04-urgent-outage-html.eml', canned)).validated;
    const resolved = runCodeNode('Resolve label ID', [], { 'Schema valid?': { all: [[good], []] } }).map((x) => x.json);
    const urgent = runCodeNode('Format urgent alert', [{ id: 'r1', message: { id: 'draftmsg1', threadId: 'thr-04' } }], { 'Resolve label ID': { all: [resolved] } })[0];
    assert.ok(urgent.text.includes('#drafts?compose=draftmsg1|Open the draft in Gmail'));
    assert.ok(urgent.text.includes('#all/thr-04|Open the thread'));
    assert.ok(urgent.text.includes('Elena Ruiz'));
  });
});
