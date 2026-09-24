#!/usr/bin/env bash
#
# Bring the VPS to one commit (KEHOACH 4.8). Run only by the GitHub deploy key,
# pinned in authorized_keys as restrict,command="<this file>": the key can run
# nothing else. The commit and the actor arrive as the ssh command, the
# registry token on stdin, and the token dies with the job that sent it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
IMAGE="ghcr.io/dovanviet04112004/cckiosk-api"
HEALTH_WAIT_S=120
HEALTH_POLL_S=5
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.prod.yml")

log() {
    echo "deploy: $*" >&2
}

checkout() {
    git -C "$REPO" fetch --quiet --depth 1 origin "$1"
    git -C "$REPO" checkout --quiet --detach FETCH_HEAD
}

pin_tag() {
    if grep -q '^API_TAG=' "$HERE/.env"; then
        sed -i "s/^API_TAG=.*/API_TAG=$1/" "$HERE/.env"
    else
        echo "API_TAG=$1" >> "$HERE/.env"
    fi
}

healthy() {
    local waited=0 state
    while (( waited < HEALTH_WAIT_S )); do
        state="$(docker inspect -f '{{.State.Health.Status}}' kiosk-api 2>/dev/null || echo missing)"
        [[ "$state" == healthy ]] && return 0
        sleep "$HEALTH_POLL_S"
        waited=$(( waited + HEALTH_POLL_S ))
    done
    log "api still $state after ${HEALTH_WAIT_S} s"
    return 1
}

start() {
    pin_tag "$1"
    "${COMPOSE[@]}" pull --quiet api
    "${COMPOSE[@]}" up -d --no-build --remove-orphans
}

broker_digest() {
    cat "$HERE/emqx/emqx.conf" "$HERE/emqx/acl.conf" | sha256sum
}

# A single-file bind mount keeps the inode checkout replaced, so compose alone
# leaves the broker on its old config (KEHOACH 4.8).
reload_broker() {
    [[ "$(broker_digest)" == "$1" ]] && return 0
    log "broker config changed, recreating emqx"
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate emqx
}

traefik_digest() {
    cat "$HERE/traefik/traefik.yml" "$HERE/traefik/dynamic.yml" | sha256sum
}

# Same trap as the broker: the file watch never sees a checkout's new inode (KEHOACH 4.8).
reload_traefik() {
    [[ "$(traefik_digest)" == "$1" ]] && return 0
    log "traefik config changed, recreating traefik"
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate traefik
}

# Tracked blobs only: a stray file in the directory, a key among them, must not
# read as a change. restore-drill.sh runs on the key holder's machine, not in the image.
backup_digest() {
    git -C "$REPO" ls-tree HEAD deploy/backup/ | grep -v '/restore-drill\.sh$' | sha256sum | cut -d ' ' -f 1
}

# kiosk-backup:local is built on this box and never pulled, while start runs --no-build.
# Its label says what it was built from, so a failed build is retried on the rerun.
rebuild_backup() {
    local want built
    want="$(backup_digest)"
    built="$(docker image inspect kiosk-backup:local \
        --format '{{index .Config.Labels "cckiosk.inputs"}}' 2>/dev/null || true)"
    [[ "$built" == "$want" ]] && return 0
    log "kiosk-backup was built from ${built:-nothing}, building it from $want"
    "${COMPOSE[@]}" build --quiet --build-arg INPUTS="$want" backup
}

# What the running container reads, not what the checkout holds: its bind mounts keep old inodes.
postgres_stale() {
    local file
    for file in postgresql.conf archive.conf pg_hba.conf; do
        [[ -f "$HERE/postgres/$file" ]] || continue
        [[ "$(docker exec kiosk-postgres cat "/etc/postgresql/$file" 2>/dev/null | sha256sum)" \
            == "$(sha256sum < "$HERE/postgres/$file")" ]] || return 0
    done
    return 1
}

reload_postgres() {
    postgres_stale || return 0
    log "postgres reads an older config, recreating postgres"
    "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate postgres
}

# The running and the previous image stay for a rollback; each is ~1.1 GB.
prune() {
    local keep_now="$1" keep_before="$2" tag
    docker images "$IMAGE" --format '{{.Tag}}' | while read -r tag; do
        [[ "$tag" == "$keep_now" || "$tag" == "$keep_before" || "$tag" == latest ]] && continue
        docker image rm "$IMAGE:$tag" >/dev/null || true
    done
    docker image prune -f >/dev/null
}

# Called as a plain statement: bash ignores set -e for anything run inside a condition,
# the subshell included. The outcome comes back in BROUGHT_UP so a failure can roll back.
bring_up() {
    local sha="$1" broker="$2" proxy="$3" status
    set +e
    (
        set -e
        rebuild_backup
        start "$sha"
        reload_broker "$broker"
        reload_traefik "$proxy"
        reload_postgres
    )
    status=$?
    set -e
    BROUGHT_UP=yes
    if (( status != 0 )); then
        BROUGHT_UP=no
        log "bringing up $sha failed with status $status"
    fi
}

main() {
    local sha actor previous broker proxy
    read -r sha actor _ <<< "${SSH_ORIGINAL_COMMAND:-${1:-} ${2:-}}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "expected a 40-character commit sha"; exit 2; }
    [[ "$actor" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || { log "expected the github actor after the sha"; exit 2; }
    previous="$(cat "$HERE/.deployed" 2>/dev/null || true)"

    docker login ghcr.io --username "$actor" --password-stdin >/dev/null
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

    log "moving to $sha${previous:+ from $previous}"
    broker="$(broker_digest)"
    proxy="$(traefik_digest)"
    checkout "$sha"
    bring_up "$sha" "$broker" "$proxy"
    if [[ "$BROUGHT_UP" == yes ]] && healthy; then
        echo "$sha" > "$HERE/.deployed"
        prune "$sha" "$previous"
        log "live at $sha"
        return 0
    fi

    if [[ -z "$previous" ]]; then
        log "no earlier deploy to go back to"
        exit 1
    fi
    log "rolling back to $previous"
    broker="$(broker_digest)"
    proxy="$(traefik_digest)"
    checkout "$previous"
    bring_up "$previous" "$broker" "$proxy"
    [[ "$BROUGHT_UP" == yes ]] && healthy || log "the rollback is not healthy either"
    exit 1
}

# One line on purpose: the checkout above rewrites this file while it runs.
main "$@"; exit $?
