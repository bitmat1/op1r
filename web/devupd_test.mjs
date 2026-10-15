// node devupd_test.mjs: devupd.js framing against tools/op1push.py vectors + a push to a simulated OP-1
import * as DU from './devupd.js';
import assert from 'node:assert';
// vectors from op1push.py: build(DATA, 300, bytes(range(200))[:12]), crc32(b'123456789')
assert.equal(DU.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
const v = DU.build(DU.DATA, 300, Uint8Array.from({ length: 12 }, (_, i) => i * 23));
assert.equal(Buffer.from(v).toString('hex'), process.argv[2]);
for (let n = 0; n < 40; n++) { const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 255); assert.deepEqual(DU.unpack7(Uint8Array.from(DU.pack7(b))), b); }
assert(DU.pathOk('content/display/a.svg') && DU.pathOk('OP1_vdk.ldr') && !DU.pathOk('te-boot.ldr') && !DU.pathOk('content/../x'));
const ldr = new Uint8Array(200); ldr.set(new TextEncoder().encode('\n'.repeat(17) + '    op1r 32 2026-10-15 09:00\0'), 50);
assert.equal(DU.ldrIdent(ldr), 'op1r 32 2026-10-15 09:00');

// simulated OP-1: has a.svg (same size), b.svg (other size), no c.svg, runs "op1r 31"; drops every 7th DATA once
const have = { 'content/a.svg': 10, 'content/b.svg': 5 }, staged = {}, dropped = new Set();
let open = null, wr = 0, buf = [], commits = 0, ndata = 0, onmsg;
const reply = (m, st, pl = []) => onmsg({ data: DU.build(m[5] | 0x40, m[6] | m[7] << 7, Uint8Array.from([st, ...pl])) });
const u32 = (x) => [x & 255, x >> 8 & 255, x >> 16 & 255, x >>> 24];
const out = { name: 'OP-1 MIDI', send(m) {
  m = Uint8Array.from(m); const pl = DU.unpack7(m.subarray(8, m.length - 1)), cmd = m[5];
  const str = (b) => new TextDecoder().decode(b.subarray(0, b.indexOf(0)));
  setTimeout(() => {
    if (cmd === DU.HELLO) return reply(m, 0, u32(2));
    if (cmd === DU.IDENT) return reply(m, 0, [...new TextEncoder().encode('op1r 31')]);
    if (cmd === DU.STAT) { const s = have[str(pl)]; return s === undefined ? reply(m, 10) : reply(m, 0, u32(s)); }
    if (cmd === DU.ABORT) return reply(m, 0);
    if (cmd === DU.BEGIN) { open = str(pl.subarray(8)); wr = 0; buf = []; return reply(m, 0); }
    if (cmd === DU.DATA) {
      if (++ndata % 7 === 0 && !dropped.has(ndata)) { dropped.add(ndata); return; }   // lost message
      const off = pl[0] | pl[1] << 8 | pl[2] << 16 | pl[3] << 24;
      if (off !== wr) return reply(m, 5, u32(wr));
      buf.push(...pl.subarray(4)); wr += pl.length - 4; return reply(m, 0, u32(wr));
    }
    if (cmd === DU.END) { staged[open] = Uint8Array.from(buf); return reply(m, 0); }
    if (cmd === DU.COMMIT) return reply(m, ++commits < 3 ? 9 : 0);
  }, 1);
} };
const inp = { name: 'OP-1 MIDI', set onmidimessage(f) { onmsg = f; } };
const midi = { outputs: new Map([[1, out]]), inputs: new Map([[1, inp]]) };
const dev = await DU.find(midi);
assert(dev && dev.proto === 2 && dev.ident === 'op1r 31');
const big = Uint8Array.from({ length: 5000 }, (_, i) => i * 7);
await DU.push(dev, [['content/a.svg', new Uint8Array(10)], ['content/b.svg', new Uint8Array(6)], ['content/c.svg', big],
                    ['OP1_vdk.ldr', ldr], ['te-boot.ldr', new Uint8Array(4)]], () => {});
assert.deepEqual(Object.keys(staged).sort(), ['OP1_vdk.ldr', 'content/b.svg', 'content/c.svg']);
assert.deepEqual(staged['content/c.svg'], big); assert.deepEqual(staged['OP1_vdk.ldr'], ldr);
assert.equal(commits, 3);
console.log('devupd.js: ok');
