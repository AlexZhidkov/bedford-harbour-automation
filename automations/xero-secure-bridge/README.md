# Xero Secure Bridge

Secure local bridge that lets OpenClaw access Xero with strict controls:

- OAuth 2.0 Authorization Code + PKCE
- Encrypted token-at-rest (AES-256-GCM)
- Short-lived bearer auth for OpenClaw -> bridge calls
- Optional HMAC request signing + replay window checks
- Action allowlist (no free-form URL passthrough)

## 1) Setup

1. Install root dependencies:
   - `npm install`
2. Copy values from `.env.example` into your VM env file (`/home/alex/.openclaw/.env`).
3. In Xero developer portal, set redirect URI to exactly `XERO_REDIRECT_URI`.
4. Generate secrets:
   - Encryption key: `openssl rand -base64 32`
   - Bridge token: `openssl rand -hex 32`
   - Optional HMAC secret: `openssl rand -hex 32`

## 2) Authorize Xero once

Before starting auth, ensure the bridge callback endpoint is reachable from the internet over HTTPS (for example via Tailscale Funnel).

Example with Funnel (run on the VM):

- `sudo tailscale funnel 8790`

Then set `XERO_REDIRECT_URI` to the public callback URL in your Xero app settings, for example:

- `https://your-node.your-tailnet.ts.net/xero/callback`

Run:

- `npm run xero:auth`

The script prints an authorization URL and stores encrypted pending OAuth state (PKCE verifier + state) on disk for 15 minutes.

Share that authorization URL with your client. After they approve in Xero, Xero redirects to your bridge callback endpoint, and the bridge exchanges the code for tokens automatically.

Successful callback writes encrypted token material to `XERO_TOKEN_FILE`.

## 3) Start bridge service

Run:

- `npm run xero:serve`

The server listens on `XERO_BRIDGE_HOST:XERO_BRIDGE_PORT`.

## 4) Call contract (from OpenClaw hook/tool)

Endpoint:

- `POST /xero/query`

Headers:

- `authorization: Bearer <OPENCLAW_BRIDGE_TOKEN>`
- `content-type: application/json`
- Optional HMAC mode:
  - `x-timestamp: <unix seconds>`
  - `x-signature: <hex hmac sha256>` over `${x-timestamp}.${rawBody}`

Body:

```json
{
  "action": "list_overdue_invoices",
  "params": {
    "daysPastDue": 7,
    "limit": 25
  }
}
```

Supported actions:

- `list_overdue_invoices`
- `list_unpaid_bills`
- `get_contact`

## Security notes

- Keep the bridge bound to loopback (`127.0.0.1`) unless you add network ACLs and TLS.
- The server enforces loopback host binding and JSON-only requests.
- Basic request rate limiting is enabled (`XERO_BRIDGE_RATE_LIMIT_PER_MIN`, default `60`).
- Callback security relies on OAuth state + PKCE verification and a short-lived pending state file (`XERO_OAUTH_STATE_FILE`).
- Never commit env files or token files.
- Rotate `OPENCLAW_BRIDGE_TOKEN` and `OPENCLAW_BRIDGE_HMAC_SECRET` regularly.
- If you suspect compromise, revoke Xero app tokens and rerun `npm run xero:auth`.
