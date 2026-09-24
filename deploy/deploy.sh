#!/usr/bin/env bash
# Deploy (first install or update) IkelyaneMonitor on this server. Run as root.
#
#   deploy/deploy.sh [SOURCE_REPO] [REF]        # defaults: /root/ikelyanemonitor main
#   deploy/deploy.sh --rollback                 # switch back to the previous release
#
# Each deployment is built in its own directory, next to the running one:
#   /opt/ikelyanemonitor/releases/<date>-<commit>/   (code: root-owned, read-only for the service)
#   /opt/ikelyanemonitor/current -> releases/…       (what systemd runs)
# then database migrations run, `current` switches, and the services restart — the site is only down
# for the restart itself. The last KEEP releases stay for --rollback.
#
# Configuration and secrets never live in the code: /etc/ikelyanemonitor/app.env (see deploy/README.md).
set -euo pipefail

BASE=/opt/ikelyanemonitor
RELEASES=$BASE/releases
KEEP=3
SERVICE_USER=ikelyanemonitor
UNITS=(ikelyanemonitor-web.service ikelyanemonitor-worker.service)
HEALTH_URL=http://127.0.0.1:3020/en/login
export PATH=/opt/node-24/bin:$PATH

log() { printf '\n== %s\n' "$*"; }

wait_healthy() {
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
    [ "$code" = 200 ] && return 0
    sleep 1
  done
  echo "the web app did not answer 200 on $HEALTH_URL (last: $code) — see: journalctl -u ikelyanemonitor-web -n 50" >&2
  return 1
}

restart_services() {
  systemctl restart "${UNITS[@]}"
  wait_healthy
  systemctl is-active --quiet ikelyanemonitor-worker || { echo "worker not running — journalctl -u ikelyanemonitor-worker" >&2; return 1; }
}

if [ "${1:-}" = "--rollback" ]; then
  current=$(readlink -f "$BASE/current")
  previous=$(ls -1d "$RELEASES"/*/ | sed 's:/$::' | grep -vxF "$current" | sort | tail -n 1 || true)
  [ -n "$previous" ] || { echo "no previous release to roll back to" >&2; exit 1; }
  log "rolling back to $(basename "$previous") (database migrations are NOT reverted)"
  ln -sfn "$previous" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
  restart_services
  echo "rolled back: $(basename "$previous")"
  exit 0
fi

SRC=${1:-/root/ikelyanemonitor}
REF=${2:-main}
[ -r /etc/ikelyanemonitor/app.env ] || { echo "/etc/ikelyanemonitor/app.env is missing (deploy/README.md)" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null

commit=$(git -C "$SRC" rev-parse --short "$REF")
release="$RELEASES/$(date -u +%Y%m%d%H%M%S)-$commit"
log "building $commit into $release"
install -d -m 755 "$BASE" "$RELEASES"
git clone --quiet --no-hardlinks "$SRC" "$release"
git -C "$release" -c advice.detachedHead=false checkout --quiet "$commit"
rm -r -- "$release/.git"
cd "$release"

# Build-time and migration settings come from the same file systemd uses.
set -a
# shellcheck disable=SC1091
. /etc/ikelyanemonitor/app.env
set +a
export NODE_ENV=production

# Dev dependencies are needed to build (and tsx runs the worker).
NODE_ENV=development npm ci --no-audit --no-fund --loglevel=error
npm run build
log "database migrations"
npx prisma migrate deploy

# The service may only write Next.js's cache.
chown -R root:root "$release"
chmod -R go-w "$release"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 .next/cache
chown -R "$SERVICE_USER:$SERVICE_USER" .next/cache

log "systemd units"
install -m 644 deploy/systemd/ikelyanemonitor-*.service deploy/systemd/ikelyanemonitor-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet "${UNITS[@]}" ikelyanemonitor-backup.timer
systemctl start ikelyanemonitor-backup.timer

log "switching to $commit"
ln -sfn "$release" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
restart_services

log "cleaning old releases (keeping $KEEP)"
ls -1d "$RELEASES"/*/ | sed 's:/$::' | sort | head -n -"$KEEP" | while read -r old; do
  [ "$old" = "$(readlink -f "$BASE/current")" ] || rm -r -- "$old"
done

echo "deployed $commit — https://monitor.ikelyane.com"
