#!/usr/bin/env python3
"""Put your own plugin files (.op1p) into an op1r firmware file, so the OP-1's bootloader installs them with the
firmware (no USB MIDI needed):

    python3 add_plugins.py op1_246-custom.op1 op1_246-own.op1 build/plugins/lofi.op1p build/plugins/reso.op1p ...

The input must be an op1r firmware file (python3 patch_op1.py output: it has plugins/*.op1p). Each file is added as
plugins/<name>.op1p next to op1r's own plugin files, with their tar metadata; a file of the same name is replaced.
Everything else stays byte for byte as it is (checked after repacking). Install the result like any OP-1 update
(bootloader update mode). Plugins already on the OP-1 that are not in the file are kept.
Only install plugin files from people you trust: a plugin is program code with full access to the OP-1.

    python3 add_plugins.py --to-patcher build/plugins/lofi.op1p ...

copies the files into data/plugins/ and lists them in data/manifest.json (marked "extra"): the web patcher then shows
them before an OP-1 is connected, like op1r's own, and can put them into the firmware file it builds.
"""
import argparse, copy, hashlib, json, os, struct, sys
import patch_op1 as P

OP1P_TMAGIC = 0x5431504F                          # "OP1T": last 16 bytes of a plugin file (op1p.h)


def check_plugin(path, data):
    name = os.path.basename(path)
    if not name.endswith('.op1p') or not all(c.isalnum() or c in '_.-' for c in name[:-5]) or not name[:-5]:
        P.fail(f'{path}: not a plugin file name (letters, digits, _ . - and .op1p)')
    if len(data) < 16 + 76 or struct.unpack('<I', data[-16:-12])[0] != OP1P_TMAGIC:
        P.fail(f'{path}: not an op1r plugin file')
    return 'plugins/' + name


def plugin_info(data):
    """(name, kind, author) from a plugin file's header and metadata (as the web patcher's pluginInfo)"""
    bo, bl = struct.unpack('<II', data[-12:-4])
    h = data[bo:bo + 76]
    kind = ('synth', 'fx', 'seq')[struct.unpack('<I', h[12:16])[0]]
    name = h[16:32].split(b'\0')[0].decode()
    img, nrel, nimp = struct.unpack('<I', h[32:36])[0], *struct.unpack('<II', h[68:76])
    p = bo + 76 + img + 16 * nrel
    for _ in range(nimp):
        p = data.index(b'\0', p) + 1
    meta = data[p:bo + bl].decode('utf-8', 'replace')
    author = next((l[7:] for l in meta.split('\n') if l.startswith('author=')), '')
    return name, kind, author


def to_patcher(paths):
    """copy plugin files into data/plugins/ and list them in data/manifest.json as "extra" (the web patcher shows
    them before an OP-1 is connected and can put them into the firmware file; patch_op1.py --plugins too)"""
    here = os.path.dirname(os.path.abspath(__file__))
    mp = os.path.join(here, 'data', 'manifest.json')
    man = json.load(open(mp))
    for f in paths:
        data = open(f, 'rb').read()
        fname = os.path.basename(f)
        check_plugin(f, data)
        name, kind, author = plugin_info(data)
        old = next((p for p in man['plugins'] if p['name'] == name), None)
        if old and not old.get('extra'):
            P.fail(f'{name}: an op1r plugin of that name is already in the patcher (not replaced)')
        e = {'name': name, 'kind': kind, 'author': author, 'file': fname, 'size': len(data),
             'sha256': hashlib.sha256(data).hexdigest(), 'extra': True}
        if old:
            man['plugins'][man['plugins'].index(old)] = e
        else:
            man['plugins'].append(e)
        open(os.path.join(here, 'data', 'plugins', fname), 'wb').write(data)
        print(f'  {"updated" if old else "added  "} {kind:5s} {name} ({fname}, {len(data)} B)')
    json.dump(man, open(mp, 'w'), indent=1)
    open(mp, 'a').write('\n')


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--to-patcher':
        if len(sys.argv) < 3:
            P.fail('usage: add_plugins.py --to-patcher file.op1p ...')
        return to_patcher(sys.argv[2:])
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
