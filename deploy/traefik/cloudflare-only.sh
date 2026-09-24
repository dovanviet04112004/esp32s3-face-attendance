#!/usr/bin/env bash
#
# Admit 80 and 443 from Cloudflare's ranges alone (KEHOACH 7.2). Run as root:
#   cloudflare-only.sh           apply the filter now
#   cloudflare-only.sh install   copy itself to /usr/local/sbin and reapply whenever Docker starts
#   cloudflare-only.sh off       take the filter away

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAEFIK_YML="${TRAEFIK_YML:-$HERE/traefik.yml}"
CHAIN=CCKIOSK-EDGE
PORTS=(80 443)
INSTALLED=/usr/local/sbin/cckiosk-cloudflare-only
UNIT=/etc/systemd/system/cckiosk-cloudflare-only.service

log() {
    echo "cloudflare-only: $*" >&2
}

# The list traefik trusts X-Forwarded-For from, so the two never drift apart.
ranges() {
    grep -oE '"[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}"' "$TRAEFIK_YML" | tr -d '"'
}

outside() {
    ip route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
}

# Docker publishes by DNAT, so the packets take FORWARD and never meet ufw's INPUT rules.
jumps() {
    local dev="$1" port
    for port in "${PORTS[@]}"; do
        echo "-i $dev -p tcp -m conntrack --ctorigdstport $port -j $CHAIN"
    done
}

apply() {
    local cidrs dev cidr rule
    mapfile -t cidrs < <(ranges)
    (( ${#cidrs[@]} > 0 )) || { log "no range read from $TRAEFIK_YML; refusing to shut everyone out"; exit 1; }
    dev="$(outside)"
    [[ -n "$dev" ]] || { log "no default route to name the outside interface"; exit 1; }
    iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
    for cidr in "${cidrs[@]}"; do
        iptables -A "$CHAIN" -s "$cidr" -j RETURN
    done
    iptables -A "$CHAIN" -j DROP
    while read -r rule; do
        # shellcheck disable=SC2086
        iptables -C DOCKER-USER $rule 2>/dev/null || iptables -I DOCKER-USER $rule
    done < <(jumps "$dev")
    log "${PORTS[*]} on $dev admit ${#cidrs[@]} Cloudflare ranges only"
}

off() {
    local rule
    while read -r rule; do
        # shellcheck disable=SC2086
        while iptables -D DOCKER-USER $rule 2>/dev/null; do :; done
    done < <(jumps "$(outside)")
    iptables -F "$CHAIN" 2>/dev/null || true
    iptables -X "$CHAIN" 2>/dev/null || true
    systemctl disable --now "$(basename "$UNIT")" 2>/dev/null || true
    log "${PORTS[*]} open to everyone again"
}

# A root-owned copy runs at boot, so root never executes the deploy user's checkout.
install_unit() {
    install -m 0755 -o root -g root "${BASH_SOURCE[0]}" "$INSTALLED"
    cat > "$UNIT" <<EOF
[Unit]
Description=Admit 80 and 443 from Cloudflare only (cckiosk)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=TRAEFIK_YML=$TRAEFIK_YML
ExecStart=$INSTALLED

[Install]
WantedBy=docker.service
EOF
    systemctl daemon-reload
    systemctl enable --now "$(basename "$UNIT")"
    log "installed $INSTALLED and $(basename "$UNIT")"
}

(( EUID == 0 )) || { log "run as root"; exit 1; }
case "${1:-apply}" in
    apply) apply ;;
    install) install_unit ;;
    off) off ;;
    *) log "expected apply, install or off"; exit 2 ;;
esac
