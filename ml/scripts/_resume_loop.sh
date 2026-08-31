#!/usr/bin/env bash
#
# Shared by every training script: run one arm, and pick it up again from its own
# last checkpoint when the process dies. Sourced, never run on its own.
#
# The caller defines launch(), which receives the newest run directory (empty on
# the first attempt) and is free to express resume however its trainer spells it.
# This file owns only the retry policy and finding that directory.
#
# A run writes its checkpoint at every epoch boundary, so a restart loses at most
# one epoch, and each attempt records its parent so the history stays readable
# across the break.

MAX_ATTEMPTS="${MAX_ATTEMPTS:-20}"
RETRY_PAUSE_SECONDS="${RETRY_PAUSE_SECONDS:-15}"

newest_run() {
    ls -dt "$1"/*/ 2>/dev/null | head -1
}

# Runs launch() until it succeeds, is stopped on purpose, or hits the attempt cap.
train_with_resume() {
    local runs_root="$1"
    local attempt=0 run status

    while :; do
        run="$(newest_run "${runs_root}")"
        launch "${run}"
        status=$?

        if [[ ${status} -eq 0 ]]; then
            return 0
        fi
        # 130 is Ctrl-C and 143 is SIGTERM. Restarting those would make pausing
        # a run impossible, which is the opposite of what this loop is for.
        if [[ ${status} -eq 130 || ${status} -eq 143 ]]; then
            log "stopped on request (exit ${status})"
            return 0
        fi

        attempt=$((attempt + 1))
        if [[ ${attempt} -ge ${MAX_ATTEMPTS} ]]; then
            warn "gave up after ${attempt} attempt(s); last exit ${status}"
            return "${status}"
        fi
        warn "exit ${status}; retrying, attempt ${attempt} of ${MAX_ATTEMPTS}"
        sleep "${RETRY_PAUSE_SECONDS}"
    done
}
