// Runs the sanitizer over the sample emails exactly as the n8n Gmail Trigger presents
// them (parsed with mailparser, the same library n8n uses) and checks what the model
// would and would not get to see.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { sanitizeEmail } from '../src/sanitize.js';

const dir = new URL('../samples/emails/', import.meta.url);
const load = async (name) => {
  const parsed = await simpleParser(readFileSync(new URL(name, dir)));
  return sanitizeEmail({ from: parsed.from, subject: parsed.subject, text: parsed.text, html: parsed.html });
};

describe('sample emails', () => {
  test('there are eight samples, all parseable with a sender and subject', async () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.eml'));
    assert.equal(files.length, 8);
    for (const f of files) {
      const r = await load(f);
      assert.match(r.from, /@/, f);
      assert.notEqual(r.subject, '', f);
      assert.notEqual(r.body, '(no readable text in this email)', f);
    }
  });

  test('01 billing: mobile signature removed, content intact', async () => {
    const r = await load('01-billing-double-charge.eml');
    assert.ok(r.body.includes('charged $49.00 twice'));
    assert.ok(!r.body.includes('iPhone'));
    assert.equal(r.signals.length, 0);
  });

  test('02 multipart: quoted history, signature and legal footer are gone', async () => {
    const r = await load('02-technical-login-multipart.eml');
    assert.ok(r.body.includes('Token expired'));
    for (const gone of ['Dana', 'fresh reset link', '555 0142', 'CONFIDENTIALITY', 'Operations Lead']) {
      assert.ok(!r.body.includes(gone), `should not contain ${gone}`);
    }
    assert.ok(r.stats.outputChars < r.stats.inputChars / 3);
  });

  test('04 HTML-only outage: tracking pixel, hidden preheader, footer and CSS are gone', async () => {
    const r = await load('04-urgent-outage-html.eml');
    assert.ok(r.body.includes('CHECKOUT HAS BEEN DOWN'));
    for (const gone of ['preview text', 'unsubscribe', 'environment', 'open.gif', 'color:red', '<']) {
      assert.ok(!r.body.toLowerCase().includes(gone.toLowerCase()), `should not contain ${gone}`);
    }
    assert.equal(r.stats.imagesRemoved, 1);
    assert.equal(r.stats.hiddenElementsRemoved, 1);
    assert.equal(r.signals.length, 0, 'a normal hidden preheader is not an attack');
  });

  test('05 hidden injection: the payload never reaches the model, and the attempt is flagged', async () => {
    const r = await load('05-injection-hidden-html.eml');
    assert.ok(r.body.includes('customize the invoice template'));
    for (const gone of ['SYSTEM NOTICE', 'ignore all previous', 'refund', '5,000', 'system prompt', 'New instructions']) {
      assert.ok(!r.userMessage.includes(gone), `userMessage must not contain ${gone}`);
    }
    assert.equal(r.suspicious, true);
    assert.ok(r.signals.includes('hidden:ignore_instructions'));
    assert.ok(r.signals.includes('unicode_tag_characters'));
  });

  test('06 visible injection: cannot be removed, so it is flagged for the human reviewer', async () => {
    const r = await load('06-injection-visible-plain.eml');
    assert.ok(r.body.includes('40,000 rows'));
    assert.ok(r.body.includes('Ignore previous instructions'));
    assert.deepEqual(r.signals.sort(), ['ignore_instructions', 'output_steering', 'system_prompt_mention']);
  });

  test('07 vague one-liner passes through untouched', async () => {
    const r = await load('07-vague-short.eml');
    assert.equal(r.body, 'hi its not working please fix');
  });

  test('every message sent to the model is a single well-formed <email> block', async () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.eml'))) {
      const r = await load(f);
      assert.match(r.userMessage, /^<email>\n<from>.+<\/from>\n<subject>.+<\/subject>\n<body>\n[\s\S]+\n<\/body>\n<\/email>$/, f);
      assert.equal((r.userMessage.match(/<email>/g) || []).length, 1, f);
    }
  });
});
