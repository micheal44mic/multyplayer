export const MP_PROTOCOL = 1;

let opCounter = 1;
let pageClientId = '';

export function getClientId() {
  if (!pageClientId) pageClientId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return pageClientId;
}

/** @param {string} userId */
export function makeOpId(userId) {
  return `${userId}:${Date.now().toString(36)}:${opCounter++}`;
}

/** @param {import('../brush.js').Brush} src */
export function serializeBrush(src) {
  return {
    size: src.size,
    opacity: src.opacity,
    hardness: src.hardness,
    smoothing: src.smoothing,
    spacing: src.spacing,
    roundness: src.roundness,
    angle: src.angle,
    scatter: src.scatter,
    particleSize: src.particleSize,
    particleDensity: src.particleDensity,
    particleDeviation: src.particleDeviation,
    jitterPos: src.jitterPos,
    jitterSize: src.jitterSize,
    jitterOpacity: src.jitterOpacity,
    jitterSpacing: src.jitterSpacing,
    jitterAngle: src.jitterAngle,
    jitterBright: src.jitterBright,
    jitterSat: src.jitterSat,
    buildup: src.buildup,
    taperStart: src.taperStart,
    taperEnd: src.taperEnd,
    texture: null,
    textureOn: false,
    textureScale: src.textureScale,
    textureDepth: src.textureDepth,
    textureFloor: src.textureFloor,
    textureContrast: src.textureContrast,
    textureInvert: src.textureInvert,
    textureMoving: src.textureMoving,
    textureUseColor: false,
    color: { r: src.color.r, g: src.color.g, b: src.color.b },
    tool: src.tool === 'eraser' ? 'eraser' : 'brush',
  };
}

/** @param {any} snap */
export function brushFromWire(snap) {
  return {
    size: finite(snap.size, 24),
    opacity: finite(snap.opacity, 1),
    hardness: finite(snap.hardness, 0.85),
    smoothing: finite(snap.smoothing, 0.35),
    spacing: finite(snap.spacing, 0.04),
    roundness: finite(snap.roundness, 1),
    angle: finite(snap.angle, 0),
    scatter: !!snap.scatter,
    particleSize: finite(snap.particleSize, 50),
    particleDensity: finite(snap.particleDensity, 100),
    particleDeviation: finite(snap.particleDeviation, 0),
    jitterPos: finite(snap.jitterPos, 0),
    jitterSize: finite(snap.jitterSize, 0),
    jitterOpacity: finite(snap.jitterOpacity, 0),
    jitterSpacing: finite(snap.jitterSpacing, 0),
    jitterAngle: finite(snap.jitterAngle, 0),
    jitterBright: finite(snap.jitterBright, 0),
    jitterSat: finite(snap.jitterSat, 0),
    buildup: !!snap.buildup,
    taperStart: finite(snap.taperStart, 0),
    taperEnd: finite(snap.taperEnd, 0),
    texture: null,
    textureOn: false,
    textureScale: finite(snap.textureScale, 1),
    textureDepth: finite(snap.textureDepth, 0.5),
    textureFloor: finite(snap.textureFloor, 0.25),
    textureContrast: finite(snap.textureContrast, 1),
    textureInvert: !!snap.textureInvert,
    textureMoving: !!snap.textureMoving,
    textureUseColor: false,
    color: {
      r: byte(snap.color && snap.color.r, 26),
      g: byte(snap.color && snap.color.g, 26),
      b: byte(snap.color && snap.color.b, 31),
    },
    tool: snap.tool === 'eraser' ? 'eraser' : 'brush',
  };
}

/** @param {number} v @param {number} fallback */
function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/** @param {number} v @param {number} fallback */
function byte(v, fallback) {
  return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : fallback;
}

/** @param {any} op */
export function validDocOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (op.type === 'clear') return true;
  if (op.type !== 'stroke') return false;
  if (!Array.isArray(op.points) || op.points.length < 2 || op.points.length > 20000) return false;
  if (!op.brush || (op.brush.tool !== 'brush' && op.brush.tool !== 'eraser')) return false;
  return Number.isFinite(op.boardId) && Number.isFinite(op.layerId) && Number.isFinite(op.seed);
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(out);
}

/** @param {string} text */
export function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
