#!/usr/bin/env python3
"""Future one-attempt QA supervisor; SOURCE ONLY here, never run in this prep."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
from datetime import datetime, timezone

PLAN = Path(__file__).resolve().parent
REPO = Path('/home/ubuntu/Projects/pi-durable-bb-adapter')
HELPER = REPO / 'evidence/BB0/lead-sandbox-sdk-leaf-v1.py'
PARENT = REPO / 'evidence/BB0/lead-sandbox.py'
BASE = REPO / 'evidence/BB0/lead-private/.cache'
NODE = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
PROBE = str(REPO / 'evidence/BB0/sdk-definition-leaf-probe/probe.mjs')
MANIFEST_FILE = PLAN / 'manifest.json'
WITNESS_FILE = PLAN / 'inner-witness.py'

def fail(message):
    raise SystemExit('HOLD:' + message)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def pin_file(path, expected):
    p = Path(path)
    if not p.is_absolute() or p.resolve(strict=True) != p:
        fail('NONCANONICAL:' + str(p))
    st = p.lstat()
    if not stat.S_ISREG(st.st_mode):
        fail('NOT_REGULAR:' + str(p))
    raw = p.read_bytes()
    if sha(raw) != expected:
        fail('PIN_MISMATCH:' + str(p))
    return raw

def verify_all(m):
    # Candidate and frozen references are finite, explicit, and hash-checked pre/post.
    for row in m['files']:
        pin_file(row['path'], row['sha256'])
    raw = pin_file(m['publicPinManifest']['path'], m['publicPinManifest']['sha256'])
    pins = json.loads(raw)
    rows = [pins['sdk'], *pins['zod'], *pins['packageMetadata']]
    if len(rows) != 98:
        fail('PUBLIC_PIN_COUNT')
    for row in rows:
        p = Path(row['path'])
        b = pin_file(p, row['sha256'])
        if len(b) != row['bytes']:
            fail('PUBLIC_PIN_BYTES:' + str(p))
    return len(rows)

def clean_dir(path, uid):
    p = Path(path)
    if p.resolve(strict=True) != p:
        fail('QA_ROOT_NONCANONICAL:' + str(p))
    if p.is_symlink() or not p.is_dir():
        fail('QA_ROOT_NOT_DIR:' + str(p))
    st = p.lstat()
    if st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700 or st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
        fail('QA_ROOT_MODE_OWNER:' + str(p))
    if any(p.iterdir()):
        fail('QA_ROOT_NOT_FRESH:' + str(p))
    return p

def check_helper_base(uid):
    # Metadata only: no old profile/config contents. Refuse before the helper's chmod if unsafe.
    p = BASE
    if p.resolve(strict=True) != p or any(part.is_symlink() for part in (p, *p.parents)) or not p.is_dir():
        fail('HELPER_BASE_MISSING_OR_LINK')
    st = p.lstat()
    if st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700 or st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
        fail('HELPER_BASE_MODE_OWNER')
    acl_names_present = any(n.startswith('system.posix_acl_') for n in os.listxattr(p, follow_symlinks=False))
    return (st.st_dev, st.st_ino, st.st_uid, stat.S_IMODE(st.st_mode)), acl_names_present

def outcome_code(record):
    if record.get('timeout') or record.get('child_status', '').startswith('UNKNOWN'):
        return 124
    if record.get('post_integrity') != 'MATCH':
        return 125
    return int(record.get('popen_exit', 1))

def main():
    manifest_bytes = MANIFEST_FILE.read_bytes()
    m = json.loads(manifest_bytes)
    if sha(Path(__file__).read_bytes()) != m['supervisorSha256']:
        fail('SUPERVISOR_SOURCE_PIN')
    if sha(WITNESS_FILE.read_bytes()) != m['witnessSha256']:
        fail('WITNESS_SOURCE_PIN')
    manifest_sha = sha(manifest_bytes)
    if os.environ.get('BB0_LEAF_QA_EXECUTION_GO') != 'sdk-leaf-20261016:' + manifest_sha:
        fail('SEPARATE_ROOT_EXECUTION_GO_REQUIRED')
    qa_env = os.environ
    required_outer = {'PATH','LANG','HOME','TMPDIR','BB0_LEAF_QA_ROOT','BB0_LEAF_QA_EXECUTION_GO'}
    if set(qa_env) != required_outer or qa_env['PATH'] != '/usr/bin:/bin' or qa_env['LANG'] != 'C.UTF-8':
        fail('OUTER_ENV_NOT_EXACT_ENV_I')
    uid = os.getuid()
    qa = clean_dir(qa_env['BB0_LEAF_QA_ROOT'], uid)
    home, tmp, logs = qa / 'home', qa / 'tmp', qa / 'logs'
    if qa_env['HOME'] != str(home) or qa_env['TMPDIR'] != str(tmp):
        fail('OUTER_HOME_TMP_NOT_FRESH')
    for p in (home, tmp, logs):
        p.mkdir(mode=0o700)
    if any(stat.S_IMODE(p.lstat().st_mode) != 0o700 or p.lstat().st_uid != uid for p in (home,tmp,logs)):
        fail('QA_SUBDIR_MODE_OWNER')
    base_before, base_acl_before = check_helper_base(uid)
    public_count = verify_all(m)
    witness = pin_file(WITNESS_FILE, m['witnessSha256']).decode('utf-8')
    child_env = {
        'PATH': '/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': str(tmp), 'LANG': 'C.UTF-8',
    }
    host_pid = os.readlink('/proc/self/ns/pid')
    host_mnt = os.readlink('/proc/self/ns/mnt')
    host_uid, host_gid = os.getuid(), os.getgid()
    argv = [
        '/usr/bin/python3','-I','-B',str(HELPER),'--cwd','provider','--',
        '/usr/bin/env','BB0_SDK_LEAF_GO=sdk-definition-leaf-v1',
        'BB0_EXPECT_HOST_PID_NS=' + host_pid,
        'BB0_EXPECT_HOST_MNT_NS=' + host_mnt,
        'BB0_EXPECT_HOST_UID=' + str(host_uid),
        'BB0_EXPECT_HOST_GID=' + str(host_gid),
        '/usr/bin/python3','-I','-B','-c',witness,
    ]
    record = {
        'status':'STARTING_ONE_ATTEMPT', 'utc_start':datetime.now(timezone.utc).isoformat(),
        'manifest_sha256':manifest_sha, 'supervisor_sha256':m['supervisorSha256'],
        'witness_sha256':m['witnessSha256'], 'helper_sha256':m['helperSha256'],
        'parent_sha256':m['parentSha256'], 'public_pin_count':public_count,
        'argv':argv, 'outer_env':dict(qa_env), 'child_env':child_env, 'host_pid_ns':host_pid,
        'host_mnt_ns':host_mnt, 'host_uid':host_uid, 'host_gid':host_gid,
        'timeout_seconds':60, 'timeout_policy':'kill only owned Popen then wait <=5s; unknown => retain/no retry/no delete',
    }
    (logs / 'launch.json').write_text(json.dumps(record, indent=2) + '\n')
    try:
        with (logs / 'stdout.raw').open('xb') as out, (logs / 'stderr.raw').open('xb') as err:
            child = subprocess.Popen(argv, cwd=str(REPO), env=child_env,
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     close_fds=True, pass_fds=(), shell=False)
            try:
                rc = child.wait(timeout=60)
                record['popen_exit'] = rc
                record['child_status'] = 'REAPED_NORMAL'
            except subprocess.TimeoutExpired:
                record['timeout'] = True
                try:
                    child.kill()
                except ProcessLookupError:
                    pass
                except OSError as e:
                    record['kill_error'] = repr(e)
                try:
                    record['popen_exit'] = child.wait(timeout=5)
                    record['child_status'] = 'REAPED_AFTER_TIMEOUT_NAMESPACE_CLEANUP_UNKNOWN'
                except (subprocess.TimeoutExpired, OSError) as e:
                    record['popen_exit'] = None
                    record['child_status'] = 'UNKNOWN_RETAIN_STOP_NO_RETRY_NO_DELETE:' + repr(e)
    finally:
        record['utc_end'] = datetime.now(timezone.utc).isoformat()
        for label in ('stdout', 'stderr'):
            p = logs / (label + '.raw')
            if p.exists():
                record[label + '_sha256'] = sha(p.read_bytes())
            else:
                record[label + '_sha256'] = 'unavailable'
        record['supervisor_sha256_after'] = sha(Path(__file__).read_bytes())
        record['witness_sha256_after'] = sha(WITNESS_FILE.read_bytes())
        record['manifest_sha256_after'] = sha(MANIFEST_FILE.read_bytes())
        try:
            record['public_pin_count_after'] = verify_all(m)
            record['source_pins_after'] = 'MATCH'
        except (SystemExit, OSError, ValueError, KeyError) as e:
            record['source_pins_after'] = 'MISMATCH_OR_UNAVAILABLE:' + repr(e)
        try:
            base_after, base_acl_after = check_helper_base(uid)
            record['helper_base_after'] = list(base_after)
            record['helper_base_before'] = list(base_before)
            record['helper_base_posix_acl_names_present'] = {'before': base_acl_before, 'after': base_acl_after}
        except (SystemExit, OSError) as e:
            record['helper_base_after'] = 'UNAVAILABLE:' + repr(e)
        record['plan_sources_after_match'] = (
            record['supervisor_sha256_after'] == m['supervisorSha256'] and
            record['witness_sha256_after'] == m['witnessSha256'] and
            record['manifest_sha256_after'] == manifest_sha
        )
        record['helper_base_after_match'] = record.get('helper_base_after') == record.get('helper_base_before')
        record['post_integrity'] = ('MATCH' if record.get('source_pins_after') == 'MATCH'
                                          and record['plan_sources_after_match']
                                          and record['helper_base_after_match'] else 'HOLD')
        record['classification'] = ('TIMEOUT_HOLD; namespace cleanup UNKNOWN; retain; no retry' if record.get('timeout') else 'PROCESS_EXIT_OBSERVED_ONLY; inspect Node assertion report; no broader acceptance')
        (logs / 'final.json').write_text(json.dumps(record, indent=2) + '\n')
    return outcome_code(record)

if __name__ == '__main__':
    raise SystemExit(main())
