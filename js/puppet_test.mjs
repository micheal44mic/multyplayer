// @ts-nocheck - differential test with a fake store (node js/puppet_test.mjs)
import { buildPuppetMesh, PuppetSolver, puppetTriOrder, puppetStore } from './puppet.js';
import { chunkKey } from './store.js';
const CHUNK = 256;
function makeStore() {
  const map = new Map();
  return {
    map,
    getOrCreate(cx, cy) {
      const key = chunkKey(cx, cy);
      let c = map.get(key);
      if (!c) { c = { key, cx, cy, data: new Uint8ClampedArray(CHUNK * CHUNK * 4), touched: false }; map.set(key, c); }
      return c;
    },
    remove(key, cb) { const c = map.get(key); if (c) { if (cb) cb(c); map.delete(key); } },
    markDirty() {},
  };
}
const store = makeStore();
// Gradient disk, useful for catching channel shifts.
for (let y = 100; y <= 500; y++) for (let x = 100; x <= 500; x++) {
  const dx = x - 300, dy = y - 300;
  if (dx * dx + dy * dy > 200 * 200) continue;
  const c = store.getOrCreate(x >> 8, y >> 8);
  const o = ((y & 255) * CHUNK + (x & 255)) * 4;
  c.data[o] = x & 255; c.data[o + 1] = y & 255; c.data[o + 2] = 128; c.data[o + 3] = 255;
}
const snapshot = new Map();
for (const [k, c] of store.map) snapshot.set(k, c.data.slice());
const bbox = { x: 100, y: 100, w: 401, h: 401 };
const mesh = buildPuppetMesh(store, bbox, 2, 'normal');
const n = mesh.pos0.length / 2;
const srcBox = { x: 0, y: 0, w: 512, h: 512 };
const clip = { x0: 0, y0: 0, x1: 2047, y1: 2047 };
const vdep = new Float32Array(n);

// 1) identity: def = pos0 -> bit-exact pixels inside the mesh.
{
  const def = mesh.pos0.slice();
  const order = puppetTriOrder(mesh.pos0, def, mesh.tris, vdep);
  let captured = 0;
  puppetStore(store, mesh.pos0, def, mesh.tris, order, srcBox, clip, () => captured++, () => {});
  let diff = 0, lost = 0, total = 0;
  for (const [k, before] of snapshot) {
    const c = store.map.get(k);
    for (let o = 0; o < before.length; o += 4) {
      if (before[o + 3] === 0) continue;
      total++;
      const after = c ? c.data : null;
      if (!after || after[o + 3] === 0) { lost++; continue; }
      if (after[o] !== before[o] || after[o + 1] !== before[o + 1] || after[o + 2] !== before[o + 2] || after[o + 3] !== before[o + 3]) diff++;
    }
  }
  console.log(`identity: total=${total} diff=${diff} lost=${lost} captured=${captured}`);
}
// 2) real deformation: no NaN values, plausible pixel count.
{
  // Restore the store.
  for (const [k, d] of snapshot) { const c = store.map.get(k) || store.getOrCreate(0,0); }
  store.map.clear();
  for (const [k, d] of snapshot) {
    const cx = (k >>> 16) - 32768, cy = (k & 0xffff) - 32768; // if chunkKey is cx<<16|cy with offset... rebuild from data
  }
  // Simpler: rebuild from scratch.
  for (let y = 100; y <= 500; y++) for (let x = 100; x <= 500; x++) {
    const dx = x - 300, dy = y - 300;
    if (dx * dx + dy * dy > 200 * 200) continue;
    const c = store.getOrCreate(x >> 8, y >> 8);
    const o = ((y & 255) * CHUNK + (x & 255)) * 4;
    c.data[o] = x & 255; c.data[o + 1] = y & 255; c.data[o + 2] = 128; c.data[o + 3] = 255;
  }
  let vBot = 0;
  for (let i = 0; i < n; i++) if (mesh.pos0[i*2+1] > mesh.pos0[vBot*2+1]) vBot = i;
  let vTop = 0;
  for (let i = 0; i < n; i++) if (mesh.pos0[i*2+1] < mesh.pos0[vTop*2+1]) vTop = i;
  const solver = new PuppetSolver(mesh.pos0, mesh.tris);
  const pins = [
    { v: vTop, tx: mesh.pos0[vTop*2], ty: mesh.pos0[vTop*2+1], fixed: false, rot: 0 },
    { v: vBot, tx: mesh.pos0[vBot*2] + 150, ty: mesh.pos0[vBot*2+1], fixed: false, rot: 0 },
  ];
  solver.setPins(pins);
  const def = mesh.pos0.slice();
  for (let k = 0; k < 12; k++) solver.step(def, pins, 'normal', 2);
  const order = puppetTriOrder(mesh.pos0, def, mesh.tris, vdep);
  const t0 = performance.now();
  puppetStore(store, mesh.pos0, def, mesh.tris, order, srcBox, clip, () => {}, () => {});
  let after = 0;
  for (const c of store.map.values()) for (let o = 3; o < c.data.length; o += 4) if (c.data[o] > 0) after++;
  console.log(`deformed: px=${after} (original approx. 125629), commit=${(performance.now()-t0).toFixed(0)}ms, chunks=${store.map.size}`);
}
