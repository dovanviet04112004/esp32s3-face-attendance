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

# The running and the previous image stay for a rollback; each is ~1.1 GB.
prune() {
    local keep_now="$1" keep_before="$2" tag
    docker images "$IMAGE" --format '{{.Tag}}' | while read -r tag; do
        [[ "$tag" == "$keep_now" || "$tag" == "$keep_before" || "$tag" == latest ]] && continue
        docker image rm "$IMAGE:$tag" >/dev/null || true
    done
    docker image prune -f >/dev/null
}

main() {
    local sha actor previous
    read -r sha actor _ <<< "${SSH_ORIGINAL_COMMAND:-${1:-} ${2:-}}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "expected a 40-character commit sha"; exit 2; }
    [[ "$actor" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || { log "expected the github actor after the sha"; exit 2; }
    previous="$(cat "$HERE/.deployed" 2>/dev/null || true)"

    docker login ghcr.io --username "$actor" --password-stdin >/dev/null
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

    log "moving to $sha${previous:+ from $previous}"
    checkout "$sha"
    start "$sha"
    if healthy; then
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
    checkout "$previous"
    start "$previous"
    healthy || log "the rollback is not healthy either"
    exit 1
}

# One line on purpose: the checkout above rewrites this file while it runs.
main "$@"; exit $?
