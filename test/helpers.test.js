import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstAddress, replySubject, labelNameFor, gmailThreadUrl, gmailDraftUrl, slackEscape,
  oneLine, formatUrgentAlert, formatReviewAlert,
} from '../src/helpers.js';

describe('addressing and naming', () => {
  test('firstAddress reads mailparser objects, header strings and junk', () => {
    assert.equal(firstAddress({ value: [{ address: 'a@x.test', name: 'A' }] }), 'a@x.test');
    assert.equal(firstAddress('Ann <ann@x.test>, Bob <bob@x.test>'), 'ann@x.test');
    assert.equal(firstAddress('ann@x.test'), 'ann@x.test');
    assert.equal(firstAddress({ text: 'Ann <ann@x.test>' }), 'ann@x.test');
    assert.equal(firstAddress(undefined), '');
    assert.equal(firstAddress('no address here'), '');
  });

  test('replySubject adds "Re: " once', () => {
    assert.equal(replySubject('Charged twice'), 'Re: Charged twice');
    assert.equal(replySubject('Re: Charged twice'), 'Re: Charged twice');
    assert.equal(replySubject('RE: x'), 'RE: x');
    assert.equal(replySubject(''), 'Re: your message');
  });

  test('labelNameFor joins prefix and category', () => {
    assert.equal(labelNameFor('Triage/', 'billing'), 'Triage/billing');
    assert.equal(labelNameFor('', 'other'), 'other');
  });

  test('Gmail links are built from ids and the account index', () => {
    assert.equal(gmailThreadUrl(0, '18c3f'), 'https://mail.google.com/mail/u/0/#all/18c3f');
    assert.equal(gmailDraftUrl(2, 'r-123'), 'https://mail.google.com/mail/u/2/#drafts?compose=r-123');
    assert.equal(gmailThreadUrl(undefined, 'a b'), 'https://mail.google.com/mail/u/0/#all/a%20b');
  });
});

describe('Slack text', () => {
  test('escapes control characters so email content cannot ping or fake links', () => {
    assert.equal(slackEscape('<!channel> & <https://evil.test|click>'), '&lt;!channel&gt; &amp; &lt;https://evil.test|click&gt;');
    assert.equal(slackEscape(undefined), '');
  });

  test('oneLine collapses whitespace and clips', () => {
    assert.equal(oneLine('a\n\n b\t c', 50), 'a b c');
    assert.equal(oneLine('x'.repeat(30), 10), 'xxxxxxxxx…');
  });

  const ctx = {
    from: 'marcus@example.com',
    fromName: 'Marcus <script>',
    subject: 'Charged <!channel> twice',
    triage: { category: 'billing', urgency: 'high', summary: 'Charged twice & angry <!here>' },
    signals: [],
    threadId: 'thr1',
    draftMessageId: 'msg9',
    mailIndex: 0,
  };

  test('urgent alert links straight to the draft and the thread', () => {
    const t = formatUrgentAlert(ctx);
    assert.ok(t.includes('<https://mail.google.com/mail/u/0/#drafts?compose=msg9|Open the draft in Gmail>'));
    assert.ok(t.includes('<https://mail.google.com/mail/u/0/#all/thr1|Open the thread>'));
    assert.ok(t.includes('*Category:* billing  |  *Urgency:* high'));
  });

  test('urgent alert escapes every piece of email-derived text', () => {
    const t = formatUrgentAlert(ctx);
    assert.ok(!t.includes('<!channel>'));
    assert.ok(!t.includes('<!here>'));
    assert.ok(!t.includes('<script>'));
    assert.ok(t.includes('Marcus &lt;script&gt; <marcus@example.com>'.replace('<marcus@example.com>', '&lt;marcus@example.com&gt;')));
    // the only angle brackets left are our own two links
    assert.equal((t.match(/</g) || []).length, 2);
  });

  test('injection flags are shown to the reviewer', () => {
    const t = formatUrgentAlert({ ...ctx, signals: ['ignore_instructions', 'hidden:reveal_prompt'] });
    assert.ok(t.includes('Possible prompt injection'));
    assert.ok(t.includes('ignore_instructions, hidden:reveal_prompt'));
    assert.ok(!formatUrgentAlert(ctx).includes('prompt injection'));
  });

  test('missing draft id still produces a usable alert', () => {
    const t = formatUrgentAlert({ ...ctx, draftMessageId: '' });
    assert.ok(!t.includes('Open the draft'));
    assert.ok(t.includes('Open the thread'));
  });

  test('manual-review alert explains why and escapes the reason', () => {
    const t = formatReviewAlert({ from: 'a@x.test', fromName: '', subject: 'Help', errors: ['bad_enum: urgency="<!channel>"', 'missing_field: summary'], threadId: 't1', mailIndex: 0 });
    assert.ok(t.startsWith(':warning: *Triage failed'));
    assert.ok(t.includes('bad_enum: urgency="&lt;!channel&gt;"; missing_field: summary'));
    assert.ok(t.includes('<https://mail.google.com/mail/u/0/#all/t1|Open the thread>'));
    assert.ok(formatReviewAlert({ from: 'a@x.test', subject: 's', errors: [] }).includes('unknown problem'));
  });
});
