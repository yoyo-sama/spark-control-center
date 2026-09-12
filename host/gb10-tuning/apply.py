#!/usr/bin/env python3
"""Applique l'etat desire (/etc/gb10-tuning/state.json) sur la machine GB10.

Liste blanche stricte : seules les cles de SCHEMA (+ version/updatedAt qui ne
produisent aucune action) sont executees. Toute cle inconnue va dans
rejectedKeys et n'est jamais executee. Toute valeur invalide (mauvais type ou
hors bornes) produit une action "skipped" sans empecher les autres cles.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA = {
    "gpuClockLimitMhz": (300, 3003),  # int ou null
    "gpuPersistenceMode": None,       # bool
    "swapDisabled": None,             # bool
    "vmSwappiness": (0, 100),         # int
    "thermalMonitor": None,           # bool
}
KNOWN_KEYS = set(SCHEMA) | {"version", "updatedAt"}

SWAP_SKIP_THRESHOLD_BYTES = 512 * 1024 * 1024
SYSCTL_CONF_PATH = "/etc/sysctl.d/99-gb10-tuning.conf"


def _is_int_in_range(v, lo, hi):
    # bool est une sous-classe d'int en Python : on l'exclut explicitement.
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def plan(state, swap_used_bytes):
    """Fonction pure : (state dict, swap utilise en octets) -> (actions, rejectedKeys).

    Ne lance aucune commande, n'ecrit aucun fichier. Chaque action est
    {"key", "argv", "status", "detail"} avec status ok|skipped.
    """
    actions = []
    rejected_keys = [k for k in state if k not in KNOWN_KEYS]

    if "gpuClockLimitMhz" in state:
        v = state["gpuClockLimitMhz"]
        lo, hi = SCHEMA["gpuClockLimitMhz"]
        if v is None:
            argv = ["nvidia-smi", "-rgc"]
            actions.append({"key": "gpuClockLimitMhz", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        elif _is_int_in_range(v, lo, hi):
            argv = ["nvidia-smi", "-lgc", "300,%d" % v]
            actions.append({"key": "gpuClockLimitMhz", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        else:
            actions.append({"key": "gpuClockLimitMhz", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu int [%d,%d] ou null): %r" % (lo, hi, v)})

    if "gpuPersistenceMode" in state:
        v = state["gpuPersistenceMode"]
        if isinstance(v, bool):
            argv = ["nvidia-smi", "-pm", "1" if v else "0"]
            actions.append({"key": "gpuPersistenceMode", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        else:
            actions.append({"key": "gpuPersistenceMode", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu bool): %r" % (v,)})

    if "swapDisabled" in state:
        v = state["swapDisabled"]
        if isinstance(v, bool):
            if v:
                if swap_used_bytes > SWAP_SKIP_THRESHOLD_BYTES:
                    actions.append({"key": "swapDisabled", "argv": [], "status": "skipped",
                                     "detail": "swap utilise %.1f GiB > seuil 512 MiB, swapoff refuse"
                                               % (swap_used_bytes / (1024 ** 3),)})
                else:
                    argv = ["swapoff", "-a"]
                    actions.append({"key": "swapDisabled", "argv": argv, "status": "ok", "detail": " ".join(argv)})
            else:
                argv = ["swapon", "-a"]
                actions.append({"key": "swapDisabled", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        else:
            actions.append({"key": "swapDisabled", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu bool): %r" % (v,)})

    if "vmSwappiness" in state:
        v = state["vmSwappiness"]
        lo, hi = SCHEMA["vmSwappiness"]
        if _is_int_in_range(v, lo, hi):
            argv = ["sysctl", "-w", "vm.swappiness=%d" % v]
            actions.append({"key": "vmSwappiness", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        else:
            actions.append({"key": "vmSwappiness", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu int [%d,%d]): %r" % (lo, hi, v)})

    if "thermalMonitor" in state:
        v = state["thermalMonitor"]
        if isinstance(v, bool):
            argv = ["systemctl", "start" if v else "stop", "gb10-thermal-monitor.service"]
            actions.append({"key": "thermalMonitor", "argv": argv, "status": "ok", "detail": " ".join(argv)})
        else:
            actions.append({"key": "thermalMonitor", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu bool): %r" % (v,)})

    return actions, rejected_keys


def get_swap_used_bytes():
    total = free = 0
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("SwapTotal:"):
                total = int(line.split()[1]) * 1024
            elif line.startswith("SwapFree:"):
                free = int(line.split()[1]) * 1024
    return total - free


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def write_result(result_path, result):
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")


def main():
    dry_run = "--dry-run" in sys.argv[1:] or os.environ.get("GB10_DRY_RUN") == "1"
    state_dir = os.environ.get("GB10_STATE_DIR", "/etc/gb10-tuning")
    state_path = os.path.join(state_dir, "state.json")
    result_path = os.path.join(state_dir, "result.json")
    applied_at = now_iso()

    os.makedirs(state_dir, exist_ok=True)

    try:
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, ValueError) as e:
        write_result(result_path, {
            "version": 1, "appliedAt": applied_at, "stateUpdatedAt": None,
            "dryRun": dry_run, "actions": [], "rejectedKeys": [],
            "error": "lecture de %s impossible: %s" % (state_path, e),
        })
        return

    if state.get("version") != 1:
        write_result(result_path, {
            "version": 1, "appliedAt": applied_at, "stateUpdatedAt": state.get("updatedAt"),
            "dryRun": dry_run, "actions": [], "rejectedKeys": [],
            "error": "version %r non supportee (attendu 1)" % (state.get("version"),),
        })
        return

    actions, rejected_keys = plan(state, get_swap_used_bytes())

    result_actions = []
    for a in actions:
        if dry_run or not a["argv"]:
            result_actions.append({"key": a["key"], "status": a["status"], "detail": a["detail"]})
            continue
        try:
            proc = subprocess.run(a["argv"], shell=False, capture_output=True, text=True)
            ok, err = proc.returncode == 0, proc.stderr.strip()
        except OSError as e:
            ok, err = False, str(e)
        status = "ok" if ok else "failed"
        detail = a["detail"] if ok else "%s (%s)" % (a["detail"], err)
        if ok and a["key"] == "vmSwappiness":
            try:
                with open(SYSCTL_CONF_PATH, "w") as f:
                    f.write(a["argv"][2] + "\n")
            except OSError:
                pass
        result_actions.append({"key": a["key"], "status": status, "detail": detail})

    write_result(result_path, {
        "version": 1, "appliedAt": applied_at, "stateUpdatedAt": state.get("updatedAt"),
        "dryRun": dry_run, "actions": result_actions, "rejectedKeys": rejected_keys,
    })


if __name__ == "__main__":
    main()
