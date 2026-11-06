#!/bin/bash
# Asks for the gateway key without echoing it, stores it readable by phurk only, and (re)starts the gateway.
set -e
umask 077
read -rsp "Gateway key (paste it, nothing will show): " k
echo
k="$(printf '%s' "$k" | tr -d '[:space:]')"
if [ -z "$k" ]; then echo "No key entered; nothing changed."; exit 1; fi
printf 'GATEWAY_KEY=%s\n' "$k" > "$HOME/13store/edge/gateway.env"
chmod 600 "$HOME/13store/edge/gateway.env"
echo "Key saved (${#k} characters). Starting the gateway..."
systemctl --user enable 13store-edge >/dev/null 2>&1
systemctl --user restart 13store-edge
sleep 5
systemctl --user is-active 13store-edge
journalctl --user -u 13store-edge -n 8 --no-pager -o cat 2>/dev/null | grep -v -i "key" || true
echo "Done."
