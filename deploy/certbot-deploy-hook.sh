#!/usr/bin/env bash
# certbot deploy hook: install the renewed monitor.ikelyane.com certificate into cPanel's vhost.
# Installed as /etc/letsencrypt/renewal-hooks/deploy/ikelyanemonitor-cpanel.sh (see deploy/README.md).
#
# Why certbot and not AutoSSL: the domain is proxied by Cloudflare, and AutoSSL's HTTP validation fails
# behind it; certbot validates over DNS (Cloudflare API) instead. cPanel keeps a valid installed
# certificate, so AutoSSL does not replace this one.
set -euo pipefail

DOMAIN=monitor.ikelyane.com
CPANEL_USER=ikelyane
LIVE=/etc/letsencrypt/live/$DOMAIN

# certbot runs every deploy hook for every renewed lineage: only act on ours.
if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$RENEWED_LINEAGE" != "$LIVE" ]; then exit 0; fi

# uapi takes URL-encoded arguments (a raw "+" in the PEM base64 would become a space).
enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(open(sys.argv[1]).read(), safe=""))' "$1"; }

out=$(uapi --user="$CPANEL_USER" --output=json SSL install_ssl \
  domain="$DOMAIN" cert="$(enc "$LIVE/cert.pem")" key="$(enc "$LIVE/privkey.pem")" cabundle="$(enc "$LIVE/chain.pem")")
if ! printf '%s' "$out" | python3 -c 'import sys, json; sys.exit(0 if json.load(sys.stdin)["result"]["status"] == 1 else 1)'; then
  printf 'installing the %s certificate into cPanel failed:\n%s\n' "$DOMAIN" "$out" | logger -t ikelyanemonitor-cert
  exit 1
fi
logger -t ikelyanemonitor-cert "installed the renewed $DOMAIN certificate into cPanel"
