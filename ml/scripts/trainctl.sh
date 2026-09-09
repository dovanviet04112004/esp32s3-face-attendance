#!/usr/bin/env bash
#
# Start, stop, continue or inspect the training of one branch.
#
# Usage:
#   ./scripts/trainctl.sh start  <branch> [key=value ...]
#   ./scripts/trainctl.sh pause  <branch>
#   ./scripts/trainctl.sh resume <branch>
#   ./scripts/trainctl.sh check  [branch]
#
# branch is detection, antispoof or recognition. See KEHOACH 4.4 for the two
# traps this exists to close.

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
LOG_DIR="${TRAINCTL_LOG_DIR:-${ML_ROOT}/artifacts}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

usage() {
    sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 2
}

branch_script() {
    case "$1" in
        detection)   echo "20_train_det.sh   configs/detection/yunet.yaml            val/ap" ;;
        antispoof)   echo "21_train_spoof.sh configs/antispoof/minifasnet.yaml       val/eer" ;;
        recognition) echo "22_train_recog.sh configs/recognition/mobilefacenet.yaml  val/cfp_fp_tar@far0.001" ;;
        *) return 1 ;;
    esac
}

# pgrep -f matches the whole command line, including that of the shell running
# this script, so every ancestor is excluded before a signal goes anywhere.
self_tree() {
    local p=$$
    while [[ ${p:-0} -gt 1 ]]; do
        printf ' %s' "${p}"
        p=$(ps -o ppid= -p "${p}" 2>/dev/null | tr -d ' ')
        [[ -z ${p} ]] && break
    done
    printf ' '
}

pids_matching() {
    local pattern="$1" self="$2" pid
    for pid in $(pgrep -f "${pattern}" 2>/dev/null); do
        [[ " ${self} " == *" ${pid} "* ]] && continue
        echo "${pid}"
    done
}

newest_run() { ls -dt "${ML_ROOT}/artifacts/$1/runs/"*/ 2>/dev/null | head -1; }

cmd_start() {
    local branch="$1"; shift
    read -r script cfg _metric <<<"$(branch_script "${branch}")"
    local self; self=$(self_tree)
    [[ -n $(pids_matching "facepipe\.tasks\.${branch}\.train" "${self}") ]] &&
        die "${branch} is already running; pause it first"

    mkdir -p "${LOG_DIR}"
    local out="${LOG_DIR}/train_${branch}.log"
    ( cd "${ML_ROOT}" && nohup "./scripts/${script}" "${cfg}" "$@" >"${out}" 2>&1 & )
    log "${branch}: started on ${cfg} ${*:-}"
    log "log ${out}"
    await_start "${out}" "${branch}"
}

cmd_resume() {
    local branch="$1"
    read -r script cfg _metric <<<"$(branch_script "${branch}")"
    local self; self=$(self_tree)
    [[ -n $(pids_matching "facepipe\.tasks\.${branch}\.train" "${self}") ]] &&
        die "${branch} is already running; pause it first"

    local run; run=$(newest_run "${branch}")
    [[ -n ${run} ]] || die "${branch} has no run yet; use start"
    local ckpt="${run}ckpt/last.pth"
    [[ -f ${ckpt} ]] || die "no ${ckpt}: that run finished no epoch, so use start"

    # Every model.params key, read back from the run's own frozen config: the
    # model is rebuilt from config before the state_dict loads, so a missing key
    # builds a different architecture and load_state_dict reports a size mismatch.
    local -a sets
    mapfile -t sets < <("${PY}" - "${run}" <<'PY'
import sys, yaml
cfg = yaml.safe_load(open(sys.argv[1] + "config.resolved.yaml"))
for key, value in (cfg["model"]["params"] or {}).items():
    print(f"model.params.{key}={value}")
hw = cfg["model"].get("input_hw")
if hw:
    print(f"model.input_hw=[{hw[0]},{hw[1]}]")
PY
    )
    log "run   $(basename "${run}")"
    log "params ${sets[*]}"

    mkdir -p "${LOG_DIR}"
    local out="${LOG_DIR}/train_${branch}.log"
    ( cd "${ML_ROOT}" &&
      nohup "./scripts/${script}" "${cfg}" "${sets[@]}" "train.resume=${ckpt}" >"${out}" 2>&1 & )
    await_start "${out}" "${branch}"
}

await_start() {
    local out="$1" branch="$2"
    printf 'waiting'
    for _ in $(seq 1 40); do
        if grep -qE "from epoch" "${out}" 2>/dev/null; then
            echo; grep -E "resumed|from epoch" "${out}"; return 0
        fi
        if grep -qiE "Traceback|size mismatch|FileExistsError" "${out}" 2>/dev/null; then
            echo; tail -20 "${out}"; return 1
        fi
        printf '.'; sleep 5
    done
    echo; warn "${branch}: no confirmation line yet, read ${out}"
}

cmd_pause() {
    local branch="$1"
    read -r script _cfg _metric <<<"$(branch_script "${branch}")"
    local self; self=$(self_tree)
    local trainer="facepipe\.tasks\.${branch}\.train"
    local looper="${script//./\\.}"

    local pids loops
    pids=$(pids_matching "${trainer}" "${self}")
    loops=$(pids_matching "${looper}" "${self}")
    [[ -z ${pids}${loops} ]] && { log "${branch}: nothing running"; return 0; }

    local pid
    for pid in ${loops}; do kill -TERM "${pid}" 2>/dev/null && log "SIGTERM loop    ${pid}"; done
    for pid in ${pids}; do kill -TERM "${pid}" 2>/dev/null && log "SIGTERM trainer ${pid}"; done

    printf 'stopping'
    for _ in $(seq 1 20); do
        [[ -z $(pids_matching "${trainer}" "${self}") ]] && break
        printf '.'; sleep 3
    done
    echo

    if [[ -n $(pids_matching "${trainer}" "${self}") ]]; then
        warn "SIGTERM did not take, the process is stuck on a lock; SIGKILL"
        for pid in $(pids_matching "${trainer}" "${self}"); do kill -9 "${pid}" 2>/dev/null; done
        sleep 5
    fi

    if [[ -n $(pids_matching "${trainer}" "${self}") ]]; then
        warn "${branch}: processes remain"
    else
        log "${branch}: stopped. Exit 143 reads as deliberate, so the loop will not restart it."
    fi
    local run; run=$(newest_run "${branch}")
    [[ -n ${run} ]] && ls -l "${run}ckpt/" 2>/dev/null
}

cmd_check() {
    local branch="$1"
    read -r _script _cfg metric <<<"$(branch_script "${branch}")"
    local run; run=$(newest_run "${branch}")
    printf '=== %s ===\n' "${branch}"
    [[ -n ${run} ]] || { echo "  no run yet"; return 0; }
    echo "  run    $(basename "${run}")"
    local self live=0
    self=$(self_tree)
    [[ -n $(pids_matching "facepipe\.tasks\.${branch}\.train" "${self}") ]] && live=1
    [[ ${live} -eq 1 ]] && echo "  state  RUNNING" || echo "  state  NOT RUNNING"
    "${PY}" - "${run}" "${metric}" "${live}" 2>/dev/null <<'PY'
import sys, time, datetime as dt
from pathlib import Path

import yaml
from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

run, metric, live = Path(sys.argv[1]), sys.argv[2], sys.argv[3] == "1"
epochs = yaml.safe_load((run / "config.resolved.yaml").read_text())["train"]["epochs"]
acc = EventAccumulator(str(run / "tb"), size_guidance={"scalars": 0})
acc.Reload()
tags = acc.Tags()["scalars"]
if "train/total" not in tags:
    print("  no scalar yet")
    raise SystemExit
series = acc.Scalars("train/total")
last, back = series[-1], series[max(-100, -len(series))]
rate = (last.step - back.step) / max(last.wall_time - back.wall_time, 1e-9)
marks = acc.Scalars(metric) if metric in tags else []
# Steps per epoch comes from the gap between two validation marks of this very
# run, so a resumed run needs no knowledge of where its chain began.
per_epoch = marks[1].step - marks[0].step if len(marks) >= 2 else None
age = (time.time() - last.wall_time) / 60
where = f"{last.step / per_epoch:.2f}" if per_epoch else "?"
print(f"  step   {last.step:,}  epoch {where}/{epochs}  loss {last.value:.2f}  {rate:.2f} step/s")
# A finished or paused run is expected to be quiet; only a live one going quiet
# is a symptom, and that is the case worth a word.
if live:
    print(f"  fresh  {age:.1f} min ago -> {'OK' if age < 5 else 'LOOKS STUCK'}")
    if per_epoch and rate > 0 and last.step < epochs * per_epoch:
        eta = last.wall_time + (epochs * per_epoch - last.step) / rate
        print(f"  eta    {dt.datetime.fromtimestamp(eta).strftime('%d/%m %H:%M')}")
else:
    print(f"  last   {dt.datetime.fromtimestamp(last.wall_time).strftime('%d/%m %H:%M')}")

if not marks:
    raise SystemExit
name = metric.split("/")[-1]
lower = name in {"eer", "loss", "acer"}
best = min(marks, key=lambda m: m.value) if lower else max(marks, key=lambda m: m.value)
shown = marks[-8:]
if len(marks) > len(shown):
    print(f"  {name}  ({len(marks)} epochs, last {len(shown)})")
else:
    print(f"  {name}")
for mark in shown:
    epoch = round(mark.step / per_epoch) if per_epoch else "?"
    flag = "  <- best" if mark is best else ""
    print(f"    epoch {epoch:>3}  {mark.value:.4f}{flag}")
if best not in shown:
    epoch = round(best.step / per_epoch) if per_epoch else "?"
    print(f"    epoch {epoch:>3}  {best.value:.4f}  <- best")
PY
}

[[ $# -ge 1 ]] || usage
[[ -x ${PY} ]] || die "no venv at ${PY}; run 'uv sync' in ml/"
action="$1"; shift

case "${action}" in
    start|pause|resume)
        [[ $# -ge 1 ]] || usage
        branch_script "$1" >/dev/null || die "unknown branch $1"
        "cmd_${action}" "$@"
        ;;
    check)
        if [[ $# -ge 1 ]]; then
            branch_script "$1" >/dev/null || die "unknown branch $1"
            cmd_check "$1"
        else
            for name in detection antispoof recognition; do cmd_check "${name}"; done
            echo
            nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu \
                --format=csv,noheader 2>/dev/null
        fi
        ;;
    *) usage ;;
esac
