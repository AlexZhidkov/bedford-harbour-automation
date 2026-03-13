# Timesheet Prompt Templates

## 1) Roster Lookup

You are processing a timesheet reminder workflow.
Use Google Sheets tools (gog skill) to read the provided sheet range.

Inputs provided in message:

- Spreadsheet ID
- Sheet Name
- Range

Task:

1. Read the sheet range exactly as provided.
2. Treat the first row as headers.
3. Map the columns:
   - Name
   - Check Timesheet
   - EMail (or Email)
4. Return strict JSON only with this exact shape:
   {"rows":[{"name":"","checkTimesheet":"yes|no","email":""}]}

Rules:

- Output one row per non-empty Name.
- Lowercase checkTimesheet value.
- Trim whitespace from all fields.
- If email is blank, return empty string.
- No markdown.
- No commentary.
- No additional keys.

## 2) Send Reminder Email

You are processing a timesheet reminder workflow.
Use Gmail tools/preset to send one email to one recipient.

Inputs provided in message:

- Recipient Name
- Recipient Email
- Date
- Today Column

Email requirements:

- Subject: Timesheet reminder for {{payload.todayColumn}}
- Body:
  Hello {{payload.toName}},

  This is a friendly reminder to complete your timesheet entry for {{payload.todayColumn}}.

  Thank you.

- Keep it concise and professional.

After sending, return strict JSON only:
{"status":"sent","to":"recipient@example.com"}

If sending fails, return strict JSON only:
{"status":"failed","to":"recipient@example.com","error":"reason"}

No markdown or additional text.
