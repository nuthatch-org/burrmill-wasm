// A zip of stored (uncompressed) files: a nest is a few hundred kilobytes of text, and a fixed
// timestamp keeps the same nest the same bytes.

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// `files` is [[path, Uint8Array]]. Answers the archive's bytes.
export function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = enc.encode(path);
    const crc = crc32(data);
    // version 20, UTF-8 names (bit 11), stored, 1980-01-01 00:00.
    const head = (sig) => {
      const h = new DataView(new ArrayBuffer(sig === 0x04034b50 ? 30 : 46));
      let i = 0;
      const u16 = (v) => { h.setUint16(i, v, true); i += 2; };
      const u32 = (v) => { h.setUint32(i, v, true); i += 4; };
      u32(sig);
      if (sig === 0x02014b50) u16(20);
      u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);
      u32(crc); u32(data.length); u32(data.length); u16(name.length); u16(0);
      if (sig === 0x02014b50) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return new Uint8Array(h.buffer);
    };
    const local = head(0x04034b50);
    parts.push(local, name, data);
    central.push(head(0x02014b50), name);
    offset += local.length + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
