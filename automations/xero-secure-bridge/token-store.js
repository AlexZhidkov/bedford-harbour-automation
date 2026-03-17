const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function getTokenFilePath() {
  return process.env.XERO_TOKEN_FILE || "/home/alex/.openclaw/xero-token.enc";
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
  const tokenFile = getTokenFilePath();
  const dir = path.dirname(tokenFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = encryptJson(payload);
  fs.writeFileSync(tokenFile, body, { mode: 0o600 });
}

function loadTokenPayload() {
  const tokenFile = getTokenFilePath();
  if (!fs.existsSync(tokenFile)) {
    return null;
  }
  const body = fs.readFileSync(tokenFile, "utf8");
  return decryptJson(body);
}

module.exports = {
  loadTokenPayload,
  saveTokenPayload,
};
