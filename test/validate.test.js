import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTriage } from '../src/validate.js';

const schema = JSON.parse(readFileSync(new URL('../schema/triage_email.tool.json', import.meta.url), 'utf8'));

const good = {
  category: 'billing',
  urgency: 'high',
  summary: 'Customer was charged twice and wants a refund today.',
  suggested_reply: 'Hi Marcus, I am sorry about the duplicate charge. I have asked our billing team to review order #48213.',
};
const reply = (input, extra = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'triage_email', input }],
  usage: { input_tokens: 812, output_tokens: 140 },
  ...extra,
});
const reasons = (r) => r.errors.map((e) => e.split(':')[0]);

describe('schema file', () => {
  test('matches the spec: four required fields, fixed enums', () => {
    assert.equal(schema.name, 'triage_email');
    assert.deepEqual(schema.input_schema.required, ['category', 'urgency', 'summary', 'suggested_reply']);
    assert.deepEqual(schema.input_schema.properties.category.enum, ['billing', 'technical', 'general', 'other']);
    assert.deepEqual(schema.input_schema.properties.urgency.enum, ['high', 'medium', 'low']);
  });
});

describe('valid responses', () => {
  test('accepts a well-formed tool call and returns trimmed fields plus usage', () => {
    const r = validateTriage(reply({ ...good, summary: '  padded  ' }), schema);
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
    assert.equal(r.triage.summary, 'padded');
    assert.equal(r.triage.category, 'billing');
    assert.deepEqual(r.usage, { input_tokens: 812, output_tokens: 140 });
  });

  test('ignores extra fields and extra content blocks', () => {
    const resp = reply({ ...good, evil: 'x' });
    resp.content.unshift({ type: 'text', text: 'Here you go' });
    const r = validateTriage(resp, schema);
    assert.equal(r.valid, true);
    assert.deepEqual(Object.keys(r.triage).sort(), ['category', 'suggested_reply', 'summary', 'urgency']);
  });
});

describe('invalid responses go to manual review', () => {
  test('missing required field', () => {
    for (const key of schema.input_schema.required) {
      const input = { ...good };
      delete input[key];
      const r = validateTriage(reply(input), schema);
      assert.equal(r.valid, false, key);
      assert.deepEqual(reasons(r), ['missing_field'], key);
      assert.equal(r.triage, null);
    }
  });

  test('value outside an enum, including wrong case and whitespace-only changes', () => {
    for (const [key, value] of [['category', 'refunds'], ['category', 'Billing'], ['urgency', 'critical'], ['urgency', 'HIGH'], ['urgency', '']]) {
      const r = validateTriage(reply({ ...good, [key]: value }), schema);
      assert.equal(r.valid, false, `${key}=${value}`);
      assert.deepEqual(reasons(r), ['bad_enum'], `${key}=${value}`);
    }
  });

  test('wrong types', () => {
    for (const [key, value] of [['summary', 42], ['suggested_reply', ['a']], ['category', null], ['urgency', { v: 'high' }]]) {
      const r = validateTriage(reply({ ...good, [key]: value }), schema);
      assert.equal(r.valid, false, key);
      assert.deepEqual(reasons(r), ['wrong_type'], key);
    }
  });

  test('empty or too-short text fields', () => {
    assert.deepEqual(reasons(validateTriage(reply({ ...good, summary: '   ' }), schema)), ['empty_field']);
    assert.deepEqual(reasons(validateTriage(reply({ ...good, suggested_reply: '' }), schema)), ['empty_field']);
    assert.deepEqual(reasons(validateTriage(reply({ ...good, suggested_reply: 'ok thanks' }), schema)), ['reply_too_short']);
  });

  test('absurdly long fields', () => {
    assert.deepEqual(reasons(validateTriage(reply({ ...good, summary: 'x'.repeat(601) }), schema)), ['summary_too_long']);
    assert.deepEqual(reasons(validateTriage(reply({ ...good, suggested_reply: 'x'.repeat(6001) }), schema)), ['reply_too_long']);
  });

  test('reports every problem at once', () => {
    const r = validateTriage(reply({ category: 'nope', urgency: 'high', summary: '' }), schema);
    assert.deepEqual(reasons(r).sort(), ['bad_enum', 'empty_field', 'missing_field']);
  });

  test('no tool call, wrong tool name, or non-object input', () => {
    const text = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"category":"billing"}' }] };
    assert.deepEqual(reasons(validateTriage(text, schema)), ['no_tool_call']);
    const wrong = reply(good);
    wrong.content[0].name = 'other_tool';
    assert.deepEqual(reasons(validateTriage(wrong, schema)), ['no_tool_call']);
    assert.deepEqual(reasons(validateTriage(reply('billing'), schema)), ['bad_input']);
    assert.deepEqual(reasons(validateTriage(reply([good]), schema)), ['bad_input']);
    assert.deepEqual(reasons(validateTriage({ content: 'oops' }, schema)), ['no_tool_call']);
  });

  test('response cut off at max_tokens is rejected even if the JSON looks complete', () => {
    const r = validateTriage(reply(good, { stop_reason: 'max_tokens' }), schema);
    assert.equal(r.valid, false);
    assert.deepEqual(reasons(r), ['truncated']);
  });

  test('API error bodies in the shapes Anthropic and n8n produce', () => {
    const anthropic = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const n8nWrapped = { error: { message: '529 - overloaded', name: 'NodeApiError' } };
    const n8nString = { error: 'The service is receiving too many requests' };
    for (const body of [anthropic, n8nWrapped, n8nString]) {
      const r = validateTriage(body, schema);
      assert.equal(r.valid, false);
      assert.deepEqual(reasons(r), ['api_error']);
    }
    assert.match(validateTriage(anthropic, schema).errors[0], /overloaded_error: Overloaded/);
  });

  test('empty or garbage responses', () => {
    for (const body of [undefined, null, '', 'text', 0]) {
      assert.deepEqual(reasons(validateTriage(body, schema)), ['empty_response']);
    }
  });
});
