// Local stand-ins for the five outside services the workflow talks to: Gmail, Google
// Sheets, Google OAuth, Slack and the Anthropic API. One HTTPS server answers for all of
// them, routing on the Host header. Every request is recorded so the test can assert on
// exactly what the workflow did.
//
// What these fakes are and are not: they implement the handful of endpoints the n8n
// nodes call, with the response shapes the real APIs document. They prove the workflow
// sends the right requests and handles the replies; they do not prove Google, Slack or
// Anthropic behave this way today. The Claude fake returns canned answers: it checks
// the REQUEST in detail but does no classifying of its own.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { isDeepStrictEqual } from 'node:util';

export const REDIRECT_HOSTS = [
  'www.googleapis.com',
  'gmail.googleapis.com',
  'sheets.googleapis.com',
  'oauth2.googleapis.com',
  'slack.com',
  'api.anthropic.com',
];

export const TEST_ANTHROPIC_KEY = 'e2e-anthropic-key-not-real';
export const TEST_GOOGLE_TOKEN = 'fake-google-access-token';
export const TEST_SLACK_TOKEN = 'e2e-slack-token-not-real';

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return { text, json: undefined };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

export async function startFakes({ port, key, cert, expected, triageByAddress, missingLabels = [] }) {
  const state = {
    all: [], // every request, in order
    unhandled: [],
    gmail: {
      messages: new Map(), // id -> { id, threadId, eml, rfcId, released, listed }
      modifies: [], // { messageId, addLabelIds }
      drafts: [], // { id, messageId, threadId, to, subject, text, inReplyTo }
      listCalls: 0,
      lists: [], // { after, returned: [ids] } per list call
    },
    sheets: { rows: [['Received', 'From', 'Subject', 'Category', 'Urgency', 'Summary', 'Flags', 'Thread ID']], writes: 0 },
    slack: { posts: [] },
    oauth: { calls: 0 },
    anthropic: { requests: [], attemptsBySender: new Map(), shapeProblems: [] },
  };

  const labelDefs = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'Label_billing', name: 'Triage/billing', type: 'user' },
    { id: 'Label_technical', name: 'Triage/technical', type: 'user' },
    { id: 'Label_general', name: 'Triage/general', type: 'user' },
    { id: 'Label_other', name: 'Triage/other', type: 'user' },
    { id: 'Label_personal', name: 'Family', type: 'user' },
  ].filter((l) => !missingLabels.includes(l.name));

  async function addMessage({ id, threadId, emlPath }) {
    const eml = readFileSync(emlPath);
    const parsed = await simpleParser(eml);
    state.gmail.messages.set(id, { id, threadId, eml, rfcId: parsed.messageId, from: parsed.from.value[0].address, released: false, internalDate: 0 });
  }
  // A released message "arrives" now. Like Gmail, the list call returns everything whose
  // timestamp is at or after the `after:` bound, so a message can legitimately come back on
  // the next poll; the workflow must not process it twice.
  const release = (ids) => {
    const now = Date.now();
    ids.forEach((id) => {
      const m = state.gmail.messages.get(id);
      m.released = true;
      m.internalDate = now;
    });
  };

  // ------------------------------------------------------------- Gmail
  async function gmail(req, res, url, body) {
    const p = url.pathname;
    let m;
    if (req.method === 'GET' && p === '/gmail/v1/users/me/messages') {
      state.gmail.listCalls += 1;
      const after = Number(/(?:^|\s)after:(\d+)/.exec(url.searchParams.get('q') || '')?.[1] || 0);
      const fresh = [...state.gmail.messages.values()].filter((x) => x.released && x.internalDate / 1000 >= after);
      state.gmail.lists.push({ after, returned: fresh.map((x) => x.id) });
      return json(res, 200, fresh.length ? { messages: fresh.map(({ id, threadId }) => ({ id, threadId })), resultSizeEstimate: fresh.length } : { resultSizeEstimate: 0 });
    }
    if (req.method === 'GET' && (m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = state.gmail.messages.get(m[1]);
      if (!msg) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      return json(res, 200, {
        id: msg.id, threadId: msg.threadId, labelIds: ['INBOX', 'UNREAD'], sizeEstimate: msg.eml.length,
        internalDate: String(msg.internalDate), raw: msg.eml.toString('base64url'),
      });
    }
    if (req.method === 'GET' && p === '/gmail/v1/users/me/labels') return json(res, 200, { labels: labelDefs });
    if (req.method === 'POST' && (m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(p))) {
      state.gmail.modifies.push({ messageId: m[1], addLabelIds: body.json?.addLabelIds, removeLabelIds: body.json?.removeLabelIds });
      return json(res, 200, { id: m[1], threadId: state.gmail.messages.get(m[1])?.threadId, labelIds: ['INBOX', ...(body.json?.addLabelIds || [])] });
    }
    if (req.method === 'GET' && (m = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(p))) {
      const msgs = [...state.gmail.messages.values()].filter((x) => x.threadId === m[1]);
      if (!msgs.length) return json(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } });
      return json(res, 200, { id: m[1], messages: msgs.map((x) => ({ id: x.id, threadId: x.threadId, payload: { headers: [{ name: 'Message-ID', value: x.rfcId }] } })) });
    }
    if (req.method === 'POST' && p === '/gmail/v1/users/me/drafts') {
      const raw = body.json?.message?.raw;
      const parsed = await simpleParser(Buffer.from(raw || '', 'base64'));
      const n = state.gmail.drafts.length + 1;
      const draft = {
        id: `r-${n}`, messageId: `dm-${n}`, threadId: body.json?.message?.threadId,
        to: parsed.to?.value?.map((a) => a.address) || [], subject: parsed.subject, text: (parsed.text || '').replace(/\r\n/g, '\n').trimEnd(),
        inReplyTo: parsed.inReplyTo, raw,
      };
      state.gmail.drafts.push(draft);
      return json(res, 200, { id: draft.id, message: { id: draft.messageId, threadId: draft.threadId, labelIds: ['DRAFT'] } });
    }
    return null;
  }

  // ------------------------------------------------------------- Sheets
  function sheets(req, res, url, body) {
    const p = decodeURIComponent(url.pathname);
    let m;
    if (req.method === 'GET' && (m = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(p))) {
      return json(res, 200, { spreadsheetId: m[1], sheets: [{ properties: { sheetId: 0, title: 'Triage log', index: 0, sheetType: 'GRID', gridProperties: { rowCount: Math.max(1000, state.sheets.rows.length), columnCount: 26 } } }] });
    }
    if (req.method === 'GET' && /^\/v4\/spreadsheets\/[^/:]+\/values\/.+/.test(p)) {
      return json(res, 200, { range: 'Triage log!A1:Z1000', majorDimension: 'ROWS', values: state.sheets.rows });
    }
    if (req.method === 'POST' && /^\/v4\/spreadsheets\/[^/:]+:batchUpdate$/.test(p)) {
      return json(res, 200, { replies: (body.json?.requests || []).map(() => ({})) });
    }
    if (req.method === 'PUT' && (m = /^\/v4\/spreadsheets\/[^/:]+\/values\/(?:[^!]*!)?[A-Z]*(\d+)(?::[A-Z]*\d+)?$/.exec(p))) {
      // n8n writes all new rows in one call, e.g. "Triage log!2:9" or "Triage log!A2:H9"
      const first = Number(m[1]);
      body.json.values.forEach((v, i) => (state.sheets.rows[first - 1 + i] = v.map(String)));
      state.sheets.writes += 1;
      return json(res, 200, { spreadsheetId: 'x', updatedRange: p.split('/values/')[1], updatedRows: body.json.values.length, updatedColumns: body.json.values[0].length, updatedCells: body.json.values.length * body.json.values[0].length });
    }
    if (req.method === 'POST' && /^\/v4\/spreadsheets\/[^/:]+\/values\/.+:append$/.test(p)) {
      for (const v of body.json.values) state.sheets.rows.push(v.map(String));
      state.sheets.writes += 1;
      return json(res, 200, { updates: { updatedRows: body.json.values.length } });
    }
    return null;
  }

  // ------------------------------------------------------------- Slack
  function slack(req, res, url, body) {
    if (req.method === 'POST' && url.pathname === '/api/chat.postMessage') {
      const payload = body.json || Object.fromEntries(new URLSearchParams(body.text));
      state.slack.posts.push({ channel: payload.channel, text: payload.text, authorization: req.headers.authorization, extra: Object.keys(payload).filter((k) => !['channel', 'text'].includes(k)) });
      return json(res, 200, { ok: true, channel: 'C0E2ETEST', ts: `${Date.now() / 1000}`, message: { text: payload.text, type: 'message' } });
    }
    return null;
  }

  // ------------------------------------------------------------- Anthropic
  function anthropic(req, res, url, body) {
    if (!(req.method === 'POST' && url.pathname === '/v1/messages')) return null;
    const problems = [];
    const b = body.json;
    if (req.headers['x-api-key'] !== TEST_ANTHROPIC_KEY) problems.push('x-api-key header missing or wrong');
    if (req.headers['anthropic-version'] !== '2023-06-01') problems.push('anthropic-version header missing or wrong');
    if (!/application\/json/.test(req.headers['content-type'] || '')) problems.push('content-type is not JSON');
    if (!b || typeof b !== 'object') {
      problems.push('body is not JSON');
    } else {
      const allowed = ['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice'];
      for (const k of Object.keys(b)) if (!allowed.includes(k)) problems.push(`unexpected field ${k}`);
      if (typeof b.model !== 'string' || !b.model) problems.push('model missing');
      if (!Number.isInteger(b.max_tokens) || b.max_tokens <= 0) problems.push('max_tokens missing');
      if (b.system !== expected.systemPrompt) problems.push('system prompt differs from prompts/system-prompt.txt');
      if (!isDeepStrictEqual(b.tools, [expected.schema])) problems.push('tools differ from schema/triage_email.tool.json');
      if (!isDeepStrictEqual(b.tool_choice, { type: 'tool', name: 'triage_email' })) problems.push('tool_choice is not the forced triage_email tool');
      const msg = b.messages?.[0];
      if (!Array.isArray(b.messages) || b.messages.length !== 1 || msg.role !== 'user' || typeof msg.content !== 'string') problems.push('messages must be exactly one user message with string content');
      else if (!/^<email>\n<from>.+<\/from>\n<subject>.+<\/subject>\n<body>\n[\s\S]+\n<\/body>\n<\/email>$/.test(msg.content)) problems.push('user message is not a well-formed <email> block');
    }
    const content = b?.messages?.[0]?.content || '';
    const fromMatch = /<from>(?:.*&lt;(.+?)&gt;|(.+))<\/from>/.exec(content);
    const sender = fromMatch ? fromMatch[1] || fromMatch[2] : 'unknown';
    state.anthropic.requests.push({ sender, content, model: b?.model, problems });
    state.anthropic.shapeProblems.push(...problems.map((p) => `${sender}: ${p}`));
    state.anthropic.attemptsBySender.set(sender, (state.anthropic.attemptsBySender.get(sender) || 0) + 1);

    if (problems.length) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: problems.join('; ') } });
    const attempt = state.anthropic.attemptsBySender.get(sender);
    if (sender === 'qa-flaky@example.test' && attempt === 1) return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    if (sender === 'qa-overloaded@example.test') return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    const answer = triageByAddress[sender];
    if (!answer) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `e2e fake has no canned answer for ${sender}` } });
    return json(res, 200, {
      id: 'msg_e2e', type: 'message', role: 'assistant', model: b.model, stop_reason: 'tool_use', stop_sequence: null,
      content: [{ type: 'tool_use', id: 'toolu_e2e', name: 'triage_email', input: answer }],
      usage: { input_tokens: 650, output_tokens: 140 },
    });
  }

  // ------------------------------------------------------------- Google OAuth
  function oauth(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/token') {
      state.oauth.calls += 1;
      return json(res, 200, { access_token: TEST_GOOGLE_TOKEN, expires_in: 3599, token_type: 'Bearer' });
    }
    return null;
  }

  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const url = new URL(req.url, `https://${host}`);
    const body = await readBody(req);
    const entry = { n: state.all.length + 1, at: Date.now(), host, method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization };
    state.all.push(entry);
    try {
      let handled = null;
      if (host === 'www.googleapis.com' || host === 'gmail.googleapis.com') {
        if (req.headers.authorization !== `Bearer ${TEST_GOOGLE_TOKEN}`) {
          entry.badAuth = true;
        }
        handled = await gmail(req, res, url, body);
      } else if (host === 'sheets.googleapis.com') {
        if (req.headers.authorization !== `Bearer ${TEST_GOOGLE_TOKEN}`) entry.badAuth = true;
        handled = sheets(req, res, url, body);
      } else if (host === 'slack.com') {
        handled = slack(req, res, url, body);
      } else if (host === 'api.anthropic.com') {
        handled = anthropic(req, res, url, body);
      } else if (host === 'oauth2.googleapis.com') {
        handled = oauth(req, res, url);
      }
      if (handled === null) {
        state.unhandled.push(`${req.method} ${host}${url.pathname}${url.search}`);
        json(res, 404, { error: { code: 404, message: `e2e fake: no handler for ${req.method} ${host}${url.pathname}` } });
      }
    } catch (err) {
      state.unhandled.push(`ERROR ${req.method} ${host}${url.pathname}: ${err.stack}`);
      json(res, 500, { error: { code: 500, message: String(err) } });
    }
  });

  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).on('error', reject));
  return { state, addMessage, release, close: () => new Promise((r) => server.close(r)) };
}
