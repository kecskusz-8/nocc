# Deploying the NOCC Relay

*This describes the current design, written before the code. Specifics may still change; see [Status](README.md#status) in the main README.*

The relay is a single Node.js process plus a small PostgreSQL database holding one table. This guide covers everything from a quick VPS setup to Docker to a proper systemd + Cloudflare Tunnel deployment.

Remember: this is designed for small trusted groups, not public internet scale. Read [Scaling considerations](#scaling-considerations) before overbuilding this.

## Deploying to a VPS (DigitalOcean, Hetzner, AWS, etc.)

Any $5/month VPS is overkill for the relay's actual resource needs. Steps are the same regardless of provider:

1. Spin up a small instance (1 vCPU / 1GB RAM is plenty). Ubuntu or Debian recommended.
2. SSH in, install Node.js 18+ and PostgreSQL:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs postgresql
   ```
3. Create a database and the one table the relay needs:
   ```bash
   sudo -u postgres createdb nocc
   sudo -u postgres psql nocc -c "CREATE TABLE known_users (uid_hash TEXT PRIMARY KEY, first_seen TIMESTAMPTZ NOT NULL DEFAULT now());"
   ```
4. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/nocc-project/nocc.git
   cd nocc/server
   npm install --production
   ```
5. Generate a `SALT` and store it somewhere safe. You'll need to share it with users, and you don't want to lose it:
   ```bash
   openssl rand -hex 32
   ```
6. Run it. See [systemd](#systemd-service) below for keeping it running persistently, rather than just `node index.js` in a terminal you'll eventually close.

## Docker deployment

**Dockerfile** (`server/Dockerfile`):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

**docker-compose.yml:**

```yaml
services:
  nocc-relay:
    build: ./server
    restart: unless-stopped
    depends_on:
      - db
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - SALT=${NOCC_SALT}
      - PEPPER=${NOCC_PEPPER}
      - DATABASE_URL=postgres://nocc:${NOCC_DB_PASSWORD}@db:5432/nocc

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=nocc
      - POSTGRES_PASSWORD=${NOCC_DB_PASSWORD}
      - POSTGRES_DB=nocc
    volumes:
      - nocc-db-data:/var/lib/postgresql/data
      - ./server/init.sql:/docker-entrypoint-initdb.d/init.sql

volumes:
  nocc-db-data:
```

`server/init.sql` just needs the one table:

```sql
CREATE TABLE known_users (
  uid_hash   TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Run it:

```bash
NOCC_SALT=$(openssl rand -hex 32) NOCC_DB_PASSWORD=$(openssl rand -hex 16) docker compose up -d
```

Keep `NOCC_SALT`, `NOCC_PEPPER` (if used), and `NOCC_DB_PASSWORD` in a `.env` file that's **not** committed to git.

## Systemd service

For a bare-metal/VPS deployment without Docker, `/etc/systemd/system/nocc-relay.service`:

```ini
[Unit]
Description=NOCC Relay Server
After=network.target postgresql.service

[Service]
Type=simple
User=nocc
WorkingDirectory=/opt/nocc/server
Environment=PORT=3000
Environment=SALT=your-generated-salt-here
Environment=PEPPER=your-generated-pepper-here
Environment=DATABASE_URL=postgres://nocc:your-db-password@localhost:5432/nocc
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Run as a dedicated non-root user (`useradd -r -s /usr/sbin/nologin nocc`), not root. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nocc-relay
sudo systemctl status nocc-relay
```

Consider putting `SALT`/`PEPPER`/`DATABASE_URL` in an `EnvironmentFile=` pointing at a root-only-readable file instead of inline in the unit file, so `systemctl cat` doesn't leak them to anyone who can read unit files.

## Cloudflare Tunnel (reverse proxy + TLS)

Instead of exposing a raw port and managing your own TLS certificates, run the relay behind a Cloudflare Tunnel. `cloudflared` makes an outbound-only connection from your server to Cloudflare, so you don't even need to open an inbound port on your VPS or router, and TLS is handled by Cloudflare's edge automatically.

1. Install `cloudflared` on the relay's machine:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb
   ```
2. Authenticate against your Cloudflare account (opens a browser link to pick a domain):
   ```bash
   cloudflared tunnel login
   ```
3. Create the tunnel and note the tunnel ID it prints:
   ```bash
   cloudflared tunnel create nocc-relay
   ```
4. Create a config file, e.g. `/etc/cloudflared/config.yml`:
   ```yaml
   tunnel: <your-tunnel-id>
   credentials-file: /root/.cloudflared/<your-tunnel-id>.json

   ingress:
     - hostname: relay.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```
5. Route DNS for your hostname to the tunnel:
   ```bash
   cloudflared tunnel route dns nocc-relay relay.yourdomain.com
   ```
6. Run it as a persistent service:
   ```bash
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```

That's it. No open inbound ports, no certificate renewal to manage, and the relay process itself stays bound to `localhost` only, unreachable except through the tunnel. Postgres never needs to be exposed at all; it only talks to the relay process on the same machine or private network.

Point your extension's relay URL at `wss://relay.yourdomain.com`. Cloudflare terminates TLS at its edge and proxies the WebSocket upgrade through to `cloudflared`, which forwards it to the relay on `localhost:3000`. Handshake payloads are already encrypted end-to-end regardless of transport, but running over plain `ws://` would still leave connection metadata and handshake traffic sniffable to anyone on the network path between a client and your server. The tunnel closes that gap without you touching a certificate.

## Monitoring and logging (or the deliberate lack of it)

There's no built-in monitoring or logging beyond whatever your process manager (systemd/Docker) captures by default: stdout, process start/stop, uncaught errors. This is intentional. The relay is designed to know as little as possible, and the database is designed to hold as little as possible: just a flat table of hashed UIDs, no per-connection log, no timing history.

If you want operational visibility (uptime, connection counts) without compromising that principle, keep it aggregate and ephemeral. For example, an in-memory counter exposed on a `/health` endpoint, never anything tied to a specific `uid_hash` or written to disk. Don't bolt on request logging middleware that writes IPs or payloads to a log file, and don't add columns to `known_users` beyond `uid_hash` and `first_seen`. Both would defeat the purpose of the whole project.

## Scaling considerations

NOCC's relay is built for **under 10 concurrent users**: a friend group, a small Discord server. Some honest implications of that:

- Socket.io rooms handle routing per-process. If you run multiple relay instances behind a load balancer, users could land on different instances and never find each other, since rooms aren't shared across processes. Don't put this behind a multi-instance autoscaler without adding a shared adapter (e.g. Socket.io's Redis adapter) first, and if you're doing that, you've outgrown what this project is trying to be.
- A single small VPS with a local Postgres instance can comfortably handle far more than 10 users from a raw resource perspective. The ceiling here is a design choice about trust and scale, not a hard technical limit. NOCC is not trying to be Signal's infrastructure; it's trying to keep a specific small group's conversations unreadable to a specific kind of dragnet.
- The database itself never grows unbounded either: it's one row per hashed UID that has ever registered, nothing per-message and nothing per-connection.
- If your use case is genuinely large-scale, this codebase is a starting point to fork and rearchitect, not a production-ready backend to scale as-is.
