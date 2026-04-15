# uxinspect-keys-worker

Cloudflare Worker behind `keys.uxinspect.com` that signs and verifies
uxinspect Pro license keys. The Free MIT CLI never calls this Worker;
only Pro features invoke `verifyLicense()` from `src/license.ts`.

## Endpoints

| Method | Path              | Purpose                                                      |
| ------ | ----------------- | ------------------------------------------------------------ |
| POST   | `/verify`         | `{key, machineId}` → Ed25519-signed JWT with plan + expiry   |
| POST   | `/polar/webhook`  | Polar.sh subscription lifecycle events; updates KV           |
| GET    | `/pubkey`         | Returns the current SPKI PEM (used by clients for rotation)  |

### POST /verify

Request body:

```json
{ "key": "UX-XXXX-XXXX-XXXX", "machineId": "stable-machine-id" }
```

Successful response:

```json
{
  "valid": true,
  "plan": "pro",
  "machineId": "stable-machine-id",
  "expiresAt": 1745174400,
  "jwt": "<header>.<payload>.<ed25519 sig>",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n..."
}
```

Failure responses return `{ "valid": false, "reason": "<code>" }`.
Reason codes: `invalid_json`, `missing_key`, `missing_machine_id`,
`field_too_long`, `unknown_key`, `corrupt_record`, `expired`,
`status_cancelled`, `status_past_due`, `status_expired`,
`signing_key_unavailable`.

The signed JWT payload is:

```ts
{
  sub: "<license key>",
  machineId: "<machine id>",
  plan: "pro" | "team" | "enterprise",
  customer: "<polar customer id or email>",
  iat: <unix seconds>,
  exp: <unix seconds>, // clamped to subscription expiry
  iss: "https://keys.uxinspect.com",
  subscriptionExpiresAt: <unix seconds>
}
```

### POST /polar/webhook

Incoming Polar.sh events are HMAC-verified against `POLAR_SECRET`.
Supported event types:

- `subscription.created`
- `subscription.updated`
- `subscription.canceled` / `subscription.cancelled`

Events **must** carry `data.metadata.license_key` (or `licenseKey`).
Generate the license key when the customer checks out and attach it to
the Polar checkout session metadata.

### GET /pubkey

Returns the PEM from `PUBLIC_KEY` var. Cached `max-age=3600`. Clients
pin the bundled key for offline verification; this endpoint exists for
rotation bootstrapping.

## One-time setup

1. **Create the KV namespace**

   ```sh
   wrangler kv namespace create LICENSES
   wrangler kv namespace create LICENSES --preview
   ```

   Paste the returned IDs into `wrangler.toml` under `[[kv_namespaces]]`.

2. **Generate an Ed25519 keypair**

   ```sh
   # Generate PKCS#8 private key (what the Worker signs with)
   openssl genpkey -algorithm ed25519 -out ed25519-private.pem

   # Derive the SPKI public key (what clients verify with)
   openssl pkey -in ed25519-private.pem -pubout -out ed25519-public.pem
   ```

3. **Load the private key as a secret**

   ```sh
   wrangler secret put PRIVATE_KEY < ed25519-private.pem
   ```

4. **Set the public key + issuer + TTL in wrangler.toml**

   Paste `ed25519-public.pem` contents (including the BEGIN/END lines)
   into the `PUBLIC_KEY` var. Leave `JWT_ISSUER` as
   `https://keys.uxinspect.com` unless you are running a staging
   instance.

5. **Load the Polar HMAC secret**

   In Polar.sh → project → Webhooks, copy the signing secret, then:

   ```sh
   wrangler secret put POLAR_SECRET
   ```

6. **Deploy**

   ```sh
   npm install
   npm test
   npx wrangler deploy
   ```

## Polar.sh webhook configuration

- Webhook URL: `https://keys.uxinspect.com/polar/webhook`
- Events: `subscription.created`, `subscription.updated`,
  `subscription.canceled`
- Required metadata on every checkout session:

  ```json
  { "license_key": "UX-XXXX-XXXX-XXXX" }
  ```

Generate the license key server-side at checkout (e.g. in the
`dashboard` Worker), then pass it to Polar as session metadata. The
same key is emailed to the customer for use with
`uxinspect license activate`.

## Key rotation

Goal: rotate the Ed25519 signing key without invalidating any
currently-cached client JWTs (30d cache window).

1. Generate a new keypair (`*-v2.pem`).
2. Ship a CLI release that bundles **both** the old and new public
   keys (client accepts either).
3. Wait one full cache window + offline-grace window (≥ 45 days).
4. `wrangler secret put PRIVATE_KEY < ed25519-private-v2.pem`.
5. Update `PUBLIC_KEY` var in `wrangler.toml` to the v2 key.
6. `wrangler deploy`.
7. Next CLI release drops the old v1 public key.

Never rotate in one step — cached JWTs signed by v1 would fail
verification until the cache expires.

## Local development

```sh
npm install
npm run dev          # wrangler dev with in-memory KV
npm test             # vitest: verify endpoint + polar webhook + pubkey
npm run deploy:dry   # wrangler deploy --dry-run
```

KV contents can be seeded locally via `wrangler kv key put --binding=LICENSES ...`.
