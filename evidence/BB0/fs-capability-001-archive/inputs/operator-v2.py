import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

PLAN_SHA = "6bf024078ff06918ef73c32c06417c9ac5547d181afb06338e3b3f3d958b1179"
ARGV_SHA = "d658363778899db5304c679631122b4116824d82f75f1007ef6ffad6caf99c4b"
SOURCE_SHA = "a156d4d7cc79f77110d195a9786bb8801028f1159ab3993c94c4a4bf311d965f"

if os.environ.get("BBUP_PARENT_GO") != "cap1-20261016:" + PLAN_SHA:
    raise SystemExit("HOLD: separate parent capability GO required")
if os.environ.get("BBUP_OWN_CHILD_TIMEOUT_GO") != \
        "cap1-20261016:kill-owned-child-and-wait5-on-timeout":
    raise SystemExit("HOLD: explicit own-child kill/reap timeout policy GO required")

base = Path("/tmp/bbup-capability-plan-4w6soqu2")
source = Path("/home/ubuntu/Projects/pi-durable-bb-adapter/"
              "evidence/BB0/test-bb-fs-sandbox/launcher.py")

def checked(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise SystemExit("STOP: fingerprint mismatch: " + str(path))
    return raw

M = json.loads(checked(base / "plan.json", PLAN_SHA))
A = json.loads(checked(base / "argv.json", ARGV_SHA))
checked(source, SOURCE_SHA)

if A != M["argv"][:M["argv"].index("--") + 1] + ["/usr/bin/env"]:
    raise SystemExit("STOP: payload/prefix mismatch")

spec = importlib.util.spec_from_file_location("reviewed_launcher", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.validate(M)
module.verify_public()  # Future GO only: exact existing public pins.

root = Path("/home/ubuntu/Projects/pi-durable-bb-adapter/"
            ".test-bb/fs-private.cap1-20261016")
dirs = ["bb-data", "home", "agent", "tmp", "config",
        "cache", "data", "state", "run", "s"]
if M["root"] != str(root) or M["privateDirectories"] != dirs:
    raise SystemExit("STOP: root/directory mismatch")

module.no_symlink_ancestors(root)
if os.path.lexists(root):
    raise SystemExit("STOP: root must be absent; no reuse")

os.umask(0o077)
root.mkdir(mode=0o700)
for name in dirs:
    (root / name).mkdir(mode=0o700)

with (root / "capability.log").open("xb") as log:
    child = subprocess.Popen(
        A,
        env=M["spawn"]["env"],
        cwd=M["spawn"]["cwd"],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        close_fds=True,
        pass_fds=(),
    )
    try:
        rc = child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        print("STOP: capability timeout; terminating only owned Popen child",
              child.pid, flush=True)
        try:
            child.kill()
        except ProcessLookupError:
            pass
        except OSError as error:
            print("UNKNOWN: owned child kill failed:", error, flush=True)
        try:
            child.wait(timeout=5)
        except (subprocess.TimeoutExpired, OSError) as error:
            print("UNKNOWN: owned child reap not established:", error,
                  "; retain resources; namespace payload cleanup UNKNOWN", flush=True)
        else:
            print("Owned Popen child reaped; namespace payload cleanup UNKNOWN;"
                  " retain resources", flush=True)
        raise SystemExit(124)

if rc == 0:
    print("/usr/bin/env executed and exited0; log", root / "capability.log")
else:
    print("STOP: capability exit", rc,
          "; namespace payload cleanup UNKNOWN; retain resources; log",
          root / "capability.log")
raise SystemExit(rc)
