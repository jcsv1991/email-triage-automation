# Live demo script

A 5-minute walkthrough you can run with a personal Gmail account. No client and no real support inbox needed.

## Before the call (10 minutes)

1. Import the workflow and connect your credentials ([README, Setup](../README.md#setup)). Point the Gmail Trigger at a test inbox you own, and the Slack node at a test channel.
2. Create the four labels in Gmail: `Triage/billing`, `Triage/technical`, `Triage/general`, `Triage/other`.
3. Activate the workflow.
4. From a *second* email address, send the three warm-up emails below to the test inbox and let the workflow process them (about a minute, because the trigger polls once a minute). Check that each one has a label and an unsent draft on its thread.

The sample company ("Harbor") and every name below are made up. Replace them with whatever fits your demo.

### Warm-up email 1: billing, urgent tone

> **Subject:** Charged TWICE for my subscription, third time I'm writing
>
> Hello,
>
> I was charged $49.00 twice on September 3rd for the same monthly plan (order #48213). My bank statement shows both charges. This is the third time I'm emailing about this and nobody has replied.
>
> I need the duplicate charge refunded today. If I don't hear back by end of day I will dispute it with my bank.
>
> Marcus Webb

Expected: label `Triage/billing`, urgency high, Slack alert with a link to the draft.

### Warm-up email 2: general question, relaxed tone

> **Subject:** Onboarding for a team of 15?
>
> Hi there, we're thinking about moving our small agency (15 people) onto Harbor. Do you offer onboarding sessions for teams, or is it all self-serve? Is there a Spanish-language interface? No rush, we're deciding next month.
>
> Tomasz

Expected: label `Triage/general`, urgency low, no Slack alert. The draft should not invent features. It should say it will confirm.

### Warm-up email 3: too vague to answer

> **Subject:** it's not working
>
> Hi, it doesn't work. Can you fix it? Thanks

Expected: the draft says honestly that more information is needed (the prompt asks for exactly this) instead of guessing.

## On the call

1. **Show the workflow** on the n8n canvas. Walk left to right: trigger, sanitize, Claude, validation, log, label, draft, urgent check, Slack. Point at the sticky note that says the workflow never sends mail.
2. **Send one more email live** (use warm-up email 2 reworded, or write your own). Open the execution log and watch it run. Show the sanitized text that goes to Claude, and the Claude response with `category`, `urgency`, `summary` and `suggested_reply`.
3. **Switch to Gmail.** Show the label on the message and the draft sitting unsent on the thread.
4. **Send an urgent one live** (the double-charge email, or your own). Show the Slack alert land with a link straight to the draft. Click it, land in Gmail, review, and send *by hand*.
5. **Say it out loud:** "It already did the first pass. You just review and hit send." The point is time saved, not judgment replaced.

## If they ask about risk (they will)

- *"Can it send something wrong to a customer?"* No. There is no send step in the workflow, and a test asserts that. Every reply is a draft a person reads first.
- *"What if someone puts instructions in an email?"* Show `samples/emails/05-injection-hidden-html.eml` and `06-injection-visible-plain.eml`. Hidden text is removed before Claude sees the email, visible attempts are flagged in the log, and the system prompt tells Claude to treat the email as data. This reduces the risk rather than removing it, and the human review step is the backstop.
- *"What if Claude gives a bad answer or the API is down?"* The email goes to a Slack "manual review" alert with the reason. Nothing is silently dropped.

## Reset after a demo

Delete the test drafts and the test rows from the Sheet. The workflow only looks at unread inbox mail, so mark any leftovers as read.
