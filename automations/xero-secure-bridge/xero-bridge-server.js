const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const {
  deleteOauthPendingState,
  loadOauthPendingState,
  loadTokenPayload,
  saveTokenPayload,
} = require("./token-store");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function constantTimeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function assertValidPort(value, envName) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${envName} must be a valid port`);
  }
}

function assertLoopbackHost(host) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("XERO_BRIDGE_HOST must be localhost or 127.0.0.1");
  }
}

function assertUuid(value, label) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a valid UUID`);
  }
}

function getScopes() {
  const raw = process.env.XERO_SCOPES;
  if (raw && raw.trim()) {
    return raw
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [
    "offline_access",
    "accounting.transactions.read",
    "accounting.contacts.read",
  ];
}

async function exchangeCodeForToken({
  clientId,
  clientSecret,
  redirectUri,
  code,
  verifier,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body,
  });

  const token = await res.json();
  if (!res.ok) {
    const detail =
      token && typeof token === "object"
        ? JSON.stringify(token)
        : String(token);
    throw new Error(`Token exchange failed: ${res.status} ${detail}`);
  }
  return token;
}

async function completeOauthCallback({ code, state }) {
  const pending = loadOauthPendingState();
  if (!pending) {
    throw new Error("No pending OAuth state. Run xero:auth first.");
  }

  if (!pending.state || !pending.verifier || !pending.redirectUri) {
    throw new Error("Pending OAuth state is invalid. Run xero:auth again.");
  }

  const now = Date.now();
  if (!pending.expires_at || now > Number(pending.expires_at)) {
    deleteOauthPendingState();
    throw new Error("Pending OAuth state expired. Run xero:auth again.");
  }

  if (!constantTimeEqual(String(state || ""), String(pending.state))) {
    throw new Error("Invalid OAuth state");
  }

  const clientId = requireEnv("XERO_CLIENT_ID");
  const clientSecret = requireEnv("XERO_CLIENT_SECRET");
  const tenantId =
    typeof pending.tenantId === "string" && pending.tenantId.trim()
      ? pending.tenantId.trim()
      : requireEnv("XERO_TENANT_ID");
  const scopes =
    Array.isArray(pending.scopes) && pending.scopes.length > 0
      ? pending.scopes
      : getScopes();

  const token = await exchangeCodeForToken({
    clientId,
    clientSecret,
    redirectUri: pending.redirectUri,
    code,
    verifier: pending.verifier,
  });

  const expiresAt = now + Number(token.expires_in || 0) * 1000;
  saveTokenPayload({
    tenantId,
    scope: token.scope || scopes.join(" "),
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type,
    expires_at: expiresAt,
    updated_at: now,
  });

  deleteOauthPendingState();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const json = raw ? JSON.parse(raw) : {};
        resolve({ raw, json });
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function refreshTokenIfNeeded(state) {
  const now = Date.now();
  if (!state.refresh_token) {
    throw new Error("Missing refresh token. Run xero:auth again.");
  }

  if (state.expires_at && state.expires_at - now > 5 * 60 * 1000) {
    return state;
  }

  const clientId = requireEnv("XERO_CLIENT_ID");
  const clientSecret = requireEnv("XERO_CLIENT_SECRET");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refresh_token,
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body,
  });

  const token = await res.json();
  if (!res.ok) {
    const detail =
      token && typeof token === "object"
        ? JSON.stringify(token)
        : String(token);
    throw new Error(`Token refresh failed: ${res.status} ${detail}`);
  }

  const updated = {
    ...state,
    access_token: token.access_token,
    refresh_token: token.refresh_token || state.refresh_token,
    token_type: token.token_type || state.token_type,
    scope: token.scope || state.scope,
    expires_at: now + Number(token.expires_in || 0) * 1000,
    updated_at: now,
  };
  saveTokenPayload(updated);
  return updated;
}

async function xeroApiRequest({
  state,
  path,
  method = "GET",
  query = {},
  body,
}) {
  const tokenState = await refreshTokenIfNeeded(state);
  const url = new URL(`https://api.xero.com${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${tokenState.access_token}`,
      "xero-tenant-id": tokenState.tenantId,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object"
        ? JSON.stringify(parsed)
        : String(parsed);
    throw new Error(`Xero API error ${res.status}: ${detail}`);
  }
  return parsed;
}

async function handleAction(action, params, state) {
  switch (action) {
    case "list_overdue_invoices": {
      const limit = Number.isInteger(params.limit)
        ? Math.min(params.limit, 100)
        : 25;
      const daysPastDue = Number.isInteger(params.daysPastDue)
        ? Math.max(params.daysPastDue, 0)
        : 0;
      const where =
        daysPastDue > 0
          ? `Type==\"ACCREC\"&&AmountDue>0&&DueDate<=DateTime.UtcNow.Date.AddDays(-${daysPastDue})`
          : 'Type=="ACCREC"&&AmountDue>0&&DueDate<DateTime.UtcNow.Date';
      return xeroApiRequest({
        state,
        path: "/api.xro/2.0/Invoices",
        query: {
          where,
          order: "DueDate ASC",
          page: 1,
          summaryOnly: false,
          unitdp: 2,
        },
      }).then((result) => ({
        invoices: Array.isArray(result?.Invoices)
          ? result.Invoices.slice(0, limit)
          : [],
      }));
    }

    case "list_unpaid_bills": {
      const limit = Number.isInteger(params.limit)
        ? Math.min(params.limit, 100)
        : 25;
      return xeroApiRequest({
        state,
        path: "/api.xro/2.0/Invoices",
        query: {
          where: 'Type=="ACCPAY"&&AmountDue>0',
          order: "DueDate ASC",
          page: 1,
          summaryOnly: false,
          unitdp: 2,
        },
      }).then((result) => ({
        bills: Array.isArray(result?.Invoices)
          ? result.Invoices.slice(0, limit)
          : [],
      }));
    }

    case "get_contact": {
      const contactId =
        typeof params.contactId === "string" ? params.contactId.trim() : "";
      const email = typeof params.email === "string" ? params.email.trim() : "";
      const contactNumber =
        typeof params.contactNumber === "string"
          ? params.contactNumber.trim()
          : "";
      if (!contactId && !email && !contactNumber) {
        throw new Error(
          "get_contact requires contactId, email, or contactNumber",
        );
      }

      let where = "";
      if (contactId) {
        assertUuid(contactId, "contactId");
        where = `ContactID==Guid(\"${contactId}\")`;
      } else if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new Error("email must be valid");
        }
        where = `EmailAddress==\"${email}\"`;
      } else {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(contactNumber)) {
          throw new Error(
            "contactNumber must use [a-zA-Z0-9._-] and be <= 64 chars",
          );
        }
        where = `ContactNumber==\"${contactNumber}\"`;
      }

      return xeroApiRequest({
        state,
        path: "/api.xro/2.0/Contacts",
        query: { where, page: 1 },
      }).then((result) => ({
        contacts: Array.isArray(result?.Contacts) ? result.Contacts : [],
      }));
    }

    default:
      throw new Error("Unsupported action");
  }
}

function verifyHmacIfEnabled(headers, rawBody) {
  const secret = process.env.OPENCLAW_BRIDGE_HMAC_SECRET;
  if (!secret || !secret.trim()) {
    return;
  }

  const timestamp = headers["x-timestamp"] || "";
  const signature = headers["x-signature"] || "";
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    throw new Error("Missing or invalid x-timestamp");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 300) {
    throw new Error("Stale request timestamp");
  }

  const data = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("hex");
  if (!constantTimeEqual(expected, signature)) {
    throw new Error("Invalid request signature");
  }
}

async function main() {
  const host = (process.env.XERO_BRIDGE_HOST || "127.0.0.1").trim();
  const port = Number(process.env.XERO_BRIDGE_PORT || 8790);
  const redirectUri = new URL(requireEnv("XERO_REDIRECT_URI"));
  const callbackPath = redirectUri.pathname;
  const bridgeToken = requireEnv("OPENCLAW_BRIDGE_TOKEN");
  const requestsPerMinute = Number(
    process.env.XERO_BRIDGE_RATE_LIMIT_PER_MIN || 60,
  );
  const requestCounters = new Map();

  assertLoopbackHost(host);
  assertValidPort(port, "XERO_BRIDGE_PORT");
  if (
    !Number.isFinite(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    requestsPerMinute > 1000
  ) {
    throw new Error(
      "XERO_BRIDGE_RATE_LIMIT_PER_MIN must be between 1 and 1000",
    );
  }

  const isRateLimited = (ip) => {
    const now = Date.now();
    const key = String(ip || "unknown");
    const entry = requestCounters.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      requestCounters.set(key, { windowStart: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > requestsPerMinute;
  };

  const server = http.createServer(async (req, res) => {
    const finish = (status, payload) => {
      const body = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(body);
    };

    try {
      if (req.method === "GET" && req.url === "/health") {
        finish(200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const reqUrl = new URL(
          req.url || "/",
          `http://${req.headers.host || "127.0.0.1"}`,
        );
        if (reqUrl.pathname === callbackPath) {
          const code = reqUrl.searchParams.get("code") || "";
          const state = reqUrl.searchParams.get("state") || "";
          const oauthError = reqUrl.searchParams.get("error") || "";

          if (oauthError) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end(`Xero authorization failed: ${oauthError}`);
            return;
          }

          if (!code || !state) {
            res.statusCode = 400;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Missing code/state in callback");
            return;
          }

          await completeOauthCallback({ code, state });
          res.statusCode = 200;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Xero authorization complete. You can close this tab.");
          return;
        }
      }

      if (req.method !== "POST" || req.url !== "/xero/query") {
        finish(404, { error: "Not found" });
        return;
      }

      if (isRateLimited(req.socket.remoteAddress)) {
        finish(429, { error: "Rate limit exceeded" });
        return;
      }

      const contentType = String(
        req.headers["content-type"] || "",
      ).toLowerCase();
      if (!contentType.startsWith("application/json")) {
        finish(415, { error: "content-type must be application/json" });
        return;
      }

      const authHeader = req.headers.authorization || "";
      if (!authHeader.startsWith("Bearer ")) {
        finish(401, { error: "Unauthorized" });
        return;
      }

      const token = authHeader.slice("Bearer ".length).trim();
      if (!constantTimeEqual(token, bridgeToken)) {
        finish(403, { error: "Forbidden" });
        return;
      }

      const { raw, json } = await readJsonBody(req);
      verifyHmacIfEnabled(req.headers, raw);

      const action = typeof json.action === "string" ? json.action.trim() : "";
      const params =
        json.params && typeof json.params === "object" ? json.params : {};
      if (!action) {
        finish(400, { error: "Missing action" });
        return;
      }

      const tokenState = loadTokenPayload();
      if (!tokenState) {
        finish(412, { error: "Xero is not authorized. Run xero:auth first." });
        return;
      }

      const data = await handleAction(action, params, tokenState);
      finish(200, { ok: true, action, data });
    } catch (err) {
      const message =
        err && err.message ? String(err.message) : "Request failed";
      if (
        message.startsWith("Token exchange failed") ||
        message.startsWith("Xero API error") ||
        message.startsWith("Token refresh failed")
      ) {
        finish(502, { error: "Upstream Xero request failed" });
        return;
      }
      finish(400, { error: message });
    }
  });

  server.listen(port, host, () => {
    console.log(`xero-secure-bridge listening on http://${host}:${port}`);
  });
}

main().catch((err) => {
  console.error(`xero-bridge-server failed: ${err.message}`);
  process.exit(1);
});
