// node devupd_test.mjs: devupd.js framing against tools/op1push.py vectors + a push to a simulated OP-1
import * as DU from './devupd.js';
import assert from 'node:assert';
DU.DEFAULTS.chunk = 192; DU.DEFAULTS.win = 8;                    // op1r's original start settings (the last test uses the new ones)
// vectors from op1push.py: build(DATA, 300, bytes(range(200))[:12]), crc32(b'123456789')
assert.equal(DU.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
const v = DU.build(DU.DATA, 300, Uint8Array.from({ length: 12 }, (_, i) => i * 23));
assert.equal(Buffer.from(v).toString('hex'), process.argv[2]);
for (let n = 0; n < 40; n++) { const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 255); assert.deepEqual(DU.unpack7(Uint8Array.from(DU.pack7(b))), b); }
assert(DU.userData('content/audio/drum/drum_1.raw') && DU.userData('content/tape.db') && !DU.userData('content/op1_factory.db') && !DU.userData('content/op1.dbx'));
assert(DU.pathOk('content/display/a.svg') && DU.pathOk('OP1_vdk.ldr') && !DU.pathOk('te-boot.ldr') && !DU.pathOk('content/../x'));
assert(DU.pathOk('plugins/bell.op1p') && !DU.pathOk('plugins/a/b.op1p') && !DU.pathOk('plugins/x.svg') && !DU.pluginPath('plugins/.op1p'));
const ldr = new Uint8Array(200); ldr.set(new TextEncoder().encode('\n'.repeat(17) + '    op1r 32 2026-10-15 09:00\0'), 50);
assert.equal(DU.ldrIdent(ldr), 'op1r 32 2026-10-15 09:00');

// simulated OP-1: has a.svg (same size), b.svg (other size), no c.svg, runs "op1r 31"; drops every 7th DATA once
const have = { 'content/a.svg': 10, 'content/b.svg': 5, 'plugins/x.op1p': 3, 'plugins/y.op1p': 4 }, staged = {}, dropped = new Set(), deleted = [];
let proto = 2;
let open = null, wr = 0, buf = [], commits = 0, ndata = 0, onmsg;
const reply = (m, st, pl = []) => onmsg({ data: DU.build(m[5] | 0x40, m[6] | m[7] << 7, Uint8Array.from([st, ...pl])) });
const u32 = (x) => [x & 255, x >> 8 & 255, x >> 16 & 255, x >>> 24];
const out = { name: 'OP-1 MIDI', send(m) {
  m = Uint8Array.from(m); const pl = DU.unpack7(m.subarray(8, m.length - 1)), cmd = m[5];
  const str = (b) => new TextDecoder().decode(b.subarray(0, b.indexOf(0)));
  setTimeout(() => {
    if (cmd === DU.HELLO) return reply(m, 0, u32(proto));
    if (cmd === DU.LIST) { const ps = Object.keys(have).filter((k) => k.startsWith('plugins/')), i = pl[0] | pl[1] << 8;
      return i < ps.length ? reply(m, 0, [...u32(have[ps[i]]), ...new TextEncoder().encode(ps[i].slice(8))]) : reply(m, 10); }
    if (cmd === DU.DELETE) { deleted.push(str(pl)); return reply(m, 0); }
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
// protocol 3: list + engines-only update (no firmware): x.op1p same size (skipped), z.op1p new, y.op1p deleted
proto = 3; commits = 0; for (const k in staged) delete staged[k];
const dev3 = await DU.find(midi);
assert.equal(dev3.proto, 3);
assert.deepEqual(await DU.list(dev3), [{ file: 'x.op1p', size: 3 }, { file: 'y.op1p', size: 4 }]);
await DU.push(dev3, [['plugins/x.op1p', new Uint8Array(3)], ['plugins/z.op1p', big]], () => {}, ['plugins/y.op1p', 'content/op1.db']);
assert.deepEqual(Object.keys(staged), ['plugins/z.op1p']); assert.deepEqual(deleted, ['plugins/y.op1p']);
proto = 2; const dev2 = await DU.find(midi);
await assert.rejects(DU.list(dev2)); await assert.rejects(DU.push(dev2, [], () => {}, ['plugins/y.op1p']));

// a slow OP-1 (protocol 3): mode 'busy' loses every DATA that arrives while another one is unanswered (a full
// window overruns its RX ring), 'big' loses every message longer than 100 bytes (long SysEx not getting through),
// 'dead' never answers DATA; everything else is answered
async function slowDevice(mode) {
  let handler, file = null, pend = 0, broken = false;
  const done = {};
  const o = { name: 'OP-1 MIDI', send(m) {
    m = Uint8Array.from(m); const pl = DU.unpack7(m.subarray(8, m.length - 1)), cmd = m[5];
    const rep = (st, p = []) => handler({ data: DU.build(m[5] | 0x40, m[6] | m[7] << 7, Uint8Array.from([st, ...p])) });
    if (cmd === DU.DATA) {
      if (m.length > 100 && mode === 'breaks') broken = true;
      if (broken || mode === 'dead' || (mode === 'busy' && pend) || (mode === 'big' && m.length > 100)) return;   // lost
      pend++;
      return setTimeout(() => {
        pend--;
        if (!file) return rep(2);                                // no BEGIN: "state", as du.c
        const off = pl[0] | pl[1] << 8 | pl[2] << 16 | pl[3] << 24;
        if (off !== file.length) return rep(5, u32(file.length));
        file.push(...pl.subarray(4)); rep(0, u32(file.length));
      }, 3);
    }
    if (broken) return;
    setTimeout(() => {
      if (cmd === DU.HELLO) return rep(0, u32(3));
      if (cmd === DU.IDENT) return rep(0, [...new TextEncoder().encode('op1r 34')]);
      if (cmd === DU.STAT) return rep(10);
      if (cmd === DU.BEGIN) { file = []; return rep(0); }
      if (cmd === DU.END) { done.data = Uint8Array.from(file); file = null; return rep(0); }
      if (cmd === DU.ABORT) { file = null; return rep(0); }
      return rep(0);                                             // ABORT, COMMIT
    }, 1);
  } };
  const i = { name: 'OP-1 MIDI', set onmidimessage(f) { handler = f; } };
  const d = await DU.find({ outputs: new Map([[1, o]]), inputs: new Map([[1, i]]) });
  return { d, done };
}
{
  const { d, done } = await slowDevice('busy'), lines = [];
  await DU.push(d, [['plugins/fix.op1p', big]], (t) => lines.push(t), [], { timeout: 30 });
  assert.deepEqual(done.data, big);
  assert(lines.some((t) => /one message at a time/.test(t)));
}
{
  const { d } = await slowDevice('dead');
  await assert.rejects(DU.push(d, [['plugins/fix.op1p', big]], () => {}, [], { timeout: 10 }), /does not answer data messages \(0 of 5000/);
}
{
  const { d, done } = await slowDevice('big'), lines = [];
  await DU.push(d, [['plugins/fix.op1p', big]], (t) => lines.push(t), [], { timeout: 10 });
  assert.deepEqual(done.data, big);
  assert(lines.some((t) => /answers 48-byte messages, 1 at a time/.test(t)), lines.join('\n'));
  assert.equal(d.chunk, 48);
  const again = [];                                               // the same connection: starts at the size that works
  await DU.push(d, [['plugins/fix2.op1p', big.subarray(0, 3000)]], (t) => again.push(t), [], { timeout: 10 });
  assert(!again.some((t) => /no answer/.test(t)), again.join('\n'));
  assert.deepEqual(done.data, big.subarray(0, 3000));
}
{                                                                 // probe: finds the size limit
  const { d } = await slowDevice('big'), lines = [];
  const r = await DU.probe(d, (t) => lines.push(t), { timeout: 20 });
  assert(r.sizes.find((x) => x.data === 48).ok && !r.sizes.find((x) => x.data === 96).ok, lines.join('\n'));
  assert(lines.some((t) => /largest answered: \d+ B on the wire; first lost/.test(t)));
  assert(r.bursts.length === 4);
}
{                                                                 // probe: DATA never answered
  const { d } = await slowDevice('dead'), lines = [];
  const r = await DU.probe(d, (t) => lines.push(t), { timeout: 5 });
  assert(r.sizes.every((x) => !x.ok) && lines.some((t) => /no DATA message got through/.test(t)));
}
{                                                                 // fixed settings + pause + trace
  const { d, done } = await slowDevice('big'), tl = [];
  DU.trace.fn = (t) => tl.push(t); DU.trace.t0 = performance.now();
  await DU.push(d, [['plugins/fix.op1p', big.subarray(0, 600)]], () => {}, [], { timeout: 20, chunk: 32, gap: 2 });
  DU.trace.fn = null;
  assert.deepEqual(done.data, big.subarray(0, 600));
  assert(tl.some((t) => /-> DATA seq \d+, \d+ B/.test(t)) && tl.some((t) => /<- DATA reply seq \d+: ok/.test(t)), tl.slice(0, 5).join('\n'));
  const { d: d2 } = await slowDevice('big');                     // fixed size that does not get through: rejected
  await assert.rejects(DU.push(d2, [['plugins/fix.op1p', big]], () => {}, [], { timeout: 5, chunk: 192 }), /with these settings/);
}
{                                                                 // probe: a message that breaks the OP-1
  const { d } = await slowDevice('breaks'), lines = [];
  const r = await DU.probe(d, (t) => lines.push(t), { timeout: 10 });
  assert.equal(r.dead, DU.build(DU.DATA, 0, new Uint8Array(4 + 80)).length, lines.join('\n'));
  assert(lines.some((t) => /stopped answering anything after a \d+-byte DATA message/.test(t)));
}
{                                                                 // the new defaults: an OP-1 that breaks on long messages
  DU.DEFAULTS.chunk = 48; DU.DEFAULTS.win = 1;
  const { d, done } = await slowDevice('breaks'), lines = [];
  await DU.push(d, [['plugins/wheel.op1p', big]], (t) => lines.push(t), [], { timeout: 10 });
  assert.deepEqual(done.data, big); assert(!lines.some((t) => /no answer/.test(t)));
}
console.log('devupd.js: ok');
