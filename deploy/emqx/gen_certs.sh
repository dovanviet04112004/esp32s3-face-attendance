#!/usr/bin/env bash
#
# Generate the private CA and the broker certificate for MQTTS (KEHOACH 7.4).
# Only ca.crt leaves this directory: the firmware embeds it to verify the
# broker. Every key stays here and .gitignore keeps the whole lot out of git.
#
# Usage: ./gen_certs.sh <broker-address> [more-addresses...]
#   ./gen_certs.sh 192.168.1.10 mqtt.example.com

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$HERE/certs"
CA_DAYS=3650
SERVER_DAYS=825

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <broker-address> [more-addresses...]" >&2
    exit 1
fi

mkdir -p "$CERTS"
cd "$CERTS"

# A SAN entry per address, typed so an IP literal validates as an IP.
san=""
for addr in "$@"; do
    if [[ "$addr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        san+="IP:$addr,"
    else
        san+="DNS:$addr,"
    fi
done
san="${san%,}"

if [[ -f ca.key && -f ca.crt ]]; then
    echo "ca: reusing the existing authority"
else
    openssl genrsa -out ca.key 4096 2>/dev/null
    openssl req -x509 -new -nodes -key ca.key -sha256 -days "$CA_DAYS" \
        -subj "/CN=kiosk-attendance-ca" -out ca.crt
    echo "ca: new authority, valid $CA_DAYS days"
fi

# A kiosk trusts the authority, not the broker, so an authority it has never
# been flashed with locks the whole fleet out with nothing to see (KEHOACH 4.8).
PINNED="$HERE/../../firmware/components/net_mqtt/certs/broker_ca.crt"
if [[ -f "$PINNED" ]] && ! cmp -s ca.crt "$PINNED"; then
    echo "ca: WARNING, this differs from the one built into the firmware" >&2
    echo "    every kiosk will refuse this broker until it is reflashed" >&2
fi

openssl genrsa -out broker.key 2048 2>/dev/null
openssl req -new -key broker.key -subj "/CN=$1" -out broker.csr
openssl x509 -req -in broker.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out broker.crt -days "$SERVER_DAYS" -sha256 \
    -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san") 2>/dev/null
rm -f broker.csr

chmod 600 ca.key broker.key
chmod 644 ca.crt broker.crt

echo "broker: signed for $san, valid $SERVER_DAYS days"
openssl x509 -in broker.crt -noout -subject -ext subjectAltName | sed 's/^/  /'
