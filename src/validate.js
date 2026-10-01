// Validates what came back from the Anthropic Messages API for the forced triage_email
// tool call. Even with a forced tool call the model output is not trusted: this is the
// "Schema valid?" gate in the workflow. Anything that fails goes to manual review and
// never reaches Gmail, the log, or Slack as if it were a real result.
//
// Rules for this file: no imports, no Node-only APIs. It is inlined into an n8n Code node.

const VALIDATE_LIMITS = {
  summaryMax: 600,
  replyMin: 20, // shorter than this cannot be a real reply
  replyMax: 6000,
};

function describeApiError(response) {
  const err = response && (response.error || (response.type === 'error' ? response : null));
  if (!err) return '';
  if (typeof err === 'string') return err;
  const inner = err.error && typeof err.error === 'object' ? err.error : err;
  const parts = [inner.type, inner.message].filter((x) => typeof x === 'string' && x !== '');
  return parts.join(': ') || 'unknown API error';
}

// response: the parsed JSON body of POST /v1/messages (or the error object n8n passes on)
// schema:   the triage_email tool definition (schema/triage_email.tool.json)
function validateTriage(response, schema, limits) {
  const lim = Object.assign({}, VALIDATE_LIMITS, limits || {});
  const errors = [];
  const fail = () => ({ valid: false, errors, triage: null, usage: null });

  if (!response || typeof response !== 'object') {
    errors.push('empty_response');
    return fail();
  }

  const apiError = describeApiError(response);
  if (apiError) {
    errors.push('api_error: ' + apiError);
    return fail();
  }

  const usage = response.usage && typeof response.usage === 'object'
    ? { input_tokens: response.usage.input_tokens || 0, output_tokens: response.usage.output_tokens || 0 }
    : null;

  if (response.stop_reason === 'max_tokens') {
    errors.push('truncated: model stopped at max_tokens, tool input may be incomplete');
    return { valid: false, errors, triage: null, usage };
  }

  const blocks = Array.isArray(response.content) ? response.content : [];
  const call = blocks.find((b) => b && b.type === 'tool_use' && b.name === schema.name);
  if (!call) {
    errors.push('no_tool_call: response has no ' + schema.name + ' tool_use block');
    return { valid: false, errors, triage: null, usage };
  }

  const input = call.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('bad_input: tool input is not an object');
    return { valid: false, errors, triage: null, usage };
  }

  const props = schema.input_schema.properties;
  const required = schema.input_schema.required || [];
  const triage = {};
  for (const key of required) {
    if (!(key in input)) errors.push('missing_field: ' + key);
  }
  for (const key of Object.keys(props)) {
    if (!(key in input)) continue;
    const def = props[key];
    const value = input[key];
    if (def.type === 'string') {
      if (typeof value !== 'string') {
        errors.push('wrong_type: ' + key + ' must be a string');
        continue;
      }
      const trimmed = value.trim();
      if (Array.isArray(def.enum)) {
        if (!def.enum.includes(trimmed)) {
          errors.push('bad_enum: ' + key + '=' + JSON.stringify(value.slice(0, 40)) + ' not in [' + def.enum.join(', ') + ']');
          continue;
        }
      } else if (trimmed === '') {
        errors.push('empty_field: ' + key);
        continue;
      }
      triage[key] = trimmed;
    }
  }

  // Edge cases the schema cannot express.
  if (typeof triage.summary === 'string' && triage.summary.length > lim.summaryMax) {
    errors.push('summary_too_long: ' + triage.summary.length + ' chars');
  }
  if (typeof triage.suggested_reply === 'string') {
    if (triage.suggested_reply.length < lim.replyMin) {
      errors.push('reply_too_short: ' + triage.suggested_reply.length + ' chars');
    } else if (triage.suggested_reply.length > lim.replyMax) {
      errors.push('reply_too_long: ' + triage.suggested_reply.length + ' chars');
    }
  }

  if (errors.length > 0) return { valid: false, errors, triage: null, usage };
  return { valid: true, errors: [], triage, usage };
}

export { validateTriage, VALIDATE_LIMITS };
