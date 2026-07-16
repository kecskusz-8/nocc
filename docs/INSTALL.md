# Installing NOCC

*This describes the current design, written before the code. Specifics may still change; see [Status](README.md#status) in the main README.*

This is the user-facing walkthrough. If you want the technical reference instead, see [`extension/README.md`](extension/README.md) and [`server/README.md`](server/README.md).

## 1. Install the extension from source

There's no store listing. You load it directly from the source, which also means you can read every line before you trust it.

1. Clone the repo:
   ```bash
   git clone https://github.com/nocc-project/nocc.git
   ```
2. **Chrome / Brave / Edge:**
   - Go to `chrome://extensions`
   - Toggle **Developer mode** on (top right)
   - Click **Load unpacked**, then select the `nocc/extension` folder
3. **Firefox:**
   - Go to `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on**, then select `nocc/extension/manifest.json`
4. Open the chat platform you're using NOCC with (or reload the tab if it was already open).

That's it. No account, no signup, no config screen to get through.

Once the extension is loaded, open the popup by clicking the NOCC icon — it will auto-discover any hooks in `extension/hooks/` and show which ones are active. To add a hook for your chat platform, see [`HOOKS.md`](HOOKS.md).

## 2. Connecting to the relay server

By default, the extension is already pointed at a default community relay, so this step is done for you. Any two people running NOCC with default settings can talk to each other encrypted immediately.

If you'd rather not trust the default relay, which is entirely reasonable since someone else runs it, skip to step 3 and self-host your own.

## 3. Self-hosting your own relay (5-minute version)

You need a machine that can run Node.js and stay reachable, plus a PostgreSQL instance (a $5/month VPS with Postgres installed locally is plenty; see [`DEPLOY.md`](DEPLOY.md) for real deployment options with systemd, Cloudflare Tunnel, etc.). For a quick local/LAN test:

```bash
cd nocc/server
npm install
createdb nocc
SALT=$(openssl rand -hex 32) \
DATABASE_URL=postgres://localhost:5432/nocc \
node index.js
```

No manual table creation needed, the relay creates `known_users` itself through the ORM the first time it connects.

Note the `SALT` value you generated. You'll need to give it to everyone using this relay. Save it somewhere; it's not shown again automatically.

For a real deployment (public reachability, TLS, restart-on-boot), follow [`DEPLOY.md`](DEPLOY.md). The above is enough to confirm everything works end-to-end before you commit to running it long-term.

## 4. Pointing the extension at your custom relay

1. Open the NOCC extension's settings.
2. Set:
   - **Relay URL**, e.g. `wss://relay.yourdomain.com` (use `wss://`, not `ws://`, for anything beyond local testing; see [`DEPLOY.md`](DEPLOY.md))
   - **Salt**, the exact `SALT` value your relay is running with
   - **Pepper**, if your relay set one, the exact `PEPPER` value (leave blank if it didn't)
3. Save. Reload any open tabs for the chat platform you're using.

Everyone you want to talk to on this relay needs the same three values. Mismatched salt/pepper means your hashed UIDs never line up, and the handshake will just hang. See [Troubleshooting](extension/README.md#troubleshooting).

## 5. Verifying encryption is working

1. DM another NOCC user (on the same relay, default or custom).
2. Send a message. Watch for the extension's encryption indicator to confirm keys have been exchanged for this conversation.
3. To actually confirm the message left your browser encrypted, not just trust the extension's own status display: open your browser's **Network** tab (DevTools) before sending, watch the outgoing request to the platform's message API, and confirm the message body is ciphertext, not your plaintext.
4. On the receiving end, the message should render as normal readable text, decrypted client-side, in place, by the extension.
5. If you want to see it fail safely: message someone *not* running NOCC. It should send as a normal, unencrypted message, with no encryption indicator and no ciphertext. NOCC only encrypts when both sides have it.

If the encryption indicator never appears, see [Troubleshooting](extension/README.md#troubleshooting) in the extension docs.
