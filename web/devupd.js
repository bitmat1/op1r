// Firmware update over USB MIDI SysEx (op1r devupd protocol, see tools/op1push.py in op1r-src), for the browser.
// The OP-1 stages the files while it runs and asks before anything is applied: T1 restart + apply, T2 cancel.
// Only a physical T1 press confirms (MIDI key events are ignored while the prompt is shown).
const HDR = [0xF0, 0x00, 0x20, 0x76, 0x7D];
export const HELLO = 1, BEGIN = 2, DATA = 3, END = 4, COMMIT = 5, ABORT = 6, STAT = 7, IDENT = 8;
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
    (p === 'OP1_vdk.ldr' || p.startsWith('content/'));
}
// the user's sampler slots, settings / patches and tape clips: never sent
export const userData = (p) => /^content\/(audio\/(drum|synth)\/|op1\.db$|tape\.db$)/.test(p);
// boot text in an OP1_vdk.ldr ("op1r <n> [build time]"), null if none (as op1push.ldr_ident)
export function ldrIdent(data) {
  const s = new TextDecoder('latin1').decode(data);
  const m = s.match(/\n{17} *(op1r [ -~]*)/);
  return m ? m[1] : null;
}
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const rd32 = (b) => new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const enc = (s) => new TextEncoder().encode(s + '\0');
export function crc32(d) {
  let c = ~0;
  for (let i = 0; i < d.length; i++) { c ^= d[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}

class Link {                                        // one MIDI output + input pair
  constructor(out, inp) {
    this.out = out; this.inp = inp; this.seq = 0; this.q = []; this.wait = null;
    this.attach();
  }
  attach() {                                        // (re)take the input: only one handler per port
    this.inp.onmidimessage = (e) => { const r = parseReply(e.data); if (r) { this.q.push(r); if (this.wait) this.wait(); } };
  }
  close() { this.inp.onmidimessage = null; }
  send(cmd, pl) { this.seq = (this.seq + 1) & 0x3FFF; this.out.send(build(cmd, this.seq, pl)); return this.seq; }
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

// files: [[path, Uint8Array]]; only those that differ on the device are sent (protocol 2: STAT sizes, IDENT for the
// LDR). log(text). Resolves when the OP-1 confirmed (it then restarts and applies), rejects on refusal / cancel.
export async function push(dev, files, log) {
  const L = dev.link;
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
    log(`${keep.length} of ${files.length} files differ on the OP-1`);
    files = keep;
  }
  if (!files.length) return log('nothing to send: the OP-1 already has this firmware');
  await L.ask(ABORT);
  const total = files.reduce((n, [, d]) => n + d.length, 0), t0 = performance.now();
  let done = 0;
  for (const [p, d] of files) {
    const b = await L.ask(BEGIN, cat(u32(d.length), u32(crc32(d)), enc(p)));
    if (b.st) throw new Error(`${p}: refused (${ST[b.st] || b.st})`);
    let acked = 0, nxt = 0, inflight = new Map(), last = 0;
    while (acked < d.length) {                                   // pipelined DATA, resync on gaps / losses
      while (nxt < d.length && inflight.size < WINDOW) {
        const n = Math.min(MAX_DATA, d.length - nxt);
        inflight.set(L.send(DATA, cat(u32(nxt), d.subarray(nxt, nxt + n))), nxt); nxt += n;
      }
      const r = await L.recv(TIMEOUT);
      if (!r) { inflight.clear(); nxt = acked; continue; }
      if (r.cmd !== DATA || !inflight.has(r.seq)) continue;
      inflight.delete(r.seq);
      if (r.st !== 0 && r.st !== 5) throw new Error(`${p}: data refused (${ST[r.st] || r.st})`);
      const w = rd32(r.pl);
      if (r.st === 5) { inflight.clear(); nxt = w; }
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
  log('confirm on the OP-1: T1 restart and apply, T2 cancel');
  for (let asked = false; ;) {
    const r = await L.ask(COMMIT);
    if (r.st === 0) break;
    if (r.st === 2 && asked) throw new Error('cancelled on the OP-1');
    if (r.st !== 9) throw new Error(`commit refused (${ST[r.st] || r.st})`);
    asked = true;
    await new Promise((res) => setTimeout(res, 300));
  }
  log(`sent ${files.length} files (${(total / 1e6).toFixed(1)} MB); the OP-1 restarts and applies the update.`);
}
