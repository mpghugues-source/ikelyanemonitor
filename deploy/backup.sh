#!/usr/bin/env bash
# Nightly logical backup of the PRODUCTION database (run by ikelyanemonitor-backup.timer).
#
#   /opt/ikelyanemonitor/current/deploy/backup.sh            # KEEP_DAYS=14 by default
#
# Dumps with pg_dump's custom format from inside the container (same PostgreSQL/TimescaleDB versions),
# into /var/backups/ikelyanemonitor (0700). Restore procedure: deploy/README.md "Restore a backup".
# The IKELYANE_SECRET_KEY in /etc/ikelyanemonitor/app.env is NOT in the dump: without it the agents'
# secrets in a restored database are unreadable — keep a copy of that key off this server.
set -euo pipefail

CONTAINER=ikelyanemonitor-prod-db
DEST=/var/backups/ikelyanemonitor
KEEP_DAYS=${KEEP_DAYS:-14}

install -d -m 700 "$DEST"
file="$DEST/ikelyanemonitor-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$file.partial"

# TimescaleDB prints harmless "circular foreign-key" warnings for its catalog; errors still fail the run.
docker exec "$CONTAINER" pg_dump -U ikelyane -d ikelyanemonitor --format=custom --compress=6 >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$file"

# Sanity check: the archive's table of contents must be readable.
docker exec -i "$CONTAINER" pg_restore --list >/dev/null <"$file"

find "$DEST" -maxdepth 1 -name 'ikelyanemonitor-*.dump' -mtime +"$KEEP_DAYS" -delete
echo "backup: $file ($(du -h "$file" | cut -f1))"
