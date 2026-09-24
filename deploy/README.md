# Deploying IkelyaneMonitor

Production runs on the cPanel/AlmaLinux server behind **https://monitor.ikelyane.com**:

```
browser / agents ──HTTPS──► Cloudflare (proxied DNS) ──HTTPS──► Apache (cPanel vhost, AutoSSL cert)
                                                                   │ deploy/apache/ssl-proxy.conf
                                                                   ▼
                        ikelyanemonitor-web.service  (next start, 127.0.0.1:3020)
                        ikelyanemonitor-worker.service (scripts/worker.ts)
                                                                   │
                        ikelyanemonitor-prod-db (Docker, TimescaleDB 2.30.1-pg17, 127.0.0.1:5441)
```

| What | Where |
| --- | --- |
| Code (one directory per release, root-owned) | `/opt/ikelyanemonitor/releases/*`, `/opt/ikelyanemonitor/current` → running release |
| Configuration and secrets | `/etc/ikelyanemonitor/app.env` (0640 root:ikelyanemonitor), `/etc/ikelyanemonitor/db.env` (0600, database password) |
| Node.js | `/opt/node-24` (isolated copy; the system `/usr/bin/node` 20 is used by other apps) |
| Service account | `ikelyanemonitor` (system user, no shell, no home) — can write only `.next/cache` |
| Database container | `deploy/docker-compose.prod.yml`, compose project `ikelyanemonitor-prod`, volume `ikelyanemonitor-prod_pgdata` |
| Backups | `/var/backups/ikelyanemonitor/*.dump`, nightly 02:40 (`ikelyanemonitor-backup.timer`), 14 days |
| Apache | `/etc/apache2/conf.d/userdata/{ssl,std}/2_4/ikelyane/monitor.ikelyane.com/*.conf` (copies of `deploy/apache/`) |
| TLS certificate | Let's Encrypt via certbot, DNS validation through the Cloudflare API (`/etc/letsencrypt/cloudflare/ikelyane.ini`); renewed by `certbot-renew.timer`, installed into the cPanel vhost by `/etc/letsencrypt/renewal-hooks/deploy/ikelyanemonitor-cpanel.sh` (copy of `deploy/certbot-deploy-hook.sh`). AutoSSL's HTTP validation fails behind Cloudflare's proxy. |
| DNS | Cloudflare, `A monitor → 144.91.103.251`, proxied |
| Logs | `journalctl -u ikelyanemonitor-web`, `-u ikelyanemonitor-worker`, `-u ikelyanemonitor-backup` |

The development database (`docker-compose.yml`, port 5440) and the working copy in `/root/ikelyanemonitor` are
separate: tests and `npm run build` there never touch production.

## Update

Commit to `main` in `/root/ikelyanemonitor`, then:

```bash
/root/ikelyanemonitor/deploy/deploy.sh          # build a new release, migrate, switch, restart, health-check
/root/ikelyanemonitor/deploy/deploy.sh --rollback   # back to the previous release (migrations stay applied)
```

Only committed code is deployed. Migrations must stay backward compatible with the running release (they run
before the switch).

## First owner account

Registration is closed (`AUTH_ALLOW_REGISTRATION=false`); accounts come by invitation. The first owner:

```bash
cd /opt/ikelyanemonitor/current && set -a && . /etc/ikelyanemonitor/app.env && set +a && \
  /opt/node-24/bin/node node_modules/tsx/dist/cli.mjs scripts/create-owner.ts --email … --name … --org …
```

## Registering an agent

In the web UI: **Servers → Register a server**, then on the monitored host use
`IKELYANE_SERVER_URL=https://monitor.ikelyane.com` (see `agent/README.md`).

## Secrets

`IKELYANE_SECRET_KEY` encrypts the agents' HMAC secrets and SNMP credentials in the database. **Keep a copy of
it off this server.** Without it, a restored database is useless for agents (every host would have to be
re-registered). It is not in the backups on purpose.

## Restore a backup

```bash
systemctl stop ikelyanemonitor-web ikelyanemonitor-worker
docker exec -i ikelyanemonitor-prod-db psql -U ikelyane -d postgres -c 'DROP DATABASE ikelyanemonitor' -c 'CREATE DATABASE ikelyanemonitor'
docker exec -i ikelyanemonitor-prod-db psql -U ikelyane -d ikelyanemonitor -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' -c 'SELECT timescaledb_pre_restore()'
docker exec -i ikelyanemonitor-prod-db pg_restore -U ikelyane -d ikelyanemonitor --no-owner < /var/backups/ikelyanemonitor/<file>.dump
docker exec -i ikelyanemonitor-prod-db psql -U ikelyane -d ikelyanemonitor -c 'SELECT timescaledb_post_restore()'
systemctl start ikelyanemonitor-web ikelyanemonitor-worker
```

## Server specifics

- `deploy.sh` installs the systemd units but NOT the Apache files: after changing `deploy/apache/*`, copy them to
  the paths above, then `/scripts/rebuildhttpdconf && apachectl -t && /scripts/restartsrv_httpd --graceful`.

- **Client IP**: Apache trusts `CF-Connecting-IP` only from Cloudflare's ranges (`ssl-proxy.conf`); if Cloudflare
  publishes new ranges (https://www.cloudflare.com/ips/), update that file. Sign-in throttling depends on it.
- Port 3020 is bound to 127.0.0.1 and not opened in firewalld. Never run `firewall-cmd --reload` on this server.
- Units use `Wants=docker.service` (not `Requires=`): the nightly cPanel update restarts Docker.
- Outgoing e-mail uses the local `/usr/sbin/sendmail` (setgid on cPanel — hence no `NoNewPrivileges=` in the units);
  the sender must stay `@ikelyane.com` (SPF/DKIM).
