import assert from 'node:assert/strict';
import { brush as baseBrush } from './brush.js';
import { DabQueue, StrokeEngine, T_SEG } from './stroke.js';

const TWO_PI = Math.PI * 2;

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

function stabilizerReducesJitterWithoutDraggingTip() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  b.smoothing = 1;

  e.begin(0, 0, 1, 0, b, 123, 1);
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

  assert.ok(maxLag <= 5.6, `stabilizer dragged ${maxLag.toFixed(2)}px behind the pointer`);
  assert.ok(maxY - minY < 3.2, `expected jitter below raw 4px range, got ${(maxY - minY).toFixed(2)}px`);
}

function slowStabilizerDoesNotTreatJitterAsSpeed() {
  const q = new DabQueue();
  const e = new StrokeEngine(q);
  const b = testBrush();
  b.smoothing = 1;

  e.begin(0, 0, 1, 0, b, 123, 1);
  let maxLag = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i <= 72; i++) {
    const x = i * 0.8;
    const y = i % 2 === 0 ? -3 : 3;
    e.move(x, y, 1, i * 16);
    maxLag = Math.max(maxLag, Math.hypot(e._sx - x, e._sy - y));
    minY = Math.min(minY, e._sy);
    maxY = Math.max(maxY, e._sy);
  }

  assert.ok(maxLag <= 3.35, `slow stabilizer dragged ${maxLag.toFixed(2)}px behind the pointer`);
  assert.ok(maxY - minY < 1.7, `expected slow jitter to be strongly damped, got ${(maxY - minY).toFixed(2)}px`);
}

straightHoldBecomesSingleSegment();
zigZagDoesNotActivate();
firstMoveAfterHoldMovesTipFreely();
ellipseHoldBecomesClosedSegments();
nearCircleLocksCircle();
openArcDoesNotActivate();
stabilizerReducesJitterWithoutDraggingTip();
slowStabilizerDoesNotTreatJitterAsSpeed();
console.log('ok  stroke snap-hold');
