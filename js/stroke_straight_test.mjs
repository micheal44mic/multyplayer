import assert from 'node:assert/strict';
import { brush as baseBrush } from './brush.js';
import { DabQueue, StrokeEngine, T_SEG } from './stroke.js';

const TWO_PI = Math.PI * 2;
const QUEUE_STRIDE = 10;

/** @returns {import('./brush.js').Brush} */
function testBrush() {
  return /** @type {import('./brush.js').Brush} */ ({
    ...baseBrush,
    color: { ...baseBrush.color },
    texture: null,
    shape: null,
    tool: 'brush',
    size: 24,
    spacing: 0.04,
    smoothing: 0.2,
    roundness: 1,
    scatter: false,
    jitterPos: 0,
    jitterSize: 0,
    jitterOpacity: 0,
    jitterSpacing: 0,
    jitterAngle: 0,
    jitterBright: 0,
    jitterSat: 0,
    buildup: false,
    textureOn: false,
    textureMoving: false,
    taperStart: 1,
    taperEnd: 1,
  });
}

/** @param {number} actual @param {number} expected @param {number} [eps] */
function approx(actual, expected, eps = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);
}

/** @param {number} cx @param {number} cy @param {number} rx @param {number} ry @param {number} angle @param {number} theta */
function ellipsePoint(cx, cy, rx, ry, angle, theta) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const ct = Math.cos(theta), st = Math.sin(theta);
  return {
    x: cx + ca * rx * ct - sa * ry * st,
    y: cy + sa * rx * ct + ca * ry * st,
  };
}

/**
 * @param {StrokeEngine} engine
 * @param {import('./brush.js').Brush} brush
 * @param {{cx: number, cy: number, rx: number, ry: number, angle?: number, steps?: number, t0?: number}} opts
 */
function drawEllipse(engine, brush, { cx, cy, rx, ry, angle = 0, steps = 48, t0 = 0 }) {
  const p0 = ellipsePoint(cx, cy, rx, ry, angle, 0);
  engine.begin(p0.x, p0.y, 1, t0, brush, 123, 1);
  for (let i = 1; i <= steps; i++) {
    const p = ellipsePoint(cx, cy, rx, ry, angle, i * TWO_PI / steps);
    engine.move(p.x, p.y, 1, t0 + i * 12);
  }
  engine.tick(t0 + steps * 12 + 320);
}

function straightHoldBecomesSingleSegment() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();

  e.begin(0, 0, 1, 0, b, 123, 1);
  for (let i = 1; i <= 8; i++) {
    e.move(i * 15, Math.sin(i) * 1.2, 1, i * 16);
  }

  e.tick(350);
  assert.equal(e.snapMode, false);
  e.tick(450);
  assert.equal(e.snapMode, true);
  assert.equal(e.snapKind, 'line');
  assert.equal(e.snapDirty, true);

  q.clear();
  assert.equal(e.emitSnap(), true);
  assert.equal(q.count, 1);
  let o = q.peekOffset();
  assert.equal(q.buf[o], T_SEG);
  approx(q.buf[o + 1], 0);
  approx(q.buf[o + 2], 0);
  approx(q.buf[o + 5], 120);
  approx(q.buf[o + 6], Math.sin(8) * 1.2);

  e.move(180, 70, 1, 480);
  assert.equal(e.snapDirty, true);
  q.clear();
  e.emitSnap();
  o = q.peekOffset();
  approx(q.buf[o + 5], 180);
  approx(q.buf[o + 6], 70);

  e.end(210, 20, 1, 540);
  assert.equal(e.active, false);
  assert.equal(e.snapMode, true);
  assert.equal(e.snapDirty, true);
  q.clear();
  e.emitSnap();
  o = q.peekOffset();
  approx(q.buf[o + 5], 210);
  approx(q.buf[o + 6], 20);
}

function zigZagDoesNotActivate() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();

  e.begin(0, 0, 1, 0, b, 123, 1);
  const pts = [
    [20, 20], [40, -18], [60, 22], [80, -20], [100, 18], [120, 0],
  ];
  for (let i = 0; i < pts.length; i++) e.move(pts[i][0], pts[i][1], 1, 20 + i * 20);
  e.tick(600);
  assert.equal(e.snapMode, false);
}

function firstMoveAfterHoldMovesTipFreely() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();

  e.begin(0, 0, 1, 0, b, 123, 1);
  for (let i = 1; i <= 8; i++) e.move(i * 15, Math.sin(i) * 1.2, 1, i * 16);

  e.move(140, 90, 1, 430);
  assert.equal(e.snapMode, true);
  assert.equal(e.snapKind, 'line');
  q.clear();
  e.emitSnap();
  const o = q.peekOffset();
  approx(q.buf[o + 5], 140);
  approx(q.buf[o + 6], 90);
}

function ellipseHoldBecomesClosedSegments() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();

  drawEllipse(e, b, { cx: 100, cy: 80, rx: 70, ry: 34, angle: 0.45 });
  assert.equal(e.snapMode, true);
  assert.equal(e.snapKind, 'ellipse');
  q.clear();
  assert.equal(e.emitSnap(), true);
  assert.ok(q.count >= 28, `expected ellipse segments, got ${q.count}`);

  const before = e._snapRx;
  e.move(e._snapCx + Math.cos(e._snapAngle) * 100, e._snapCy + Math.sin(e._snapAngle) * 100, 1, 1000);
  assert.equal(e.snapDirty, true);
  assert.ok(e._snapRx > before, 'ellipse handle should scale the shape');
}

function nearCircleLocksCircle() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();

  drawEllipse(e, b, { cx: 40, cy: 55, rx: 48, ry: 46, angle: 0.2 });
  assert.equal(e.snapMode, true);
  assert.equal(e.snapKind, 'circle');
  approx(e._snapRx, e._snapRy, 1e-6);
  q.clear();
  assert.equal(e.emitSnap(), true);
  assert.ok(q.count >= 28, `expected circle segments, got ${q.count}`);
}

function openArcDoesNotActivate() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  const cx = 0, cy = 0, rx = 70, ry = 40;
  const p0 = ellipsePoint(cx, cy, rx, ry, 0, 0);

  e.begin(p0.x, p0.y, 1, 0, b, 123, 1);
  for (let i = 1; i <= 26; i++) {
    const p = ellipsePoint(cx, cy, rx, ry, 0, i * Math.PI * 1.35 / 26);
    e.move(p.x, p.y, 1, i * 14);
  }
  e.tick(800);
  assert.equal(e.snapMode, false);
}

function magmaStabilizerMatchesSliderMapping() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  b.smoothing = 0.6;

  e.begin(0, 0, 1, 0, b, 123, 1);
  approx(e._stabAlpha, 0.4424242424, 1e-6);
  assert.equal(e._stabBuf.length, 14);
}

function magmaStabilizerDampsJitterAndCatchesUp() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  b.smoothing = 1;

  e.begin(0, 0, 1, 0, b, 123, 1);
  approx(e._stabAlpha, 0.2, 1e-6);
  assert.equal(e._stabBuf.length, 20);

  let maxLag = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i <= 48; i++) {
    const x = i * 3;
    const y = i % 2 === 0 ? -2 : 2;
    e.move(x, y, 1, i * 16);
    maxLag = Math.max(maxLag, Math.hypot(e._sx - x, e._sy - y));
    minY = Math.min(minY, e._sy);
    maxY = Math.max(maxY, e._sy);
  }

  assert.ok(maxLag > 120, `expected Magma-style lag, got ${maxLag.toFixed(2)}px`);
  assert.ok(maxY - minY < 0.02, `expected strong Magma damping, got ${(maxY - minY).toFixed(4)}px`);
  e.end(144, 0, 1, 800);
  assert.ok(Math.abs(e._sx - 144) + Math.abs(e._sy) <= 1, 'Magma catch-up should finish within 1px L1 of raw end');
}

function largeSlowTaperUsesPointCaps() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  b.size = 88;
  b.smoothing = 0;
  b.taperStart = 0;
  b.taperEnd = 0;

  e.begin(0, 0, 1, 0, b, 123, 1);
  for (let i = 1; i <= 12; i++) {
    e.move(i * 8, Math.sin(i * 0.55) * 6, 1, 80 + i * 32);
  }
  e.end(104, 0, 1, 520);
  assert.equal(e.endPassNeeded, true);

  q.clear();
  e.replay();
  assert.ok(q.count > 12, `expected dense tapered segments, got ${q.count}`);

  const first = q.peekOffset();
  assert.equal(q.buf[first], T_SEG);
  approx(q.buf[first + 3], 0, 1e-6);
  assert.ok(q.buf[first + 7] <= 0.75, `first taper segment radius too large: ${q.buf[first + 7]}`);

  const last = (((q.tail - 1 + q.cap) % q.cap) * QUEUE_STRIDE);
  assert.equal(q.buf[last], T_SEG);
  assert.ok(q.buf[last + 3] <= 0.75, `last taper segment radius too large: ${q.buf[last + 3]}`);
  approx(q.buf[last + 7], 0, 1e-6);
}

straightHoldBecomesSingleSegment();
zigZagDoesNotActivate();
firstMoveAfterHoldMovesTipFreely();
ellipseHoldBecomesClosedSegments();
nearCircleLocksCircle();
openArcDoesNotActivate();
magmaStabilizerMatchesSliderMapping();
magmaStabilizerDampsJitterAndCatchesUp();
largeSlowTaperUsesPointCaps();
console.log('ok  stroke snap-hold');
