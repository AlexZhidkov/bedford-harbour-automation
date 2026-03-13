const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeName(name) {
  return (name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function jsonArg(value) {
  return JSON.stringify(value || {});
}

function parseTrailingJson(stdout) {
  const text = (stdout || "").trim();
  if (!text) {
    throw new Error("Timesheet script produced no output");
  }

  try {
    return JSON.parse(text);
  } catch {
    // Continue and try to parse the last JSON object from noisy output.
  }

  const start = text.lastIndexOf("\n{");
  const jsonText = start >= 0 ? text.slice(start + 1) : text;

  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON output from check-timesheets.js: ${err.message}`,
    );
  }
}

function extractJsonFromResponse(data) {
  if (!data) {
    throw new Error("Hook returned empty response");
  }

  if (Array.isArray(data.rows)) {
    return data;
  }

  if (data && typeof data === "object") {
    if (Array.isArray(data.result?.rows)) {
      return data.result;
    }

    if (typeof data.result === "string") {
      return extractJsonFromResponse(data.result);
    }

    if (typeof data.output === "string") {
      return extractJsonFromResponse(data.output);
    }

    if (typeof data.response === "string") {
      return extractJsonFromResponse(data.response);
    }
  }

  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      // Continue to fenced block extraction.
    }

    const fenced = data.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) {
      return JSON.parse(fenced[1]);
    }

    const objectLike = data.match(/\{[\s\S]*\}/);
    if (objectLike && objectLike[0]) {
      try {
        return JSON.parse(objectLike[0]);
      } catch {
        // Keep falling through to throw with context.
      }
    }
  }

  if (typeof data.message === "string") {
    return extractJsonFromResponse(data.message);
  }

  if (typeof data.text === "string") {
    return extractJsonFromResponse(data.text);
  }

  const preview = (() => {
    try {
      return JSON.stringify(data, null, 2).slice(0, 2000);
    } catch {
      return String(data).slice(0, 2000);
    }
  })();

  throw new Error(
    `Could not extract JSON from hook response. Preview: ${preview}`,
  );
}

async function callHook({ baseUrl, hookToken, hookPath, payload }) {
  const url = `${baseUrl.replace(/\/$/, "")}/hooks/${hookPath}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${hookToken}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Hook ${hookPath} failed (${response.status}): ${bodyText}`,
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function parseGatewayCallJson(stdout) {
  const text = (stdout || "").trim();
  if (!text) {
    throw new Error("openclaw gateway call produced no output");
  }

  try {
    return JSON.parse(text);
  } catch {
    // Fall through and attempt trailing JSON extraction.
  }

  const start = text.lastIndexOf("\n{");
  const jsonText = start >= 0 ? text.slice(start + 1) : text;

  try {
    return JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse openclaw gateway call JSON: ${err.message}`,
    );
  }
}

async function callGatewayMethod(method, params) {
  const defaultCliTimeoutMsRaw = Number(
    process.env.OPENCLAW_GATEWAY_CALL_TIMEOUT_MS || 30000,
  );
  const defaultCliTimeoutMs =
    Number.isFinite(defaultCliTimeoutMsRaw) && defaultCliTimeoutMsRaw > 0
      ? Math.floor(defaultCliTimeoutMsRaw)
      : 30000;
  const requestedWaitMs =
    method === "agent.wait" && typeof params?.timeoutMs === "number"
      ? Math.floor(params.timeoutMs)
      : 0;
  const cliTimeoutMs = Math.max(defaultCliTimeoutMs, requestedWaitMs + 10000);

  const args = [
    "gateway",
    "call",
    method,
    "--json",
    "--timeout",
    String(cliTimeoutMs),
    "--params",
    jsonArg(params),
  ];

  if (process.env.OPENCLAW_GATEWAY_TOKEN?.trim()) {
    args.push("--token", process.env.OPENCLAW_GATEWAY_TOKEN.trim());
  }

  const { stdout, stderr } = await execFileAsync("openclaw", args, {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });

  if (stderr && stderr.trim()) {
    console.error("[openclaw gateway stderr]\n" + stderr.trim());
  }

  return parseGatewayCallJson(stdout);
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }

  if (typeof message.content === "string" && message.content.trim()) {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    const joined = message.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.content === "string") {
            return part.content;
          }
          if (typeof part.value === "string") {
            return part.value;
          }
        }
        return "";
      })
      .join("\n")
      .trim();
    if (joined) {
      return joined;
    }
  }

  if (Array.isArray(message.parts)) {
    const joined = message.parts
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          if (typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.value === "string") {
            return part.value;
          }
        }
        return "";
      })
      .join("\n")
      .trim();
    if (joined) {
      return joined;
    }
  }

  return "";
}

function messageMatchesRun(message, runId) {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.runId === runId) {
    return true;
  }
  if (
    message.meta &&
    typeof message.meta === "object" &&
    message.meta.runId === runId
  ) {
    return true;
  }
  if (
    message.metadata &&
    typeof message.metadata === "object" &&
    message.metadata.runId === runId
  ) {
    return true;
  }
  return false;
}

function isAssistantMessage(message) {
  const role =
    typeof message?.role === "string" ? message.role.toLowerCase() : "";
  if (role === "assistant" || role === "model") {
    return true;
  }
  const kind =
    typeof message?.kind === "string" ? message.kind.toLowerCase() : "";
  return kind === "assistant" || kind === "model";
}

function toTimestampMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  // Heuristic: 10-digit unix seconds vs 13-digit unix ms.
  if (value > 1e12) {
    return Math.floor(value);
  }
  if (value > 1e9) {
    return Math.floor(value * 1000);
  }
  return null;
}

function messageTimestampMs(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  return (
    toTimestampMs(message.createdAt) ||
    toTimestampMs(message.updatedAt) ||
    toTimestampMs(message.timestamp) ||
    toTimestampMs(message.ts) ||
    toTimestampMs(message.time) ||
    null
  );
}

function pickReplyMessage(messages, runId, startedAtMs) {
  const assistantMessages = messages.filter(isAssistantMessage);
  const exact = assistantMessages.filter((message) =>
    messageMatchesRun(message, runId),
  );
  if (exact.length > 0) {
    return exact[exact.length - 1];
  }

  const fresh = assistantMessages.filter((message) => {
    const ts = messageTimestampMs(message);
    return ts !== null && ts >= startedAtMs;
  });
  if (fresh.length > 0) {
    return fresh[fresh.length - 1];
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSessionMessages(sessionKey, limit = 120) {
  const history = await callGatewayMethod("sessions.get", {
    key: sessionKey,
    limit,
  });
  return Array.isArray(history.messages) ? history.messages : [];
}

async function resolveHookRunReply({ runId, sessionKey }) {
  const startedAtMs = Date.now();
  const timeoutMsRaw = Number(process.env.HOOK_RUN_TIMEOUT_MS || 120000);
  const timeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 120000;

  const waitResult = await callGatewayMethod("agent.wait", {
    runId,
    timeoutMs,
  });

  if (waitResult.status === "timeout") {
    const fallbackPollMsRaw = Number(
      process.env.HOOK_TIMEOUT_FALLBACK_POLL_MS || 180000,
    );
    const fallbackPollMs =
      Number.isFinite(fallbackPollMsRaw) && fallbackPollMsRaw > 0
        ? Math.floor(fallbackPollMsRaw)
        : 180000;
    const pollIntervalMsRaw = Number(
      process.env.HOOK_TIMEOUT_FALLBACK_INTERVAL_MS || 4000,
    );
    const pollIntervalMs =
      Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0
        ? Math.floor(pollIntervalMsRaw)
        : 4000;
    const deadline = Date.now() + fallbackPollMs;

    while (Date.now() <= deadline) {
      const messages = await fetchSessionMessages(sessionKey);
      const target = pickReplyMessage(messages, runId, startedAtMs);
      if (target) {
        const text = extractMessageText(target);
        if (text.trim()) {
          return text;
        }
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Hook run timed out: ${runId} (no reply found in session ${sessionKey} after fallback polling)`,
    );
  }
  if (waitResult.status === "error") {
    throw new Error(
      `Hook run failed: ${runId} (${waitResult.error || "unknown error"})`,
    );
  }

  const messages = await fetchSessionMessages(sessionKey, 120);
  const target = pickReplyMessage(messages, runId, startedAtMs);

  if (!target) {
    throw new Error(
      `Hook run completed but no assistant message found in session ${sessionKey}`,
    );
  }

  const text = extractMessageText(target);
  if (!text.trim()) {
    throw new Error(
      `Hook run completed but assistant message was empty in session ${sessionKey}`,
    );
  }

  return text;
}

async function runTimesheetScript() {
  const { stdout, stderr } = await execFileAsync(
    "node",
    ["check-timesheets.js"],
    {
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );

  if (stderr && stderr.trim()) {
    console.error("[check-timesheets stderr]\n" + stderr.trim());
  }

  return parseTrailingJson(stdout);
}

async function main() {
  const baseUrl = (
    process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18789"
  ).trim();
  const hookToken = requireEnv("OPENCLAW_HOOK_TOKEN");
  const spreadsheetId = requireEnv("TIMESHEET_SHEET_ID");
  const sheetName = (process.env.TIMESHEET_SHEET_NAME || "Staff").trim();
  const sheetRange = (process.env.TIMESHEET_SHEET_RANGE || "A:C").trim();
  const rosterHookPath = (
    process.env.TIMESHEET_ROSTER_HOOK_PATH || "timesheet-roster"
  ).trim();
  const emailHookPath = (
    process.env.TIMESHEET_EMAIL_HOOK_PATH || "timesheet-email"
  ).trim();
  const rosterSessionKeyTemplate = (
    process.env.TIMESHEET_ROSTER_SESSION_KEY_TEMPLATE ||
    "hook:timesheet:roster:{{date}}"
  ).trim();
  const emailSessionKeyTemplate = (
    process.env.TIMESHEET_EMAIL_SESSION_KEY_TEMPLATE ||
    "hook:timesheet:email:{{date}}"
  ).trim();
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

  const timesheet = await runTimesheetScript();
  const missingNames = Array.isArray(timesheet.missing)
    ? timesheet.missing
    : [];
  const missingSet = new Set(missingNames.map(normalizeName));

  const rosterSessionKey = rosterSessionKeyTemplate.replaceAll(
    "{{date}}",
    timesheet.date,
  );
  const emailSessionKey = emailSessionKeyTemplate.replaceAll(
    "{{date}}",
    timesheet.date,
  );

  const rosterRaw = await callHook({
    baseUrl,
    hookToken,
    hookPath: rosterHookPath,
    payload: {
      spreadsheetId,
      sheetName,
      range: `${sheetName}!${sheetRange}`,
      date: timesheet.date,
      todayColumn: timesheet.todayColumn,
      missingCount: timesheet.missingCount,
      missing: missingNames,
    },
  });

  const rosterResolved =
    rosterRaw &&
    typeof rosterRaw === "object" &&
    rosterRaw.ok === true &&
    typeof rosterRaw.runId === "string"
      ? await resolveHookRunReply({
          runId: rosterRaw.runId,
          sessionKey: rosterSessionKey,
        })
      : rosterRaw;

  const rosterPayload = extractJsonFromResponse(rosterResolved);
  const rows = Array.isArray(rosterPayload.rows) ? rosterPayload.rows : [];

  const recipients = rows
    .map((row) => ({
      name: (row.name || row.Name || "").trim(),
      checkTimesheet: (
        row.checkTimesheet ||
        row.check_timesheet ||
        row["Check Timesheet"] ||
        ""
      )
        .toString()
        .trim()
        .toLowerCase(),
      email: (row.email || row.Email || "").trim(),
    }))
    .filter((row) => row.name && row.email)
    .filter((row) => row.checkTimesheet === "yes")
    .filter((row) => missingSet.has(normalizeName(row.name)));

  const uniqueRecipients = [];
  const seenEmails = new Set();
  for (const recipient of recipients) {
    const emailKey = recipient.email.toLowerCase();
    if (!seenEmails.has(emailKey)) {
      seenEmails.add(emailKey);
      uniqueRecipients.push(recipient);
    }
  }

  const sent = [];
  const failed = [];

  for (const recipient of uniqueRecipients) {
    if (dryRun) {
      sent.push({ ...recipient, dryRun: true });
      continue;
    }

    try {
      const emailRaw = await callHook({
        baseUrl,
        hookToken,
        hookPath: emailHookPath,
        payload: {
          toName: recipient.name,
          toEmail: recipient.email,
          date: timesheet.date,
          todayColumn: timesheet.todayColumn,
        },
      });

      if (
        emailRaw &&
        typeof emailRaw === "object" &&
        emailRaw.ok === true &&
        typeof emailRaw.runId === "string"
      ) {
        await resolveHookRunReply({
          runId: emailRaw.runId,
          sessionKey: emailSessionKey,
        });
      }
      sent.push(recipient);
    } catch (err) {
      failed.push({ recipient, error: err.message });
    }
  }

  const skippedMissingInSheet = missingNames.filter((name) => {
    const matched = uniqueRecipients.some(
      (recipient) => normalizeName(recipient.name) === normalizeName(name),
    );
    return !matched;
  });

  const summary = {
    date: timesheet.date,
    todayColumn: timesheet.todayColumn,
    timesheetsMissingCount: missingNames.length,
    recipientCount: uniqueRecipients.length,
    sentCount: sent.length,
    failedCount: failed.length,
    dryRun,
    recipients: uniqueRecipients,
    skippedMissingInSheet,
    failures: failed,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
