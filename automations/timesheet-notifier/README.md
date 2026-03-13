# Timesheet Notifier

Scrapes missing daily timesheets and sends reminders only to staff with `Check Timesheet = yes` from Google Sheets.

## Files

- `check-timesheets.js`: Scrapes TimePro for missing submissions.
- `timesheet-reminder-orchestrator.js`: Runs scrape, resolves hook replies, filters recipients, sends reminders.
- `timesheet-hook-mapping.json`: Hook mapping template for OpenClaw config.
- `timesheet-prompt-template.md`: Prompt contract for roster lookup and email send.

## Setup

1. Install dependencies at repo root:
   - `npm install`
2. Ensure OpenClaw gateway is running on the VM.
3. Merge `timesheet-hook-mapping.json` mappings into your OpenClaw config.
4. Set environment values in `/home/alex/.openclaw/.env` (see `.env.example`).

## Run

- Normal run:
  - `npm run timesheet:run`
- Dry run:
  - `npm run timesheet:dry`

## Notes

- Hook routes are async and return `runId`; orchestrator resolves final output through gateway calls.
- Timeout controls are available through env vars in `.env.example`.
