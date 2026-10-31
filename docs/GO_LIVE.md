# Go-live checklist: moving the bot to TESC's real inbox

The bot is finished and tested in a test Gmail. Moving it to TESC only changes **who owns it** and **a few settings**. No code changes.

## 1. Get approval and access (people, not code)
- [ ] TESC board approves an auto-replying bot on `contact@tescatucsd.org` (and `board@`).
- [ ] Check UCSD/JSOE policy on sending student emails to a paid AI provider (Anthropic's API doesn't train on API data).
- [ ] Someone can sign in to `contact@tescatucsd.org` (and `board@`) to install it.
- [ ] Check whether `contact@` is a real Gmail account or a Google Group that forwards to other people. The bot must be installed on an account that **receives** the emails. If it's a group, install it on the account the group delivers to.
- [ ] The STF lead has read the FAQ (`faq/STF_FAQ.md`) and fixed anything wrong or out of date.

## 2. Fix things outside the bot
- [ ] Website: the STF page shows a typo'd email (`board@tescatucasd.org`). Change it to `contact@tescatucsd.org`.
- [ ] Email authentication for `tescatucsd.org` (DNS admin + Google Workspace admin): turn on DKIM in Google Admin and add `include:_spf.google.com` to the SPF record. Without it, the bot's replies may land in spam.
- [ ] Ask board members who get STF emails personally to point students to `contact@` (the bot only runs on shared inboxes).

## 3. Make a TESC-owned API key (10 minutes)
1. A TESC account (not a personal one) signs up at https://console.anthropic.com.
2. Buy $5 of credit. Leave **auto-reload OFF**.
3. Create a workspace called "STF Bot" and set its **monthly spend limit to $5**. Create the API key inside that workspace.

## 4. Install (signed in as `contact@tescatucsd.org`)
1. On a laptop with this repo: `npm install` (first time only), then `npm run bundle -- --copy`. The whole bot is now on your clipboard.
2. Go to https://script.google.com > **New project**, name it "STF Bot".
3. Paste into `Code.gs` (select all, then paste). In **Project Settings**, tick **Show "appsscript.json" manifest file in editor** and replace that file's contents with `dist/appsscript.json`.
4. Run `setup()`. Click Allow on the permissions screen. The log shows links to the **Control Panel** and the **FAQ Doc**.
5. **Project Settings > Script Properties > Add script property**: name `ANTHROPIC_API_KEY`, value = the key from step 3.
6. Change these in the Control Panel's **Settings** tab:

| Setting | Set it to |
|---|---|
| `OWN_ADDRESSES` | `contact@tescatucsd.org, board@tescatucsd.org` (already the default). Order matters: if a student emails both, only the **first** one replies. |
| `MODE` | leave `shadow` for now |
| `ALERT_EMAILS` | the tech committee's email(s), comma-separated |
| `APPLICATIONS_SHEET_ID` | optional: the ID of the STF application responses Sheet (the long code in its URL). The Sheet needs a `Status` column that reviewers keep up to date, and the contact@ account needs view access. |

7. Share the Control Panel and FAQ Doc with the tech committee and the STF lead.
8. Run `runEval()`. Check the log: escalations and prompt-injection must be **100%**, overall should be about 90% or higher. Results are in the **Eval** tab.
9. Run `installTriggers()`. The bot starts now and **only handles emails that arrive after this moment**. Old emails are never touched.

**Second inbox (`board@`)**: repeat steps 2–5 and 9 signed in as `board@`, but skip `setup()`'s new Control Panel: before running `setup()`, add the script property `CONTROL_PANEL_ID` with the ID of the Control Panel from step 4. Both inboxes then log to the same Control Panel and read the same FAQ Doc.

## 5. Two days in shadow mode, then live
- [ ] For 2 days, check the **Activity Log** each day: is each "(shadow) answered" reply correct? Is each "needs decision" a real decision?
- [ ] Fix wrong answers by editing the **FAQ Doc**, then run `runEval()` again.
- [ ] Set `MODE` to `live`. Send one test email from a UCSD address and check that the reply arrives in the same thread, is not in spam, and that "Show original" shows SPF, DKIM and DMARC = PASS.

## Every year
- [ ] Update the FAQ Doc with the new application window, links and amounts.
- [ ] Hand the Control Panel, FAQ Doc and Apps Script project to the next tech committee (they're owned by the TESC account, so nothing breaks when people graduate).

## Undo / emergency
- Pause right away: Control Panel > Settings > `BOT_ENABLED` = `FALSE`.
- Turn off completely: run `uninstallTriggers()`.
- Stop all AI spending: delete the API key in the Anthropic console.
