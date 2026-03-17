const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function getTokenFilePath() {
  return process.env.XERO_TOKEN_FILE || "/home/alex/.openclaw/xero-token.enc";
}

function getOauthStateFilePath() {
  return (
    process.env.XERO_OAUTH_STATE_FILE ||
    "/home/alex/.openclaw/xero-oauth-state.enc"
  );
}

function getEncryptionKey() {
  const keyB64 = process.env.XERO_ENCRYPTION_KEY || "";
  if (!keyB64.trim()) {
    throw new Error("XERO_ENCRYPTION_KEY is required");
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error("XERO_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function encryptJson(payload) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function decryptJson(serialized) {
  const key = getEncryptionKey();
  const parsed = JSON.parse(serialized);
  if (!parsed || parsed.v !== 1 || parsed.alg !== "aes-256-gcm") {
    throw new Error("Unsupported token file format");
  }

  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function saveTokenPayload(payload) {
  saveEncryptedJson(getTokenFilePath(), payload);
}

function loadTokenPayload() {
  return loadEncryptedJson(getTokenFilePath());
}

function saveOauthPendingState(payload) {
  saveEncryptedJson(getOauthStateFilePath(), payload);
}

function loadOauthPendingState() {
  return loadEncryptedJson(getOauthStateFilePath());
}

function deleteOauthPendingState() {
  deleteEncryptedFile(getOauthStateFilePath());
}

function saveEncryptedJson(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = encryptJson(payload);
  fs.writeFileSync(filePath, body, { mode: 0o600 });
}

function loadEncryptedJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const body = fs.readFileSync(filePath, "utf8");
  return decryptJson(body);
}

function deleteEncryptedFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  deleteOauthPendingState,
  getOauthStateFilePath,
  loadTokenPayload,
  loadOauthPendingState,
  saveOauthPendingState,
  saveTokenPayload,
};
