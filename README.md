# jp-relay — KamuiDash Tokyo node (30-day trial)

VLESS+WS node as a plain Node.js app, because KamuiDash deploys only
Node.js / Go / Python / Ruby apps from a GitHub repo — no Dockerfile,
no arbitrary-binary entry. `server.js` (stdlib only) downloads the
official xray-core release at runtime, writes its config from env vars,
starts xray on an internal port, and fronts `$PORT` itself: 200 on `/`
and `/healthz`, WebSocket upgrades forwarded byte-for-byte to xray.

## KamuiDash dashboard settings

| Setting | Value |
| --- | --- |
| Runtime | Web server / Node.js |
| Repository + branch | this repo, `main` |
| Setup | `npm ci` |
| Start | `npm run start` |
| Health check | `/healthz` |
| Env vars | `XRAY_UUID`, `WS_PATH` (dashboard only — never commit secrets) |

`$PORT` is supplied by the platform. TLS ends at the KamuiDash gateway;
xray sees plain WS internally.

## GitHub App access

Grant the KamuiDash GitHub App access to **only this repository**
(not "all repositories"). After granting, verify the repo shows up in
the KamuiDash dashboard repo picker before creating the app.

## Trial limits (verified 2026-11-21)

256Mi RAM / 200m CPU / 500Mi disk, 10 GiB outbound/month, always-on,
Tokyo only. Expiry = suspension, not auto-billing, unless a card with
auto-upgrade is registered. No card was needed at registration.

## If WS breaks

Per the deployment methodology: if the gateway breaks WS twice (400 /
disconnect after 101 / H2 downgrade), switch the xray inbound to
VLESS+XHTTP (packet-up) and lock ALPN — do not keep retrying WS.

## Local test

```sh
XRAY_UUID=<test-uuid> WS_PATH=/testpath PORT=18081 node server.js
curl -s http://127.0.0.1:18081/healthz   # {"ok":true}
```
