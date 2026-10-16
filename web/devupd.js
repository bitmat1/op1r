// Firmware update over USB MIDI SysEx (op1r devupd protocol, see tools/op1push.py in op1r-src), for the browser.
// The OP-1 stages the files while it runs and asks before anything is applied: T1 restart + apply, T2 cancel.
// Only a physical T1 press confirms (MIDI key events are ignored while the prompt is shown).
const HDR = [0xF0, 0x00, 0x20, 0x76, 0x7D];
export const HELLO = 1, BEGIN = 2, DATA = 3, END = 4, COMMIT = 5, ABORT = 6, STAT = 7, IDENT = 8, DELETE = 9, LIST = 10;
const MAX_DATA = 192, WINDOW = 8, TIMEOUT = 2000;
const ST = { 0: 'ok', 1: 'format', 2: 'state', 3: 'path', 4: 'size', 5: 'offset', 6: 'crc', 7: 'io', 8: 'full',
             9: 'wait key', 10: 'no file' };

export function pack7(b) {
  const out = [];
  for (let i = 0; i < b.length; i += 7) {
    const g = b.subarray(i, i + 7);
    let hi = 0; g.forEach((x, k) => { hi |= (x >> 7) << k; });
    out.push(hi); g.forEach((x) => out.push(x & 0x7F));
  }
  return out;
}
export function unpack7(b) {
  const out = [];
  for (let i = 0; i < b.length;) {
    const hi = b[i++];
    for (let k = 0; k < 7 && i < b.length; k++, i++) out.push(b[i] | ((hi >> k) & 1) << 7);
  }
  return Uint8Array.from(out);
}
export function build(cmd, seq, payload = new Uint8Array()) {
  const m = [...HDR, cmd, seq & 0x7F, (seq >> 7) & 0x7F, ...pack7(payload), 0xF7];
  if (m.length > 256) throw new Error('message too long');
  return Uint8Array.from(m);
}
export function parseReply(m) {
  if (m.length < 10 || HDR.some((x, i) => m[i] !== x) || m[m.length - 1] !== 0xF7 || !(m[5] & 0x40)) return null;
  const pl = unpack7(m.subarray(8, m.length - 1));
  return { cmd: m[5] & 0x3F, seq: m[6] | m[7] << 7, st: pl[0], pl: pl.subarray(1) };
}
export function pathOk(p) {
  const low = p.toLowerCase();
  return /^[A-Za-z0-9_.\-/]+$/.test(p) && p.length < 96 && !p.startsWith('/') && !p.endsWith('/') &&
    !/te-boot|te_boot|teboot/.test(low) && !p.includes('..') && !p.includes('//') &&
    (p === 'OP1_vdk.ldr' || p.startsWith('content/') || pluginPath(p));
}
// plugin files (synth engines / FX loaded at boot, protocol 3 can list and delete them)
export const pluginPath = (p) => /^plugins\/[A-Za-z0-9_.\-]+\.op1p$/.test(p);   // (the name before .op1p: at least one character)
// the user's sampler slots, settings / patches and tape clips: never sent
export const userData = (p) => /^content\/(audio\/(drum|synth)\/|op1\.db$|tape\.db$)/.test(p);
// boot text in an OP1_vdk.ldr ("op1r <n> [build time]"), null if none (as op1push.ldr_ident)
export function ldrIdent(data) {
  const s = new TextDecoder('latin1').decode(data);
  const m = s.match(/\n{17} *(op1r [ -~]*)/);
  return m ? m[1] : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const rd32 = (b) => new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const enc = (s) => new TextEncoder().encode(s + '\0');
export function crc32(d) {
  let c = ~0;
  for (let i = 0; i < d.length; i++) { c ^= d[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}

// debugging: trace.fn(text) gets every MIDI message sent and received (time, direction, command, size, bytes)
export const trace = { fn: null, t0: 0 };
const NAMES = { 1: 'HELLO', 2: 'BEGIN', 3: 'DATA', 4: 'END', 5: 'COMMIT', 6: 'ABORT', 7: 'STAT', 8: 'IDENT', 9: 'DELETE', 10: 'LIST' };
const hex = (b, n = 24) => [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > n ? ' ..' : '');
function tr(dir, m, note = '') {
  if (!trace.fn) return;
  const t = ((performance.now() - trace.t0) / 1000).toFixed(3);
  let what = 'other MIDI';
  if (m.length > 7 && HDR.every((x, i) => m[i] === x)) {
    const r = parseReply(m);
    what = r ? `${NAMES[r.cmd] || r.cmd} reply seq ${r.seq}: ${ST[r.st] || r.st}`
             : `${NAMES[m[5]] || m[5]} seq ${m[6] | m[7] << 7}`;
  }
  trace.fn(`${t} ${dir} ${what}, ${m.length} B${m[m.length - 1] === 0xF7 || m[0] !== 0xF0 ? '' : ' (no F7!)'}${note}  [${hex(m)}]`);
}

class Link {                                        // one MIDI output + input pair
  constructor(out, inp) {
    this.out = out; this.inp = inp; this.seq = 0; this.q = []; this.wait = null;
    this.attach();
  }
  attach() {                                        // (re)take the input: only one handler per port
    this.inp.onmidimessage = (e) => {
      const r = parseReply(e.data);
      tr('<-', e.data);
      if (r) { this.q.push(r); if (this.wait) this.wait(); }
    };
  }
  close() { this.inp.onmidimessage = null; }
  send(cmd, pl, when) {
    this.seq = (this.seq + 1) & 0x3FFF;
    const m = build(cmd, this.seq, pl);
    tr('->', m);
    if (when) this.out.send(m, when); else this.out.send(m);
    return this.seq;
  }
  recv(ms) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((res) => {
      const t = setTimeout(() => { this.wait = null; res(null); }, ms);
      this.wait = () => { clearTimeout(t); this.wait = null; res(this.q.shift()); };
    });
  }
  async ask(cmd, pl = new Uint8Array(), tries = 8, ms = TIMEOUT) {
    for (let i = 0; i < tries; i++) {
      const seq = this.send(cmd, pl);
      for (let r; (r = await this.recv(ms));) if (r.cmd === cmd && r.seq === seq) return r;
    }
    throw new Error(`the OP-1 does not answer (command ${cmd})`);
  }
}

// -> { link, proto, ident } of the first OP-1 that answers HELLO, or null
export async function find(midi) {
  const outs = [...midi.outputs.values()], ins = [...midi.inputs.values()];
  const op1 = (p) => /op-?1/i.test(p.name || '');
  for (const out of outs.filter(op1)) {
    for (const inp of ins.filter(op1)) {
      const link = new Link(out, inp);
      try {
        const r = await link.ask(HELLO, undefined, 2, 600);
        const proto = rd32(r.pl);
        const ident = proto >= 2 ? new TextDecoder().decode((await link.ask(IDENT)).pl) : '';
        return { link, proto, ident };
      } catch { link.close(); }
    }
  }
  return null;
}

// plugin files on the OP-1 (protocol 3): [{ file, size }]
export async function list(dev) {
  if (dev.proto < 3) throw new Error('this OP-1 firmware cannot list plugin files (update the firmware first)');
  const L = dev.link, out = [];
  L.attach(); L.q = [];
  for (let i = 0; ; i++) {
    const r = await L.ask(LIST, Uint8Array.from([i & 255, i >> 8]));
    if (r.st) break;
    out.push({ file: new TextDecoder().decode(r.pl.subarray(4)), size: rd32(r.pl) });
  }
  return out;
}

// files: [[path, Uint8Array]]; only those that differ on the device are sent (protocol 2: STAT sizes, IDENT for the
// LDR). log(text). Resolves when the OP-1 confirmed (it then restarts and applies), rejects on refusal / cancel.
// DATA without an answer: resent one message at a time, then in ever smaller messages (192 -> 96 -> 48 -> 24 data
// bytes: on some hosts the long DATA messages never reach the OP-1 while the short commands do); the size that works
// is kept for the rest of the connection (dev.win, dev.chunk). After MAX_STALLS timeouts in a row at the smallest
// size without progress: rejected.
const MAX_STALLS = 8, MIN_DATA = 24;
// Start settings. Measured 2026-10-16 (op1r 35, macOS Chrome, debug probe): DATA messages up to 87 bytes on the wire
// (64 data bytes) are answered; a 105-byte one is never answered and the OP-1's update handling stops (no answer to
// anything until it restarts). So: 48 data bytes (69 bytes on the wire), one at a time. op1r's own default was 192 / 8.
export const DEFAULTS = { chunk: 48, win: 1 };
// opts: timeout (ms per answer), chunk (data bytes per DATA message, 1..192), win (messages in flight), gap (ms
// between DATA messages: paces them, one at a time). Without chunk / win the sizes adapt as described above.
export async function push(dev, files, log, deletes = [], opts = {}) {   // deletes: plugin paths (protocol 3)
  const L = dev.link, tmo = opts.timeout || TIMEOUT, gap = opts.gap || 0, fixed = !!(opts.chunk || opts.win);
  if (opts.chunk) dev.chunk = Math.max(1, Math.min(MAX_DATA, opts.chunk));
  if (opts.win) dev.win = Math.max(1, Math.min(WINDOW, opts.win));
  if (gap) dev.win = 1;
  if (fixed || gap) log(`sending ${dev.chunk || DEFAULTS.chunk}-byte data messages, ${dev.win || DEFAULTS.win} at a time` + (gap ? `, ${gap} ms apart` : ''));
  L.attach(); L.q = [];
  log('asking the OP-1 which files it has ...');
  files = files.filter(([p]) => pathOk(p) && !userData(p));
  if (dev.proto >= 2) {
    const keep = [];
    for (const [p, d] of files) {
      let same;
      if (p === 'OP1_vdk.ldr') same = ldrIdent(d) === dev.ident;
      else { const r = await L.ask(STAT, enc(p)); same = r.st === 0 && rd32(r.pl) === d.length; }
      if (!same) { keep.push([p, d]); log(`  differs: ${p}`); }
    }
    const db = files.find(([p]) => p === 'content/op1_factory.db');   // engine / FX rows: often the same size
    if (keep.some(([p]) => p === 'OP1_vdk.ldr') && db && !keep.includes(db)) { keep.push(db); log(`  with the firmware: ${db[0]}`); }
    log(`${keep.length} of ${files.length} files differ on the OP-1`);
    files = keep;
  }
  deletes = deletes.filter(pluginPath);
  if (deletes.length && dev.proto < 3) throw new Error('this OP-1 firmware cannot delete plugin files (update the firmware first)');
  if (!files.length && !deletes.length) return log('nothing to send: the OP-1 already has all of it');
  await L.ask(ABORT);
  const total = files.reduce((n, [, d]) => n + d.length, 0), t0 = performance.now();
  let done = 0;
  for (const [p, d] of files) {
    const b = await L.ask(BEGIN, cat(u32(d.length), u32(crc32(d)), enc(p)));
    if (b.st) throw new Error(`${p}: refused (${ST[b.st] || b.st})`);
    let acked = 0, nxt = 0, inflight = new Map(), last = 0, stalls = 0, reduced = false;
    let win = dev.win || DEFAULTS.win, chunk = dev.chunk || DEFAULTS.chunk;
    while (acked < d.length) {                                   // pipelined DATA, resync on gaps / losses
      while (nxt < d.length && inflight.size < win) {
        if (gap) await sleep(gap);
        const n = Math.min(chunk, d.length - nxt);
        inflight.set(L.send(DATA, cat(u32(nxt), d.subarray(nxt, nxt + n))), nxt); nxt += n;
      }
      const r = await L.recv(tmo);
      if (!r) {
        if (fixed || gap) { if (++stalls >= MAX_STALLS) throw new Error(`${p}: no answer to data messages with these settings (${acked} of ${d.length} bytes)`);
                            log(`  ${p}: no answer, resending from byte ${acked} (${stalls} of ${MAX_STALLS - 1})`); }
        else if (win > 1) { win = 1; log(`  ${p}: no answer from the OP-1, sending one message at a time`); }
        else if (chunk > MIN_DATA) { chunk = Math.max(MIN_DATA, chunk >> 1); log(`  ${p}: no answer, trying ${chunk}-byte messages`); }
        else if (++stalls >= MAX_STALLS)
          throw new Error(`${p}: the OP-1 does not answer data messages (${acked} of ${d.length} bytes sent, ` +
                          `${MIN_DATA}-byte messages one at a time). Restart it and try again; if it keeps happening, ` +
                          'install the plugin with a firmware file (bootloader update)');
        else log(`  ${p}: no answer from the OP-1, resending from byte ${acked} (${stalls} of ${MAX_STALLS - 1})`);
        reduced = true; inflight.clear(); nxt = acked; continue;
      }
      if (r.cmd !== DATA || !inflight.has(r.seq)) continue;
      inflight.delete(r.seq);
      if (r.st !== 0 && r.st !== 5) throw new Error(`${p}: data refused (${ST[r.st] || r.st})`);
      const w = rd32(r.pl);
      if (r.st === 5) { inflight.clear(); nxt = w; }
      if (w > acked) {
        stalls = 0;
        if (reduced && (dev.win !== win || dev.chunk !== chunk)) log(`  the OP-1 answers ${chunk}-byte messages, ${win} at a time: using that`);
        dev.win = win; dev.chunk = chunk;
      }
      acked = Math.max(acked, w);
      if (acked - last >= 262144 || acked === d.length) {
        last = acked;
        log(`  ${p}: ${Math.round((done + acked) / total * 100)} %  (${((done + acked) / (performance.now() - t0)).toFixed(1)} kB/s)`);
      }
    }
    done += d.length;
    const e = await L.ask(END);
    if (e.st) throw new Error(`${p}: ${ST[e.st] || e.st}`);
  }
  for (const p of deletes) {
    const r = await L.ask(DELETE, enc(p));
    if (r.st) throw new Error(`${p}: delete refused (${ST[r.st] || r.st})`);
    log(`  delete: ${p}`);
  }
  log('confirm on the OP-1: T1 restart and apply, T2 cancel');
  for (let asked = false; ;) {
    const r = await L.ask(COMMIT);
    if (r.st === 0) break;
    if (r.st === 2 && asked) throw new Error('cancelled on the OP-1');
    if (r.st !== 9) throw new Error(`commit refused (${ST[r.st] || r.st})`);
    asked = true;
    await new Promise((res) => setTimeout(res, 300));
  }
  log(`sent ${files.length} files (${(total / 1e6).toFixed(2)} MB)` + (deletes.length ? `, ${deletes.length} deletes` : '') +
      '; the OP-1 restarts and applies the update.');
}

// Probe the USB link (no file is written): after ABORT the OP-1 answers every DATA message with "state" (no file
// open), whatever its size. So DATA messages of growing size show which sizes get through, and bursts with and
// without a gap show whether pacing matters. log(text); returns { sizes: [{ data, wire, ok, ms }], bursts: [...] }.
export async function probe(dev, log, opts = {}) {
  const L = dev.link, tmo = opts.timeout || 1500;
  L.attach(); L.q = [];
  log(`probe: ${dev.ident || 'op1r'}, update protocol ${dev.proto}`);
  const a = await L.ask(ABORT);
  log(`  ABORT answered (${ST[a.st] || a.st})`);
  const one = async (n) => {
    const t = performance.now(), seq = L.send(DATA, cat(u32(0), new Uint8Array(n).map((_, i) => i * 37)));
    for (let r; (r = await L.recv(tmo));) if (r.cmd === DATA && r.seq === seq) return { ok: true, st: r.st, ms: performance.now() - t };
    return { ok: false };
  };
  const wire = (n) => build(DATA, 0, new Uint8Array(4 + n)).length;
  const sizes = [];
  log('  DATA size test (data bytes -> bytes on the wire): answered?');
  const alive = async () => {                                     // does the OP-1 still answer anything?
    for (let i = 0; i < 2; i++) {
      const seq = L.send(HELLO);
      for (let r; (r = await L.recv(tmo));) if (r.cmd === HELLO && r.seq === seq) return true;
    }
    return false;
  };
  let dead = null;
  for (const n of [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192]) {
    let r = await one(n);
    if (!r.ok) r = await one(n);                                   // one retry
    sizes.push({ data: n, wire: wire(n), ok: r.ok, ms: r.ms });
    const up = await alive();
    log(`    ${String(n).padStart(3)} -> ${String(wire(n)).padStart(3)} B: ` + (r.ok ? `yes (${ST[r.st] || r.st}, ${r.ms.toFixed(0)} ms)` : 'NO ANSWER') +
        (up ? '' : '  -- and the OP-1 no longer answers HELLO'), up ? undefined : 'err');
    if (!up) { dead = wire(n); break; }
  }
  if (dead) {
    log(`  the OP-1 stopped answering anything after a ${dead}-byte DATA message: it breaks on receiving it ` +
        '(restart the OP-1 before trying again)', 'err');
    return { sizes, bursts: [], dead };
  }
  const good = sizes.filter((s) => s.ok), bad = sizes.filter((s) => !s.ok);
  if (!bad.length) log('  every size got through');
  else if (!good.length) log('  no DATA message got through, at any size: the OP-1 does not handle DATA at all', 'err');
  else log(`  largest answered: ${Math.max(...good.map((s) => s.wire))} B on the wire; first lost: ${bad[0].wire} B`);
  const bursts = [], n = good.length ? Math.max(...good.map((s) => s.data)) : 0;
  if (good.length) {
    log(`  bursts of 8 DATA messages of ${n} data bytes:`);
    for (const g of [0, 5, 20, 50]) {
      L.q = [];
      const seqs = new Set(), t = performance.now();
      for (let i = 0; i < 8; i++) { if (g && i) await sleep(g); seqs.add(L.send(DATA, cat(u32(0), new Uint8Array(n)))); }
      let got = 0;
      for (let r; got < 8 && (r = await L.recv(tmo));) if (r.cmd === DATA && seqs.has(r.seq)) got++;
      bursts.push({ gap: g, got, ms: performance.now() - t });
      log(`    ${String(g).padStart(2)} ms apart: ${got} of 8 answered (${(performance.now() - t).toFixed(0)} ms)`);
    }
  }
  log(`  ABORT again (${ST[(await L.ask(ABORT)).st]})`);
  return { sizes, bursts };
}
