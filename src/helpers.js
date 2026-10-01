// Small pure helpers shared by several n8n Code nodes: addressing, reply subject, label
// names, Gmail links and Slack message text.
//
// Rules for this file: no imports, no Node-only APIs. The build script inlines it into
// the Code nodes that need it.

function firstAddress(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value) || /([^<>\s,;]+@[^<>\s,;]+)/.exec(value);
    return m ? m[1] : '';
  }
  const first = Array.isArray(value.value) ? value.value[0] : value;
  if (first && typeof first.address === 'string') return first.address.trim();
  if (typeof value.text === 'string') return firstAddress(value.text);
  return '';
}

function replySubject(subject) {
  const s = String(subject || '').trim();
  if (s === '') return 'Re: your message';
  return /^re\s*:/i.test(s) ? s : 'Re: ' + s;
}

function labelNameFor(prefix, category) {
  return String(prefix || '') + String(category || '');
}

function gmailThreadUrl(mailIndex, threadId) {
  return 'https://mail.google.com/mail/u/' + Number(mailIndex || 0) + '/#all/' + encodeURIComponent(threadId || '');
}

// Opens the saved draft in Gmail's compose window. messageId is the draft's *message* id
// (draft.message.id in the Gmail API response), not the draft id.
function gmailDraftUrl(mailIndex, messageId) {
  return 'https://mail.google.com/mail/u/' + Number(mailIndex || 0) + '/#drafts?compose=' + encodeURIComponent(messageId || '');
}

// Slack treats &, < and > as control characters (<!channel>, <https://x|label>). Anything
// that came from an email must be escaped so a sender cannot ping a channel or fake a link.
function slackEscape(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function oneLine(s, max) {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function senderLabel(ctx) {
  const addr = ctx.from || 'unknown sender';
  return ctx.fromName ? ctx.fromName + ' <' + addr + '>' : addr;
}

function flagsLine(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return '';
  return '\n:warning: *Possible prompt injection in this email* (' + slackEscape(signals.join(', ')) + '), read it before sending.';
}

// ctx: { from, fromName, subject, triage: {category, urgency, summary}, signals, threadId,
//        draftMessageId, mailIndex }
function formatUrgentAlert(ctx) {
  const links = [];
  if (ctx.draftMessageId) links.push('<' + gmailDraftUrl(ctx.mailIndex, ctx.draftMessageId) + '|Open the draft in Gmail>');
  if (ctx.threadId) links.push('<' + gmailThreadUrl(ctx.mailIndex, ctx.threadId) + '|Open the thread>');
  return (
    ':red_circle: *Urgent support email, reply drafted for your review*\n' +
    '*From:* ' + slackEscape(oneLine(senderLabel(ctx), 200)) + '\n' +
    '*Subject:* ' + slackEscape(oneLine(ctx.subject, 200)) + '\n' +
    '*Category:* ' + slackEscape(ctx.triage.category) + '  |  *Urgency:* ' + slackEscape(ctx.triage.urgency) + '\n' +
    '*Summary:* ' + slackEscape(oneLine(ctx.triage.summary, 500)) + '\n' +
    links.join('  |  ') +
    flagsLine(ctx.signals)
  );
}

// ctx: { from, fromName, subject, errors, signals, threadId, mailIndex }
function formatReviewAlert(ctx) {
  const errors = Array.isArray(ctx.errors) && ctx.errors.length > 0 ? ctx.errors : ['unknown problem'];
  return (
    ':warning: *Triage failed, this email needs manual review*\n' +
    '*From:* ' + slackEscape(oneLine(senderLabel(ctx), 200)) + '\n' +
    '*Subject:* ' + slackEscape(oneLine(ctx.subject, 200)) + '\n' +
    '*Why:* ' + slackEscape(oneLine(errors.join('; '), 600)) + '\n' +
    (ctx.threadId ? '<' + gmailThreadUrl(ctx.mailIndex, ctx.threadId) + '|Open the thread>' : '') +
    flagsLine(ctx.signals)
  );
}

export {
  firstAddress, replySubject, labelNameFor, gmailThreadUrl, gmailDraftUrl, slackEscape,
  oneLine, formatUrgentAlert, formatReviewAlert,
};
