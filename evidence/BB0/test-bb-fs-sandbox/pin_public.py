#!/usr/bin/env python3
"""Static public dependency inventory; no ELF execution, loader or subprocess calls."""
import hashlib
import json
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent
APP = Path('/home/ubuntu/.bb-server/app/node_modules')
NODE = Path('/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node')


def digest(p):
    with p.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(root):
    entries = []
    for p in sorted(root.rglob('*')):
        name = str(p.relative_to(root))
        if p.is_symlink():
            target = p.resolve(strict=True)
            if not target.is_relative_to(root):
                raise ValueError(f'foreign dependency symlink: {p}')
            entries.append({'path': name, 'link': p.readlink().as_posix(), 'resolved': str(target)})
        elif p.is_file():
            entries.append({'path': name, 'sha256': digest(p), 'mode': p.stat().st_mode & 0o777})
        elif not p.is_dir():
            raise ValueError(f'nonregular public dependency: {p}')
    return entries


def elf_requirements(p):
    b = p.read_bytes()
    if b[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', b, 18)[0] != 62:
        raise ValueError(f'expected ELF64 little-endian x86_64: {p}')
    phoff, shoff = struct.unpack_from('<QQ', b, 32)
    phsize, phnum, shsize, shnum = struct.unpack_from('<HHHH', b, 54)
    needed = []
    for i in range(phnum):
        ph = struct.unpack_from('<IIQQQQQQ', b, phoff + phsize * i)
        if ph[0] == 3:
            needed.append(b[ph[2]:ph[2] + ph[5]].rstrip(b'\0').decode())
    sections = [struct.unpack_from('<IIQQQQIIQQ', b, shoff + shsize * i) for i in range(shnum)]
    for section in sections:
        if section[1] != 6:
            continue
        strings = sections[section[6]]
        table = b[strings[4]:strings[4] + strings[5]]
        for pos in range(section[4], section[4] + section[5], 16):
            tag, value = struct.unpack_from('<qQ', b, pos)
            if tag == 1:
                needed.append(table[value:table.index(b'\0', value)].decode())
    return needed


def capture():
    entries = inventory(APP)
    seeds = [NODE, Path('/bin/sh'), Path('/bin/bash'), Path('/usr/bin/env'), Path('/usr/bin/ps')]
    native = [APP / e['path'] for e in entries if e['path'].endswith('.node')
              and ('linux-x64' in e['path'])]
    queue = seeds + native
    mounted = {str(p): p.resolve(strict=True) for p in seeds}
    seen = set()
    while queue:
        p = queue.pop()
        resolved = p.resolve(strict=True)
        if resolved in seen:
            continue
        seen.add(resolved)
        for name in elf_requirements(resolved):
            candidates = [Path(name)] if name.startswith('/') else [Path('/lib/x86_64-linux-gnu') / name]
            target = candidates[0]
            if not target.is_file():
                raise ValueError(f'missing static ELF dependency: {name}')
            real = target.resolve(strict=True)
            if not real.is_relative_to('/usr/lib'):
                raise ValueError(f'foreign OS dependency: {real}')
            mounted[str(target)] = real
            queue.append(target)
    term = Path('/usr/share/terminfo/x/xterm-256color')
    if not term.is_file():
        raise ValueError('missing xterm-256color public terminfo')
    mounted[str(term)] = term.resolve(strict=True)
    return {
        'schemaVersion': 1,
        'closure': 'UNAVAILABLE: static ELF closure only; runtime dlopen, NSS, utilities and BB startup untested',
        'appRoot': str(APP), 'appEntries': entries,
        'fileMounts': [{'source':str(src), 'destination':dest, 'sha256':digest(src)}
                       for dest, src in sorted(mounted.items())],
        'outerBwrap': {'path':'/usr/bin/bwrap', 'resolved':str(Path('/usr/bin/bwrap').resolve(strict=True)),
                       'sha256':digest(Path('/usr/bin/bwrap'))},
    }


if __name__ == '__main__':
    print(json.dumps(capture(), sort_keys=True, indent=2))
