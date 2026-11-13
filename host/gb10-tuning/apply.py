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
    "cpuBigCoreMaxMhz": (2808, 5000),  # int ou null
}
KNOWN_KEYS = set(SCHEMA) | {"version", "updatedAt"}

SWAP_SKIP_THRESHOLD_BYTES = 512 * 1024 * 1024
SYSCTL_CONF_PATH = "/etc/sysctl.d/99-gb10-tuning.conf"

# Plafond CPU des gros coeurs (Cortex-X925, cpu5-9 et cpu15-19 sur le GB10).
# Plancher 2808 MHz = frequence max des petits coeurs A725 : en dessous, un X925
# deviendrait plus lent qu'un A725 et le scheduler y migrerait mal les threads.
# Les gros coeurs sont detectes par cpuinfo_max_freq > plancher plutot que codes
# en dur, donc un plafond ne touche jamais un A725.
CPU_SYSFS = "/sys/devices/system/cpu"
CPU_FLOOR_KHZ = 2808 * 1000


def _is_int_in_range(v, lo, hi):
    # bool est une sous-classe d'int en Python : on l'exclut explicitement.
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _cpu_list(cpus):
    """[5, 6, 7, 8, 9, 15] -> "5-9,15"."""
    out, i = [], 0
    while i < len(cpus):
        j = i
        while j + 1 < len(cpus) and cpus[j + 1] == cpus[j] + 1:
            j += 1
        out.append(str(cpus[i]) if i == j else "%d-%d" % (cpus[i], cpus[j]))
        i = j + 1
    return ",".join(out)


def read_cpu_topology(root=CPU_SYSFS):
    """{numero de cpu: cpuinfo_max_freq en kHz} pour chaque cpu qui expose cpufreq."""
    topo = {}
    try:
        names = os.listdir(root)
    except OSError:
        return topo
    for name in names:
        if not (name.startswith("cpu") and name[3:].isdigit()):
            continue
        try:
            with open(os.path.join(root, name, "cpufreq", "cpuinfo_max_freq")) as f:
                topo[int(name[3:])] = int(f.read().strip())
        except (OSError, ValueError):
            pass
    return topo


def plan(state, swap_used_bytes, cpu_topology=None):
    """Fonction pure : (state dict, swap utilise en octets, topologie cpufreq) -> (actions, rejectedKeys).

    Ne lance aucune commande, n'ecrit aucun fichier. Chaque action est
    {"key", "argv", "status", "detail"} avec status ok|skipped ; une action
    cpufreq porte en plus "writes" = [[chemin sysfs, valeur kHz], ...] et un argv vide.
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

    if "cpuBigCoreMaxMhz" in state:
        v = state["cpuBigCoreMaxMhz"]
        lo, hi = SCHEMA["cpuBigCoreMaxMhz"]
        big = sorted(c for c, k in (cpu_topology or {}).items() if k > CPU_FLOOR_KHZ)
        if not (v is None or _is_int_in_range(v, lo, hi)):
            actions.append({"key": "cpuBigCoreMaxMhz", "argv": [], "status": "skipped",
                             "detail": "valeur invalide (attendu int [%d,%d] ou null): %r" % (lo, hi, v)})
        elif not big:
            actions.append({"key": "cpuBigCoreMaxMhz", "argv": [], "status": "skipped",
                             "detail": "aucun coeur au-dessus de %d MHz detecte dans cpufreq" % (CPU_FLOOR_KHZ // 1000)})
        else:
            # null = retour a la frequence max d'usine de chaque coeur.
            writes = [[os.path.join(CPU_SYSFS, "cpu%d" % c, "cpufreq", "scaling_max_freq"),
                       str(cpu_topology[c] if v is None else min(v * 1000, cpu_topology[c]))]
                      for c in big]
            what = "max d'usine" if v is None else "%d MHz" % v
            actions.append({"key": "cpuBigCoreMaxMhz", "argv": [], "writes": writes, "status": "ok",
                             "detail": "scaling_max_freq = %s sur cpu%s" % (what, _cpu_list(big))})

    return actions, rejected_keys


def write_cpufreq(writes):
    """Ecrit chaque scaling_max_freq puis le relit : le plafond n'est "ok" que si la
    valeur relue ne depasse pas la valeur demandee (nv-cpu-governor ou le pilote
    peuvent la reecrire). Retourne (ok, message d'erreur)."""
    errors = []
    for path, value in writes:
        try:
            with open(path, "w") as f:
                f.write(value)
            with open(path) as f:
                got = int(f.read().strip())
            if got > int(value):
                errors.append("%s relu %d > %s" % (path, got, value))
        except (OSError, ValueError) as e:
            errors.append("%s: %s" % (path, e))
    return not errors, "; ".join(errors)


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

    actions, rejected_keys = plan(state, get_swap_used_bytes(), read_cpu_topology())

    result_actions = []
    for a in actions:
        if dry_run or not (a["argv"] or a.get("writes")):
            result_actions.append({"key": a["key"], "status": a["status"], "detail": a["detail"]})
            continue
        if a.get("writes"):
            ok, err = write_cpufreq(a["writes"])
            result_actions.append({"key": a["key"], "status": "ok" if ok else "failed",
                                   "detail": a["detail"] if ok else "%s (%s)" % (a["detail"], err)})
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
