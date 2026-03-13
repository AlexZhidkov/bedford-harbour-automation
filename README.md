# Bedford Harbour Automation Monorepo

This repository stores automation projects used on the Bedford Harbour VM and related environments.

## Projects

- `automations/timesheet-notifier`: Scrapes missing timesheets and sends reminder emails through OpenClaw hooks.

## Quick Start

1. Install dependencies:
   - `npm install`
2. Configure environment:
   - Copy `automations/timesheet-notifier/.env.example` to your VM env file (for example `/home/alex/.openclaw/.env`), then set real values.
3. Run timesheet notifier:
   - `npm run timesheet:run`
4. Dry run:
   - `npm run timesheet:dry`

## Publish to GitHub

1. Initialize git and commit.
2. Create a remote repository (GitHub UI or `gh repo create`).
3. Push main branch.

See project-specific setup in `automations/timesheet-notifier/README.md`.
