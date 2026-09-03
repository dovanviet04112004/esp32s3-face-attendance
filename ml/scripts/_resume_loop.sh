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
RESUME_FAILS_FAST_SECONDS="${RESUME_FAILS_FAST_SECONDS:-120}"

# Newest run directory under $1 holding a checkpoint, created after $2 as an
# epoch second.
#
# The cutoff is what keeps an arm out of another arm's checkpoint. Both arms of
# an ablation write into one runs root, so the newest directory there is usually
# the arm that ran before this one; resuming from it would start the KD arm at
# the baseline's weights and its epoch counter, and the run would look normal
# from the outside (KEHOACH section 3.7).
#
# An attempt that dies before its first epoch boundary leaves a directory with
# no checkpoint. Taking the newest directory outright would pick that one, find
# nothing to resume, and quietly start the arm over from epoch 0.
newest_run() {
    find "$1" -mindepth 1 -maxdepth 1 -type d -newermt "@$2" -printf '%T@ %p/\n' 2>/dev/null |
        sort -rn | while read -r _ dir; do
            [[ -f "${dir}ckpt/last.pth" ]] || continue
            printf '%s\n' "${dir}"
            break
        done
}

# Runs launch() until it succeeds, is stopped on purpose, or hits the attempt cap.
train_with_resume() {
    local runs_root="$1"
    local attempt=0 run status started_at began ran_for

    started_at="$(date +%s)"
    while :; do
        run="$(newest_run "${runs_root}" "${started_at}")"
        began="$(date +%s)"
        launch "${run}"
        status=$?
        ran_for=$(( $(date +%s) - began ))

        if [[ ${status} -eq 0 ]]; then
            return 0
        fi
        # A resume that dies before it can train is a checkpoint the trainer
        # cannot read, not a transient fault. Retrying repeats it, and each
        # repeat buries the good checkpoint one directory deeper.
        if [[ -n "${run}" && ${ran_for} -lt ${RESUME_FAILS_FAST_SECONDS} ]]; then
            warn "resume from ${run} died after ${ran_for}s (exit ${status}); not retrying"
            return "${status}"
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
