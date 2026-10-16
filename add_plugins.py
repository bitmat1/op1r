#!/usr/bin/env python3
"""Put your own plugin files (.op1p) into an op1r firmware file, so the OP-1's bootloader installs them with the
firmware (no USB MIDI needed):

    python3 add_plugins.py op1_246-custom.op1 op1_246-own.op1 build/plugins/lofi.op1p build/plugins/reso.op1p ...

The input must be an op1r firmware file (python3 patch_op1.py output: it has plugins/*.op1p). Each file is added as
plugins/<name>.op1p next to op1r's own plugin files, with their tar metadata; a file of the same name is replaced.
Everything else stays byte for byte as it is (checked after repacking). Install the result like any OP-1 update
(bootloader update mode). Plugins already on the OP-1 that are not in the file are kept.
Only install plugin files from people you trust: a plugin is program code with full access to the OP-1.
"""
import argparse, copy, hashlib, os, struct
import patch_op1 as P

OP1P_TMAGIC = 0x5431504F                          # "OP1T": last 16 bytes of a plugin file (op1p.h)


def check_plugin(path, data):
    name = os.path.basename(path)
    if not name.endswith('.op1p') or not all(c.isalnum() or c in '_.-' for c in name[:-5]) or not name[:-5]:
        P.fail(f'{path}: not a plugin file name (letters, digits, _ . - and .op1p)')
    if len(data) < 16 + 76 or struct.unpack('<I', data[-16:-12])[0] != OP1P_TMAGIC:
        P.fail(f'{path}: not an op1r plugin file')
    return 'plugins/' + name


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('firmware'); ap.add_argument('out'); ap.add_argument('plugins', nargs='+')
    a = ap.parse_args()
    _, members = P.unpack(open(a.firmware, 'rb').read())
    tmpl = next((m for m, _ in members if m.name.startswith('plugins/') and m.name.endswith('.op1p')), None)
    if tmpl is None:
        P.fail(f'{a.firmware}: no plugins/*.op1p inside (an op1r 34 or newer firmware file from patch_op1.py?)')
    for f in a.plugins:
        data = open(f, 'rb').read()
        name = check_plugin(f, data)
        old = next((i for i, (m, _) in enumerate(members) if m.name == name), None)
        info = copy.copy(tmpl); info.name = name
        if old is not None:
            members[old] = (info, data); print(f'  replaced {name}')
        else:                                          # keep op1r's order: plugin files sorted by name
            at = max(i for i, (m, _) in enumerate(members) if m.name == 'plugins' or (m.name.startswith('plugins/') and m.name < name)) + 1
            members.insert(at, (info, data)); print(f'  added    {name}')
    out = P.pack_op1(P.pack_tar(members))
    _, check = P.unpack(out)                         # repacked file unpacks to exactly these members
    if [(m.name, d) for m, d in check] != [(m.name, d) for m, d in members]:
        P.fail('repacked file does not match (nothing written)')
    open(a.out, 'wb').write(out)
    print(f'{a.out}: {len(out)} bytes, sha256 {hashlib.sha256(out).hexdigest()}')
    print('plugins:', ', '.join(m.name[8:] for m, _ in check if m.name.startswith('plugins/')))


if __name__ == '__main__':
    main()
