// Email sanitizer: turns a raw email (HTML and/or plain text) into short, plain text
// that is safe and cheap to send to a language model.
//
// Rules for this file: no imports, no Node-only APIs. The build script
// (scripts/build-workflow.mjs) inlines it verbatim into the n8n Code node, so the code
// that is unit-tested here is exactly the code that runs inside n8n.

const SANITIZE_DEFAULTS = {
  maxChars: 4000, // body length cap sent to the model (cost + abuse limit)
  maxInputChars: 300000, // hard cap on what we even look at (keeps parsing fast)
  maxSubjectChars: 200,
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', bull: '•', euro: '€', pound: '£', yen: '¥', cent: '¢', middot: '·',
  laquo: '«', raquo: '»', times: '×', deg: '°', zwnj: '\u200c', zwj: '\u200d',
};

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr',
]);

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'thead', 'tbody', 'tfoot', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'section', 'article', 'header', 'footer', 'pre', 'blockquote',
  'dl', 'dt', 'dd', 'address', 'form', 'fieldset', 'center', 'main', 'nav', 'aside',
]);

// Block elements that read as a paragraph break; the rest of BLOCK_TAGS is a line break.
const BREAK_LEVEL = {
  p: 2, h1: 2, h2: 2, h3: 2, h4: 2, h5: 2, h6: 2, blockquote: 2, pre: 2, ul: 2, ol: 2,
  table: 2, dl: 2, address: 2, form: 2, fieldset: 2,
};

// Elements whose whole content is never message text.
const DROP_CONTENT_TAGS = new Set([
  'script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'iframe', 'object',
  'canvas', 'video', 'audio',
]);

// Elements whose content is raw text (a "<" inside is not a tag).
const RAW_TEXT_TAGS = new Set(['script', 'style']);

// Class names used by mail clients for quoted history and signatures.
const QUOTE_OR_SIGNATURE_CLASS =
  /(?:^|[\s"'])(?:gmail_quote|gmail_signature|gmail_attr|yahoo_quoted|moz-cite-prefix|moz-signature|protonmail_quote|protonmail_signature_block|ms-outlook-mobile-signature|OutlookMessageHeader)(?:$|[\s"'_-])/i;

const SIGNATURE_CLASS =
  /(?:^|[\s"'])(?:gmail_signature|moz-signature|protonmail_signature_block|ms-outlook-mobile-signature)(?:$|[\s"'_-])/i;

// Instruction-like text aimed at an AI. It has no business being in a support email.
// These only raise a flag for the human reviewer; they never change what gets sent.
const INSTRUCTION_PATTERNS = [
  ['ignore_instructions', /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|messages?|rules?|directions?)/i],
  ['disregard_instructions', /\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:(?:previous|prior|above|earlier)\s+)?(?:instructions?|prompts?|rules?|guidelines?)/i],
  ['reveal_prompt', /\b(?:reveal|show|print|repeat|output|leak)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instructions)\b/i],
  ['system_prompt_mention', /\bsystem\s+prompt\b/i],
  ['new_instructions', /\b(?:new|updated|revised)\s+instructions?\s*:/i],
  ['fake_role_tag', /<\/?\s*(?:system|assistant|human|user|tool_use|tool_result|function_calls?|instructions?)\b/i],
  ['output_steering', /\b(?:classify|categori[sz]e|label|mark|set)\b[^.\n]{0,40}\b(?:urgency|category)\b[^.\n]{0,20}\b(?:low|medium|high|billing|technical|general|other)\b/i],
  ['output_steering', /\b(?:classify|categori[sz]e)\s+(?:this|the|it)\b[^.\n]{0,30}\bas\s+(?:low|medium|high|billing|technical|general|other)\b/i],
];

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (match, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      const ok = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return ok ? String.fromCodePoint(cp) : '';
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : match;
  });
}

// Zero-width, bidi-control, soft-hyphen, BOM, private tag characters (used to smuggle
// invisible instructions) and C0/C1 controls other than tab and newline.
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

const TAG_CHARS = /[\u{e0000}-\u{e007f}]/u;

function stripInvisible(s, stats) {
  let removed = 0;
  const out = s.replace(INVISIBLE_CHARS, () => {
    removed += 1;
    return '';
  });
  if (stats) stats.invisibleCharsRemoved += removed;
  return out;
}

function isHiddenElement(attrs) {
  if (/(?:^|\s)hidden(?:\s|=|$)/i.test(attrs)) return true;
  const m = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  if (!m) return false;
  const style = (m[1] !== undefined ? m[1] : m[2]).toLowerCase().replace(/\s+/g, '');
  return (
    /(?:^|;)display:none/.test(style) ||
    /(?:^|;)visibility:hidden/.test(style) ||
    /(?:^|;)opacity:0(?:\.0*)?(?:;|!|$)/.test(style) ||
    /(?:^|;)font-size:(?:0|1)(?:\.0*)?(?:px|pt|em|rem|%)?(?:;|!|$)/.test(style) ||
    /(?:^|;)mso-hide:all/.test(style) ||
    /(?:^|;)max-height:0(?:px|pt|em|rem)?(?:;|!|$)/.test(style) ||
    (/(?:^|;)height:0(?:px|pt|em|rem)?(?:;|!|$)/.test(style) && /overflow:hidden/.test(style))
  );
}

function getAttr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i').exec(attrs);
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

function isTrackingPixel(attrs) {
  const w = getAttr(attrs, 'width').replace(/px$/i, '');
  const h = getAttr(attrs, 'height').replace(/px$/i, '');
  if (w !== '' && h !== '' && Number(w) <= 2 && Number(h) <= 2) return true;
  return isHiddenElement(attrs);
}

// Reads one tag starting at html[i] === '<'. Returns null when it is just a stray "<".
function readTag(html, i) {
  let j = i + 1;
  const closing = html[j] === '/';
  if (closing) j += 1;
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]{0,39}/.exec(html.slice(j, j + 40));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  j += nameMatch[0].length;
  const attrStart = j;
  const limit = Math.min(html.length, j + 4000);
  let quote = '';
  for (; j < limit; j += 1) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      let attrs = html.slice(attrStart, j);
      const selfClosing = attrs.endsWith('/');
      if (selfClosing) attrs = attrs.slice(0, -1);
      return { end: j + 1, closing, name, attrs, selfClosing };
    }
  }
  return null;
}

// Linear-time HTML to text. Drops scripts/styles/comments, hidden elements, quoted
// history, images (tracking pixels) and link targets; keeps visible text and line breaks.
function htmlToText(html, stats) {
  const out = [];
  const stack = [];
  let dropDepth = 0; // > 0 while inside any dropped element
  let hiddenDepth = 0; // > 0 while inside an element that is hidden from the reader
  const hiddenText = [];
  let i = 0;
  const n = html.length;

  let pendingBreak = 0; // line breaks owed before the next visible text (0, 1 or 2)
  let hasOutput = false;
  let hiddenLen = 0;
  let preDepth = 0;

  const pushText = (raw) => {
    if (!raw) return;
    if (hiddenDepth > 0) {
      if (hiddenLen < 5000) {
        hiddenText.push(raw);
        hiddenLen += raw.length;
      }
      return;
    }
    if (dropDepth > 0) return;
    const t = preDepth > 0 ? raw : raw.replace(/[ \t\r\n\f]+/g, ' ');
    if (t === ' ') {
      if (pendingBreak === 0 && hasOutput) out.push(' ');
      return;
    }
    if (pendingBreak > 0 && hasOutput) out.push('\n'.repeat(pendingBreak));
    pendingBreak = 0;
    out.push(t);
    hasOutput = true;
  };
  // level 1 = line break, level 2 = blank line. Repeated boundaries collapse into one.
  const breakLine = (level, additive) => {
    if (dropDepth > 0) return;
    pendingBreak = additive ? Math.min(2, pendingBreak + level) : Math.max(pendingBreak, level);
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) {
      pushText('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (tag.closing) {
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== tag.name) k -= 1;
      if (k >= 0) {
        while (stack.length > k) {
          const el = stack.pop();
          if (el.drop) dropDepth -= 1;
          if (el.hidden) hiddenDepth -= 1;
          if (el.pre) preDepth -= 1;
        }
      }
      if (BLOCK_TAGS.has(tag.name)) breakLine(BREAK_LEVEL[tag.name] || 1, false);
      else if (tag.name === 'td' || tag.name === 'th') pushText(' ');
      continue;
    }

    if (tag.name === 'img') {
      stats.imagesRemoved += 1;
      continue;
    }
    if (tag.name === 'br') {
      breakLine(1, true);
      continue;
    }
    if (tag.name === 'hr') {
      breakLine(2, false);
      continue;
    }
    if (VOID_TAGS.has(tag.name)) continue;

    const hidden = isHiddenElement(tag.attrs);
    const className = getAttr(tag.attrs, 'class');
    const signature = SIGNATURE_CLASS.test(className);
    const quoted = tag.name === 'blockquote' || signature || QUOTE_OR_SIGNATURE_CLASS.test(className);
    const dropContent = DROP_CONTENT_TAGS.has(tag.name);
    const drop = hidden || quoted || dropContent;
    if (hidden && dropDepth === 0) stats.hiddenElementsRemoved += 1;
    if (quoted && !hidden && dropDepth === 0) {
      if (signature) stats.signatureRemoved = true;
      else stats.quotedBlocksRemoved += 1;
    }

    if (RAW_TEXT_TAGS.has(tag.name)) {
      const re = new RegExp('</' + tag.name + '\\b', 'ig');
      re.lastIndex = i;
      const m = re.exec(html);
      if (!m) {
        i = n;
      } else {
        const end = html.indexOf('>', m.index);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }

    if (tag.selfClosing) continue;
    if (BLOCK_TAGS.has(tag.name)) breakLine(BREAK_LEVEL[tag.name] || 1, false);
    if (tag.name === 'li') pushText('- ');
    const pre = tag.name === 'pre';
    stack.push({ name: tag.name, drop, hidden, pre });
    if (drop) dropDepth += 1;
    if (hidden) hiddenDepth += 1;
    if (pre) preDepth += 1;
  }

  return { text: out.join(''), hiddenText: hiddenText.join('') };
}

function normalizeWhitespace(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cuts quoted reply history. Never cuts if that would leave nothing.
function stripQuotedReply(text, stats) {
  const lines = text.split('\n');
  const kept = [];
  let removedAny = false;
  for (const line of lines) {
    if (/^\s*>/.test(line)) {
      removedAny = true;
    } else {
      kept.push(line);
    }
  }

  let cut = -1;
  for (let i = 0; i < kept.length && cut === -1; i += 1) {
    const one = kept[i];
    const two = i + 1 < kept.length ? one + ' ' + kept[i + 1] : one;
    const three = i + 2 < kept.length ? two + ' ' + kept[i + 2] : two;
    if (
      /^on\s.{3,300}\swrote:?$/i.test(one) ||
      /^on\s.{3,300}\swrote:?$/i.test(two) ||
      /^on\s.{3,300}\swrote:?$/i.test(three) ||
      /^-{2,}\s*original message\s*-{2,}$/i.test(one) ||
      /^_{10,}$/.test(one)
    ) {
      cut = i;
    } else if (
      /^from:\s.+/i.test(one) &&
      kept.slice(i + 1, i + 5).some((l) => /^(?:sent|date):\s/i.test(l)) &&
      kept.slice(i + 1, i + 6).some((l) => /^to:\s/i.test(l))
    ) {
      cut = i;
    }
  }

  let result = kept;
  if (cut > 0 && kept.slice(0, cut).join('').trim() !== '') {
    result = kept.slice(0, cut);
    removedAny = true;
  }
  if (removedAny) stats.quotedBlocksRemoved += 1;
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CLOSING_LINE =
  /^(?:thanks|thank you|many thanks|thanks again|thanks in advance|thank you in advance|best|best regards|kind regards|warm regards|regards|sincerely|yours sincerely|yours truly|respectfully|cheers|take care|talk soon)[,.!\s]*$/i;

const MOBILE_SIGNATURE =
  /^(?:sent from my .{2,40}|get outlook for .{2,20}|sent from (?:mail|outlook|yahoo mail|proton mail|gmail) .{0,30}|sent via .{2,40}|envoy[ée] de mon .{2,30})$/i;

const DISCLAIMER_START =
  /^(?:confidentiality notice|confidential(?:ity)?\s*[:.]|disclaimer\s*:|legal notice|this (?:e-?mail|message)(?: and any (?:attachments|files))? (?:is|are|may be|contains?) (?:confidential|intended|privileged)|the information (?:contained )?in this (?:e-?mail|message)|if you (?:are not the intended recipient|have received this (?:e-?mail|message) in error)|please consider the environment|to unsubscribe|click here to unsubscribe|manage (?:your )?(?:email )?preferences|you (?:are )?receiv(?:ed|ing) this (?:e-?mail|message) because|view (?:this e-?mail )?in (?:your )?browser)/i;

function stripSignatureAndBoilerplate(text, stats) {
  const lines = text.split('\n');
  let cut = -1;
  let reason = '';

  for (let i = 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^--\s?$/.test(l) || /^—\s?$/.test(l)) {
      cut = i;
      reason = 'signature';
      break;
    }
    if (MOBILE_SIGNATURE.test(l)) {
      cut = i;
      reason = 'signature';
      break;
    }
    if (DISCLAIMER_START.test(l)) {
      cut = i;
      reason = 'boilerplate';
      break;
    }
  }

  let result = lines;
  if (cut > 0 && lines.slice(0, cut).join('').trim() !== '') {
    result = lines.slice(0, cut);
    if (reason === 'signature') stats.signatureRemoved = true;
    else stats.boilerplateRemoved = true;
  }

  // Closing phrase followed by a short name/title/phone block at the very end.
  const start = Math.max(1, result.length - 8);
  for (let i = start; i < result.length; i += 1) {
    if (!CLOSING_LINE.test(result[i])) continue;
    const tail = result.slice(i + 1).filter((l) => l.trim() !== '');
    if (tail.length <= 6 && tail.every((l) => l.length <= 70 && !/\?\s*$/.test(l))) {
      if (tail.length > 0) stats.signatureRemoved = true;
      result = result.slice(0, i + 1);
    }
    break;
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findSignals(visibleText, hiddenText) {
  const signals = [];
  for (const [id, re] of INSTRUCTION_PATTERNS) {
    if (re.test(visibleText) && !signals.includes(id)) signals.push(id);
  }
  for (const [id, re] of INSTRUCTION_PATTERNS) {
    const tagged = 'hidden:' + id;
    if (re.test(hiddenText) && !signals.includes(tagged)) signals.push(tagged);
  }
  return signals;
}

function escapeAngles(s) {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanSubject(subject, maxChars) {
  const s = stripInvisible(decodeEntities(String(subject || '')), null)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars - 1).trimEnd() + '…' : s;
}

function parseSender(from) {
  if (!from) return { address: '', name: '' };
  if (typeof from === 'object') {
    const first = Array.isArray(from.value) ? from.value[0] : from;
    if (first && (first.address || first.name)) {
      return { address: String(first.address || '').trim(), name: String(first.name || '').trim() };
    }
    if (typeof from.text === 'string') return parseSender(from.text);
    return { address: '', name: '' };
  }
  const s = String(from).trim();
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  if (m) return { address: m[2], name: (m[1] || '').trim() };
  if (/^[^<>\s]+@[^<>\s]+$/.test(s)) return { address: s, name: '' };
  return { address: '', name: s };
}

// Main entry point.
// item: an email as produced by the n8n Gmail Trigger (simplified output): { from, subject, text, html }
// returns: the cleaned data plus stats that show what was removed.
function sanitizeEmail(item, options) {
  const opts = Object.assign({}, SANITIZE_DEFAULTS, options || {});
  const stats = {
    inputChars: 0,
    outputChars: 0,
    imagesRemoved: 0,
    hiddenElementsRemoved: 0,
    quotedBlocksRemoved: 0,
    signatureRemoved: false,
    boilerplateRemoved: false,
    invisibleCharsRemoved: 0,
    truncated: false,
  };

  const rawText = typeof item.text === 'string' ? item.text : '';
  const rawHtml = typeof item.html === 'string' ? item.html : '';
  stats.inputChars = Math.max(rawText.length, 0) + rawHtml.length;

  // Read what a human would see. When an HTML part exists we sanitize that, because
  // mail parsers (including n8n's) derive the "text" field from the HTML and that
  // derived text still contains hidden elements. The plain-text part is used only when
  // there is no HTML, or the HTML has no visible text at all (e.g. an image-only mail).
  let bodySource = 'empty';
  let working = '';
  let hiddenText = '';
  if (rawHtml.trim() !== '') {
    const parsed = htmlToText(rawHtml.slice(0, opts.maxInputChars), stats);
    working = decodeEntities(parsed.text);
    hiddenText = parsed.hiddenText;
    if (working.trim() !== '') bodySource = 'html';
  }
  if (bodySource === 'empty' && rawText.trim() !== '') {
    bodySource = 'text';
    working = decodeEntities(rawText.slice(0, opts.maxInputChars));
  }

  // Characters in the Unicode "tag" block render as nothing but can carry a hidden
  // message. They never occur in normal mail, so seeing one is worth flagging.
  const sawTagChars = TAG_CHARS.test(working) || TAG_CHARS.test(decodeEntities(hiddenText));

  working = stripInvisible(working, stats);
  hiddenText = stripInvisible(decodeEntities(hiddenText), null);
  working = normalizeWhitespace(working);
  working = stripQuotedReply(working, stats);
  working = stripSignatureAndBoilerplate(working, stats);

  if (working.length > opts.maxChars) {
    const slice = working.slice(0, opts.maxChars);
    const lastSpace = slice.lastIndexOf(' ');
    working = (lastSpace > opts.maxChars * 0.8 ? slice.slice(0, lastSpace) : slice).trimEnd() + ' […truncated]';
    stats.truncated = true;
  }

  const sender = parseSender(item.from);
  const subject = cleanSubject(item.subject, opts.maxSubjectChars);
  const signals = findSignals(working + '\n' + subject, hiddenText);
  if (sawTagChars) signals.push('unicode_tag_characters');
  stats.outputChars = working.length;

  const body = working === '' ? '(no readable text in this email)' : working;
  const fromLine = sender.name ? sender.name + ' <' + sender.address + '>' : sender.address;
  const userMessage =
    '<email>\n' +
    '<from>' + escapeAngles(fromLine) + '</from>\n' +
    '<subject>' + escapeAngles(subject) + '</subject>\n' +
    '<body>\n' + escapeAngles(body) + '\n</body>\n' +
    '</email>';

  return {
    from: sender.address,
    fromName: sender.name,
    subject,
    body,
    bodySource,
    userMessage,
    signals,
    suspicious: signals.length > 0,
    stats,
  };
}

// Allows `import { sanitizeEmail } from '../src/sanitize.js'` in tests; the build script
// strips this line when it inlines the file into the n8n Code node.
export { sanitizeEmail, htmlToText, decodeEntities, SANITIZE_DEFAULTS };
