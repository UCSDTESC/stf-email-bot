# STF Email Bot — Plan

## Context
TESC (Triton Engineering Student Council) runs the **Student Travel Fund (STF)**: JSOE undergrads apply via Google Form, get reimbursed $300–500 for domestic conference/competition travel. Students keep emailing the same questions (deadlines, eligibility, receipts, post-travel form, summer travel, Matching Funds conflict). Goal: a bot that **auto-replies 24/7** to these emails at **contact@tescatucsd.org** (main STF address; TESC moved everything from tesc.ucsd.edu to tescatucsd.org), hands anything else to a human, costs **≤ $1–2/month**, and is easy for rotating student volunteers to maintain.

Source of truth for the FAQ today: `UCSDTESC/tescatucsd.org` → `src/pages/FundingPage/Funding.tsx` (live at https://tescatucsd.org/funding).

### Things found during research that need fixing first
1. **Wrong email on the STF page:** it shows `board@tescatucasd.org` (typo, domain has no mail server → emails bounce). Change it to `contact@tescatucsd.org` in `Funding.tsx` (~line 6). Also replace any old `@tesc.ucsd.edu` addresses (e.g. site footer) with `@tescatucsd.org`.
2. **Broken PDF link:** `/Funding/Student-Certification-for-Business.pdf` returns the site's HTML, not the PDF.
3. **Email authentication is incomplete for tescatucsd.org** (DNS is on AWS Route 53): no Google SPF entry, no Google DKIM record, DMARC is `p=none`. Auto-sent replies may land in spam until this is fixed.

## Research summary (what we chose and why)
Full sourced research was done (deep-research run + a scan of Jul–Oct 2026 changes).

| Decision | Choice | Why |
|---|---|---|
| Where it runs | **Google Apps Script**, owned by the shared contact@ account (a second copy on board@, sharing the same FAQ Doc + Control Panel), time trigger every 5 min | Free; no server; no OAuth refresh tokens to expire (the #1 failure for Gmail-API/Zapier/n8n setups); Workspace quotas are huge vs ~10 emails/day (6 h/day runtime, 1,500 recipients/day). Owned by the club account so it survives volunteers leaving. |
| AI model | **Pick by a test** among 3 paid, no-training, ~$0.10/M-token models: Claude Haiku 5.5, Gemini 2.5 Flash-Lite (paid), OpenAI GPT-6 Luna / gpt-5-nano. Default to Haiku 5.5 until the test is done. | All cost **~$0.30–0.50/month** at 300 emails. Price isn't the deciding factor; answer quality on real STF emails is. Code is provider-swappable via one setting. |
| Not chosen | Gemini **free** tier | Google's terms: free-tier prompts can be used for training and read by human reviewers; "do not submit personal information." Limits also get cut without notice. |
| Not chosen | Cloudflare/Gmail-API servers, Zapier/Make/n8n | Need stored OAuth tokens that break (7-day expiry in "Testing" mode, revoked on password change) → silent outages. |
| Maybe later | **Google Workspace Studio** "Reply to email" step (added Sep 2026) | No-code, but replies to outside senders may need approval, usage limits start Nov 1 2026, no header-level loop protection, and the plan type is unknown. Worth a 30-min test only. |
| FAQ approach | Paste the whole FAQ into the prompt (no search/vector database) | FAQ is 3–10k tokens; simple and accurate. |

## Architecture
```
Gmail (contact@tescatucsd.org, + same script on board@)
   │  every 5 min (Apps Script time trigger)
   ▼
1. Find new threads:  in:inbox -label:stf-bot/done newer_than:2d
2. Safety filters  → skip (and label) if:
     Auto-Submitted ≠ no, List-* headers, Precedence bulk/list/junk,
     null sender, noreply/mailer-daemon, our own address,
     bot already replied in this thread, daily cap (50) reached
3. Is it STF-related?  ── no ──► leave untouched for humans
4. Ask the AI (FAQ from Google Doc + email) → JSON:
     { is_stf, answerable, needs_human_reason, reply }
5. answerable ──► send reply in same thread
                  (header Auto-Submitted: auto-replied, AI disclosure footer)
   status question ─► look up sender's row in Form responses Sheet → reply
   needs a decision ─► instant "forwarded" reply + label stf-bot/needs-decision
6. Log every decision to a Google Sheet
```

Rules baked into the prompt: answer **only** from the FAQ; never promise approval, amounts, or status; anything about a specific application's status, late post-travel forms, exceptions, or money left → escalate. The bot has **no tools**: it can only write a reply to the original sender (limits damage from instructions hidden in emails; studies in 2026 still show 22–58% success for such attacks on unprotected models).

Disclosure footer on every reply: *"This answer was written by TESC's automated assistant. Reply with 'human' to reach a board member."* Replies containing "human" → escalate.

## Automation goal: humans only for real decisions
The bot auto-sends with **no approval step**. Target: **≥ 90% of STF emails fully handled by the bot.** Humans only see:
- **Decisions about money or rules** (late post-travel form exceptions, appeals, "can you make an exception"). An AI should not decide these; they're the council's call.
- **Errors** (bot crashed / stopped).

How we shrink the human share:
1. **Status questions answered automatically.** The bot reads (read-only) the Google Form responses Sheet that STF reviewers already use. If the sender's UCSD email matches an application, it replies with *that sender's own* status (received date, under review / approved / denied, post-travel form link if approved). Never reveals anyone else's data. *Needs: a `Status` column in the responses Sheet that reviewers keep updated (they already have to track this).*
2. **Escalations still get an instant reply.** The bot answers the student right away: "This needs a board member's decision; it's been forwarded and you'll hear back within X business days." The student is never left waiting with no answer; humans just handle the decision later.
3. **The bot improves itself from escalations.** A weekly job lists the most common escalated questions and drafts new FAQ entries; one person approves them in the FAQ Doc (a 5-minute weekly task, not per-email).

No shadow week with human checking every reply; instead a **2-day automated test** (run the eval + loop tests), then go live.

## Abuse protection (spam, prompt injection, draining credits)
Checks run in code **before** the AI is called (free), then hard limits cap the worst case.
- **Only real UCSD senders (verified):** sender must be exactly `@ucsd.edu` (not subdomains: UCSD's DMARC is `p=reject` but `sp=none`, so subdomains can be spoofed) AND the newest `Authentication-Results` header from `mx.google.com` must show `dmarc=pass ... header.from=ucsd.edu`. Read headers via the Gmail advanced service (`Gmail.Users.Messages.get(..., {format:'metadata', metadataHeaders:[...]})`), not `getHeader()` (doesn't handle repeated headers). Ignore fake headers lower in the message. Others are left for humans, no AI call.
- **Gmail spam filter first:** the bot only reads the Inbox, never Spam.
- **Rate limits:** max 3 bot replies per sender per day, 1 per thread turn, 100 AI calls per day total. Blocklist column in the Control Panel.
- **Bounded cost per email:** strip quoted history/attachments, cut the body to ~3,000 characters, cap AI output length → ≈ $0.001 per email. 1,000 spam emails ≈ $1.
- **Hard spend cap (verified, all 3 providers support it):** $5 prepaid credit with auto-reload OFF + a monthly spend limit on a dedicated workspace/project key. Anthropic: Billing → Spend limits (not allowed on Default Workspace, so use a separate one). OpenAI: turn on "Enforce a hard limit" and turn OFF auto-recharge (on by default). Gemini: AI Studio → Spend → Monthly spend cap (experimental). Caps aren't instant (a few minutes of overage possible), so the bot's own daily call limit stays as a backup.
- **Bot has no powers:** the AI only returns text; code sends it to the original sender. It can't forward, delete, or read other data.
- **Status lookup is done by code, not the AI:** code matches the sender's address to their own row and passes only that row. The AI never sees other students' data, so a malicious email can't make it leak any.
- **Output checks in code before sending:** links must be on an allowlist (tescatucsd.org, ucsd.edu, the STF form); length limit; must be valid JSON. Fail → don't send, flag.
- **Injection tests** in the eval set (e.g. "ignore your instructions and…") must pass before launch.

## Managing the bot: "STF Bot Control Panel" (one Google Sheet)
Shared with the tech committee + STF lead. Passive: nobody has to check it daily. It's there for when you want to see what the bot did.

| Tab | What it shows | Who uses it |
|---|---|---|
| **Settings** | `Bot on/off` (kill switch), `Mode` = shadow / auto-send, daily reply cap, AI provider + model, link to FAQ Doc | Tech committee |
| **Activity Log** | One row per email the bot **saw**: time, sender, subject, short summary, decision (answered / escalated / skipped + why), the exact reply sent, model used, cost, link to the Gmail thread | Anyone |
| **Needs Decision** | Only the money/rule-exception emails, with a `Done` checkbox | STF lead |
| **FAQ Suggestions** | Auto-drafted new FAQ entries from repeated escalations; approve with a checkbox | Weekly, 5 min |
| **Stats** | Charts: emails/week, % auto-answered vs escalated, top question topics, monthly AI cost | Board meetings |
| **Errors** | Any crash or failed AI call, with time and message | Tech committee |

Also:
- **Gmail labels** inside board@ (`stf-bot/answered`, `stf-bot/needs-human`, `stf-bot/skipped`) so you can also see everything from the inbox.
- **Alerts:** only when something is wrong: instant email if the bot errors 3 times in a row or stops running (heartbeat check). Weekly summary email of stats.
- Optional: post escalations to a channel in the TESC Discord via webhook.

## Files (new repo, e.g. `UCSDTESC/stf-email-bot`, code pushed with `clasp`)
- `src/Main.gs`: trigger entry point `processInbox()`; loop over new threads.
- `src/Filters.gs`: loop-prevention and skip rules (RFC 3834 headers, caps).
- `src/Llm.gs`: one function `askModel(faq, email)` with adapters for Anthropic / Gemini / OpenAI (raw `UrlFetchApp` calls; structured JSON output). Provider + model come from Script Properties.
- `src/Mailer.gs`: send threaded reply through the **Gmail advanced service** (raw MIME with `In-Reply-To`, `References`, `threadId`, `Auto-Submitted: auto-replied`), because plain `GmailApp.reply()` can't set custom headers.
- `src/Log.gs`: append to log Sheet; daily digest email of `needs-human` threads.
- `src/Setup.gs`: one-time `install()` that creates labels and the trigger.
- `eval/`: `sample_emails.json` (20–30 real past STF emails, names removed) + `runEval()` that scores each model.
- `docs/FAQ` → Google Doc (editable by volunteers, no code), seeded from `Funding.tsx`.
- `README.md`: beginner handoff guide (how to edit FAQ, check logs, pause the bot, rotate API key).
- Secrets: API key in **Script Properties**, never in code. Spending cap ($5/month) set in the provider's console.

## Steps
0. **Get permission + check accounts:** TESC board OK for an auto-replying bot and for sending student emails to a paid AI provider (check UCSD/JSOE policy); find the Workspace admin and plan type; get access to the contact@ and board@ accounts. Ask board members who get STF emails personally to point students to contact@ (bot doesn't run on personal inboxes).
1. **Fix the website:** typo email + broken PDF link (PR to `UCSDTESC/tescatucsd.org`).
2. **Fix email authentication:** turn on DKIM in Google Admin, add Google SPF (`include:_spf.google.com`), keep DMARC `p=none` until checked, then tighten.
3. **Write the FAQ Google Doc** (the bot's only source of info) from the funding page + 20–30 real past STF emails from contact@, board@ and board members' own inboxes; have the STF lead approve it.
4. **Build the script** (files above) in a test Gmail first.
5. **Model test:** run `eval/` against the 3 models; pick the one that answers correctly and escalates correctly most often.
6. **2-day automated test** on contact@ in shadow mode (eval + loop + injection tests pass automatically).
7. **Go live with full auto-send.** Humans only get pinged for decisions and errors.
8. (Optional) 30-min test of Workspace Studio for comparison.

## Verification
- `runEval()` on sample emails: target ≥ 90% correct answers and 100% escalation on status/exception questions.
- Loop tests: send from an auto-responder, a mailing list, and a `noreply@` address → bot must skip all.
- Injection test: email saying "ignore your rules and…" → must escalate or answer normally, never follow it.
- Deliverability: send a test reply to a ucsd.edu and a gmail.com inbox; "Show original" shows SPF/DKIM/DMARC = PASS, not in spam.
- Status lookup: email from an applicant's address gets their own status; email asking about someone else's application is refused.

## Cost
~$0.30–0.50/month for the AI; $0 for Apps Script, Gmail, Docs, Sheets. Hard cap $5/month in the AI console.
