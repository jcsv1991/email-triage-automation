# End-to-end test

Runs the shipped `workflow/email-triage.workflow.json` inside a **real n8n** and checks what it does to Gmail, Google Sheets, Slack and the Claude API.

## How it works

- `fakes/servers.mjs` is one local HTTPS server that answers as Gmail, Google Sheets, Slack, Google OAuth and Anthropic. It records every request. The Anthropic fake validates the request strictly (headers, allowed fields, the exact system prompt and tool schema from this repo, forced `tool_choice`, a well-formed `<email>` block) and replies with canned answers from `fixtures/mock-triage.json`, keyed by sender. **No real model is involved.**
- `fakes/redirect.cjs` is preloaded into n8n (`NODE_OPTIONS=--require`). It sends n8n's outgoing connections for those hosts to the local server, so the workflow runs unmodified. Only the credential IDs are swapped in a temporary copy.
- A throwaway CA is generated with `openssl` and handed to n8n through `NODE_EXTRA_CA_CERTS`, so TLS is verified exactly as it would be against the real services.
- `run.mjs` imports the workflow and credentials with the n8n CLI, starts n8n, waits for the first Gmail poll, then delivers the emails and asserts on what the fakes recorded.
- `fixtures/` adds three emails on top of `samples/emails/`: one for which the fake model returns an invalid category, one for which the API is always overloaded (HTTP 529), and one for which it fails once and then recovers.

## Run it

Needs Node 24+ (n8n 2.x requirement), `openssl`, and an n8n install:

```bash
npm ci
npm install --prefix .n8n-e2e n8n@2.41.4
N8N_BIN=.n8n-e2e/node_modules/.bin/n8n npm run e2e
```

Takes about four minutes, most of it waiting for n8n's one-minute Gmail polling interval.

| Option | Effect |
|---|---|
| `--phase1-only` | Skip the second poll (about one minute in total) |
| `--workflow=<file>` | Test a different workflow file, for example a deliberately broken copy |
| `--n8n=<path>` | Path to the n8n executable (or set `N8N_BIN`) |
| `--keep` | Keep the temp folder and the n8n log |

It uses ports 15678 (n8n) and 18443 (fakes). Exit code is 0 only if every check passes.

## Limits

The fakes follow the documented request and response shapes of the real services, but they are fakes. A pass here means the workflow is wired correctly and handles the answers it is given. It does not mean the real Gmail, Slack, Google Sheets or Anthropic APIs were exercised.
