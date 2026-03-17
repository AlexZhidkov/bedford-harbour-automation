const crypto = require("node:crypto");
const { URL } = require("node:url");
const {
  getOauthStateFilePath,
  saveOauthPendingState,
} = require("./token-store");

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

async function run() {
  const clientId = requireEnv("XERO_CLIENT_ID");
  requireEnv("XERO_CLIENT_SECRET");
  const redirectUri = requireEnv("XERO_REDIRECT_URI");
  const tenantId = requireEnv("XERO_TENANT_ID");
  const redirect = new URL(redirectUri);

  if (!["http:", "https:"].includes(redirect.protocol)) {
    throw new Error("XERO_REDIRECT_URI must use http:// or https://");
  }
  if (
    redirect.protocol === "http:" &&
    redirect.hostname !== "127.0.0.1" &&
    redirect.hostname !== "localhost"
  ) {
    throw new Error(
      "http:// redirect URIs must use localhost or 127.0.0.1; use https:// for remote callback",
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

  const now = Date.now();
  const expiresAt = now + 15 * 60 * 1000;
  saveOauthPendingState({
    created_at: now,
    expires_at: expiresAt,
    state,
    verifier,
    tenantId,
    redirectUri,
    scopes,
  });

  console.log("Open this URL in your browser and approve access:");
  console.log(authorizeUrl.toString());
  console.log("");
  console.log("Bridge callback target:");
  console.log(`${redirect.origin}${redirect.pathname}`);
  console.log("");
  console.log(
    `Pending OAuth state saved to ${getOauthStateFilePath()} and expires in 15 minutes.`,
  );
  console.log(
    "Make sure xero:serve is running and your redirect URI routes to this bridge endpoint.",
  );
}

run().catch((err) => {
  console.error(`xero-auth-init failed: ${err.message}`);
  process.exit(1);
});
