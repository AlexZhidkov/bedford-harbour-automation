const crypto = require("node:crypto");
const http = require("node:http");
const { URL } = require("node:url");
const { saveTokenPayload } = require("./token-store");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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

  const json = await res.json();
  if (!res.ok) {
    const detail =
      json && typeof json === "object" ? JSON.stringify(json) : String(json);
    throw new Error(`Token exchange failed: ${res.status} ${detail}`);
  }
  return json;
}

async function run() {
  const clientId = requireEnv("XERO_CLIENT_ID");
  const clientSecret = requireEnv("XERO_CLIENT_SECRET");
  const redirectUri = requireEnv("XERO_REDIRECT_URI");
  const tenantId = requireEnv("XERO_TENANT_ID");
  const callbackPort = Number(process.env.XERO_OAUTH_CALLBACK_PORT || 8787);
  const redirect = new URL(redirectUri);

  if (
    !Number.isInteger(callbackPort) ||
    callbackPort < 1 ||
    callbackPort > 65535
  ) {
    throw new Error("XERO_OAUTH_CALLBACK_PORT must be a valid port");
  }

  if (redirect.protocol !== "http:") {
    throw new Error("XERO_REDIRECT_URI must use http:// for local callback");
  }
  if (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") {
    throw new Error("XERO_REDIRECT_URI must use localhost or 127.0.0.1");
  }
  if (redirect.port !== String(callbackPort)) {
    throw new Error(
      "XERO_REDIRECT_URI port must match XERO_OAUTH_CALLBACK_PORT",
    );
  }

  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  const state = base64Url(crypto.randomBytes(24));
  const scopes = getScopes();

  const authorizeUrl = new URL(
    "https://login.xero.com/identity/connect/authorize",
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  console.log("Open this URL in your browser and approve access:");
  console.log(authorizeUrl.toString());
  console.log("");
  console.log(
    `Listening for callback on ${redirect.origin}${redirect.pathname} ...`,
  );

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(
          req.url || "/",
          `http://127.0.0.1:${callbackPort}`,
        );
        if (reqUrl.pathname !== redirect.pathname) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const incomingState = reqUrl.searchParams.get("state") || "";
        const incomingCode = reqUrl.searchParams.get("code") || "";
        if (!incomingCode || incomingState !== state) {
          res.statusCode = 400;
          res.end("Invalid callback");
          server.close();
          reject(new Error("Invalid callback state/code"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Xero authorization complete. You can close this tab.");
        server.close();
        resolve(incomingCode);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.on("error", reject);
    server.listen(callbackPort, "127.0.0.1");
  });

  const token = await exchangeCodeForToken({
    clientId,
    clientSecret,
    redirectUri,
    code,
    verifier,
  });

  const now = Date.now();
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

  console.log("Xero token saved (encrypted).");
}

run().catch((err) => {
  console.error(`xero-auth-init failed: ${err.message}`);
  process.exit(1);
});
