#!/usr/bin/env python3
"""Auto-test de plan() : assert nus, aucun framework, pas de root ni de GPU."""
import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("gb10_apply", os.path.join(_here, "apply.py"))
apply = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(apply)

plan = apply.plan


def by_key(actions, key):
    for a in actions:
        if a["key"] == key:
            return a
    return None


def all_argv(actions):
    out = []
    for a in actions:
        out.extend(a["argv"])
    return out


# 1. etat valide complet -> argv exacts pour chaque cle, aucune cle rejetee.
state = {
    "version": 1,
    "updatedAt": "2026-09-12T09:40:00.000Z",
    "gpuClockLimitMhz": 2100,
    "gpuPersistenceMode": True,
    "swapDisabled": False,
    "vmSwappiness": 10,
    "thermalMonitor": False,
}
actions, rejected = plan(state, swap_used_bytes=0)
assert rejected == []
assert len(actions) == 5
assert by_key(actions, "gpuClockLimitMhz") == {
    "key": "gpuClockLimitMhz", "argv": ["nvidia-smi", "-lgc", "300,2100"],
    "status": "ok", "detail": "nvidia-smi -lgc 300,2100",
}
assert by_key(actions, "gpuPersistenceMode") == {
    "key": "gpuPersistenceMode", "argv": ["nvidia-smi", "-pm", "1"],
    "status": "ok", "detail": "nvidia-smi -pm 1",
}
assert by_key(actions, "swapDisabled") == {
    "key": "swapDisabled", "argv": ["swapon", "-a"],
    "status": "ok", "detail": "swapon -a",
}
assert by_key(actions, "vmSwappiness") == {
    "key": "vmSwappiness", "argv": ["sysctl", "-w", "vm.swappiness=10"],
    "status": "ok", "detail": "sysctl -w vm.swappiness=10",
}
assert by_key(actions, "thermalMonitor") == {
    "key": "thermalMonitor", "argv": ["systemctl", "stop", "gb10-thermal-monitor.service"],
    "status": "ok", "detail": "systemctl stop gb10-thermal-monitor.service",
}

# 2. valeur malicieuse (injection shell) -> aucun argv emis pour cette cle.
actions, rejected = plan({"version": 1, "gpuClockLimitMhz": "2100; rm -rf /"}, swap_used_bytes=0)
a = by_key(actions, "gpuClockLimitMhz")
assert a["status"] == "skipped"
assert a["argv"] == []
assert rejected == []
assert "rm -rf" not in " ".join(all_argv(actions))

# 3. valeurs hors bornes -> skipped, aucun argv (y compris le piege bool-est-un-int).
actions, _ = plan({"version": 1, "gpuClockLimitMhz": 9999}, swap_used_bytes=0)
a = by_key(actions, "gpuClockLimitMhz")
assert a["status"] == "skipped" and a["argv"] == []

actions, _ = plan({"version": 1, "vmSwappiness": -1}, swap_used_bytes=0)
a = by_key(actions, "vmSwappiness")
assert a["status"] == "skipped" and a["argv"] == []

actions, _ = plan({"version": 1, "vmSwappiness": True}, swap_used_bytes=0)
a = by_key(actions, "vmSwappiness")
assert a["status"] == "skipped" and a["argv"] == []

# 4. cle inconnue -> rejectedKeys, absente des actions/argv.
actions, rejected = plan({"version": 1, "evil": "x"}, swap_used_bytes=0)
assert rejected == ["evil"]
assert by_key(actions, "evil") is None
assert actions == []

# 5. swap deja trop utilise -> garde-fou, aucun swapoff.
actions, _ = plan({"version": 1, "swapDisabled": True}, swap_used_bytes=2 * 1024 ** 3)
a = by_key(actions, "swapDisabled")
assert a["status"] == "skipped"
assert a["argv"] == []
assert "swapoff" not in all_argv(actions)

# 6. reset de l'horloge GPU.
actions, _ = plan({"version": 1, "gpuClockLimitMhz": None}, swap_used_bytes=0)
a = by_key(actions, "gpuClockLimitMhz")
assert a["argv"] == ["nvidia-smi", "-rgc"]
assert a["status"] == "ok"

print("OK - tous les tests passent")
