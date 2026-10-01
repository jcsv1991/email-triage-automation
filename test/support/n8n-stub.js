// A tiny stand-in for the n8n Code-node runtime, so the exact jsCode stored in the
// workflow file can be executed by the unit tests without installing n8n.
// (The e2e suite runs the same workflow inside a real n8n instance.)
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';

export const workflow = JSON.parse(
  readFileSync(new URL('../../workflow/email-triage.workflow.json', import.meta.url), 'utf8')
);

export const nodeByName = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`No node named ${name}`);
  return n;
};

// ran: { 'Node name': { all: [[json, ...] per output branch] } }; item = this item's json
function makeDollar(ran, itemIndex) {
  return (name) => {
    const r = ran[name];
    if (!r) throw new Error(`Node "${name}" has not been executed`);
    return {
      item: { json: (r.all[0] || [])[itemIndex] },
      all: (branch = 0) => (r.all[branch] || []).map((json) => ({ json })),
    };
  };
}

// Runs a Code node. mode 'runOnceForEachItem': items = [json, ...], returns [json, ...].
// mode 'runOnceForAllItems': returns the array of { json } the node returned.
export function runCodeNode(name, items, ran = {}) {
  const node = nodeByName(name);
  const { mode, jsCode } = node.parameters;
  const fn = new Function('$json', '$', '$input', jsCode);
  if (mode === 'runOnceForEachItem') {
    return items.map((json, i) => {
      const out = fn(json, makeDollar(ran, i), { all: () => [{ json }] });
      if (!out || typeof out.json !== 'object') throw new Error(`${name} did not return { json }`);
      return out.json;
    });
  }
  const out = fn(undefined, makeDollar(ran, 0), { all: () => items.map((json) => ({ json })) });
  if (!Array.isArray(out)) throw new Error(`${name} did not return an array`);
  return out;
}

// What the Gmail Trigger (Simplify off) hands to the workflow: mailparser output plus ids.
export async function gmailTriggerItem(emlPath, id, threadId) {
  const p = await simpleParser(readFileSync(emlPath));
  const headers = {};
  for (const h of p.headerLines) headers[h.key] = h.line;
  return {
    id,
    threadId,
    labelIds: ['INBOX', 'UNREAD'],
    sizeEstimate: 1000,
    ...p,
    headers,
    headerLines: undefined,
    attachments: undefined,
    date: p.date ? p.date.toISOString() : undefined,
  };
}

// The values the Settings (Set) node would add, read from the workflow file itself.
export function settingsValues() {
  const out = {};
  for (const a of nodeByName('Settings').parameters.assignments.assignments) out[a.name] = a.value;
  return out;
}
