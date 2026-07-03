// PRESENTAZIONE — la GPU è un proiettore.
// Texture 256x256 per chunk, texSubImage2D solo dei chunk sporchi,
// pan/zoom = matrice nel vertex shader, zero pixel CPU toccati dalla vista.
// Multi-livello: i layer raster del proprio gruppo si disegnano dal basso
// verso l'alto con l'opacità del livello; il buffer dello stroke live si
// inserisce subito sopra il livello attivo. Canvas trasparente (alpha:true):
// la griglia di sfondo è CSS, sotto tutti i piani.

import { CHUNK } from './store.js';
import { warpGridWorld, warpPads, warpFoldOrder, perspGridWorld, perspWorldToSrc } from './warp.js';
import {
  activeBevel,
  bevelRect,
  layerStyleKey,
  hexRgb01,
  BEVEL_STYLE_INDEX,
  BEVEL_TECHNIQUE_INDEX,
  CONTOUR_INDEX,
  STYLE_BLEND_INDEX,
} from './layer_styles.js';

/** @typedef {import('./store.js').Chunk} Chunk */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {TransformFrame|TransformFrame[]|null} TransformFrameSet */

/** @param {TransformFrameSet} transform @param {number} layerId @returns {TransformFrame|null} */
function transformForLayer(transform, layerId) {
  if (!transform) return null;
  if (Array.isArray(transform)) return transform.find((f) => f.layerId === layerId) || null;
  return transform.layerId === layerId ? transform : null;
}

// Sopra questo zoom la magnificazione mostra i pixel nitidi (NEAREST, per il
// lavoro di dettaglio); fino a qui l'ingrandimento è ammorbidito (LINEAR).
const MAG_NEAREST_ZOOM = 3.8;

// Blur gaussiano del pannello Effetti: sigma massimo e tap massimi per lato
// del kernel separabile (3σ). Il loop GLSL ha bound costante (WebGL1) ed
// esce con break oltre uR: con sigma piccoli si pagano solo i tap che servono.
export const FX_SIGMA_MAX = 40;
const FX_MAX_R = 3 * FX_SIGMA_MAX;

// uSize: lato del quad in px mondo (CHUNK per i tile; dimensioni del board
// per i quad proxy dello zoom-out).
const VS_CHUNK = `
attribute vec2 aPos;
uniform mat3 uMat;
uniform vec2 uOrigin;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uMat * vec3(uOrigin + aPos * uSize, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FS_CHUNK = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv) * uAlpha;
}`;

// Mesh della sessione Warp: vertici già in coordinate MONDO (la superficie
// è valutata su CPU ai nodi, poche migliaia e solo quando griglia/affine
// cambiano) — pan e zoom restano nella matrice camera, come per i chunk.
const VS_MESH = `
attribute vec2 aPos;
attribute vec2 aUv;
uniform mat3 uMat;
varying vec2 vUv;
void main() {
  vUv = aUv;
  vec3 p = uMat * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

// Preview live della gomma: il chunk del livello attivo viene attenuato
// dalla maschera alpha dello stroke buffer, senza toccare ciò che sta sotto.
// uLayerA = opacità del livello (moltiplica il risultato).
const FS_ERASE = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uAlpha;
uniform float uLayerA;
varying vec2 vUv;
void main() {
  float k = 1.0 - texture2D(uMask, vUv).a * uAlpha;
  gl_FragColor = texture2D(uTex, vUv) * k * uLayerA;
}`;

// Preview live del pennello su livello semitrasparente: (tratto over chunk)
// composto QUI, poi × opacità del livello — la stessa matematica di
// commitChunk (raster.js), così l'anteprima è identica al commit. Disegnare
// chunk e tratto come due over separati sul canvas applicherebbe l'opacità
// due volte dove il tratto passa su pixel già presenti (tratto più opaco
// live che al rilascio). Texture premultiplied: l'over è s + d·(1-s.a).
const FS_PAINT = `
precision mediump float;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uAlpha;
uniform float uLayerA;
varying vec2 vUv;
void main() {
  vec4 s = texture2D(uMask, vUv) * uAlpha;
  vec4 d = texture2D(uTex, vUv);
  gl_FragColor = (s + d * (1.0 - s.a)) * uLayerA;
}`;

// Metodi di fusione (vedi BLEND_MODES in layers.js). 'screen' e 'add' sono
// ESATTI in fixed-function sul premultiplied per QUALUNQUE alpha del backdrop:
//   screen: co = cs + cb·(1-cs)        → blendFunc(ONE, ONE_MINUS_SRC_COLOR)
//   add:    co = cs + cb (clamp HW)    → blendFuncSeparate(ONE,ONE, ONE,1-αs)
// Gli altri non sono esprimibili nel blending fisso su backdrop NON opaco
// (il canvas è un piano trasparente): si copia il backdrop — SOLO il bbox
// dei chunk visibili del livello — e un fragment shader applica la formula
// completa del modulo W3C Compositing:
//   co = cs·(1-αb) + cb·(1-αs) + αs·αb·B(Cb,Cs)    αo = αs + αb·(1-αs)
// B lavora sui colori NON premoltiplicati (de-premoltiplica con guardia);
// il pass scrive a blending SPENTO: dove il livello è vuoto riscrive cb.
// Il tratto live (o la maschera gomma) entra nello stesso pass via uMask —
// stessa matematica di commitChunk, anteprima identica al commit.
export const SHADER_MODES = new Set(['multiply', 'overlay', 'softlight', 'darken', 'lighten', 'difference']);

/** @type {Record<string, string>} B(Cb,Cs) per modo, GLSL */
const BLEND_FN = {
  multiply: 'vec3 blendB(vec3 b, vec3 s) { return b * s; }',
  overlay: `vec3 blendB(vec3 b, vec3 s) {
  return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
}`,
  softlight: `vec3 blendB(vec3 b, vec3 s) {
  vec3 dd = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b),
             b + (2.0 * s - 1.0) * (dd - b), step(0.5, s));
}`,
  darken: 'vec3 blendB(vec3 b, vec3 s) { return min(b, s); }',
  lighten: 'vec3 blendB(vec3 b, vec3 s) { return max(b, s); }',
  difference: 'vec3 blendB(vec3 b, vec3 s) { return abs(b - s); }',
};

// highp dove c'è: gl_FragCoord/uBackSize su canvas larghi sgranerebbe in mediump
/** @param {string} fn */
const FS_BLEND = (fn) => FS_PREC + `
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform sampler2D uBack;
uniform vec2 uBackSize;
uniform float uAlpha;
uniform float uLayerA;
uniform float uEraser;
varying vec2 vUv;
${fn}
void main() {
  vec4 d = texture2D(uTex, vUv);
  vec4 m = texture2D(uMask, vUv);
  vec4 s;
  if (uEraser > 0.5) { s = d * (1.0 - m.a * uAlpha); }
  else { vec4 t = m * uAlpha; s = t + d * (1.0 - t.a); }
  s *= uLayerA;
  vec4 b = texture2D(uBack, gl_FragCoord.xy / uBackSize);
  vec3 B = blendB(b.rgb / max(b.a, 1e-4), s.rgb / max(s.a, 1e-4));
  gl_FragColor = vec4(s.rgb * (1.0 - b.a) + b.rgb * (1.0 - s.a) + s.a * b.a * B,
    s.a + b.a * (1.0 - s.a));
}`;

// quad 0..1 -> NDC pieno via VS_CHUNK (uOrigin=0, uSize=1): il pass di
// fusione del gruppo campiona _grpTex con le stesse UV del blit 1:1
const BLIT_MAT = new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);

// Maschera di ritaglio (alla Procreate): semantica di GRUPPO alla
// Photoshop. La base e la sua catena di livelli clippati si compongono in
// un FBO a parte: la base entra con blending normale (definisce l'alpha del
// gruppo), ogni clippato con blendFunc(DST_ALPHA, ONE_MINUS_SRC_ALPHA) —
// l'alpha del target resta INCHIODATA a quella della base (out_a = src_a·b
// + b·(1-src_a) = b) e il colore del clippato SOSTITUISCE quello della base
// dove copre. È la matematica esatta del gruppo: dove il clippato è opaco
// il colore della base sparisce anche sulla frangia antialiasata (niente
// alone del colore della base), e a ogni alpha intermedia il blend interno
// è quello normale. Poi il gruppo si presenta sul canvas con UN blit.
// Bonus: pennello/gomma/sessioni sulla base aggiornano la maschera gratis —
// sono semplicemente disegnati nell'FBO prima dei clippati.

// Pass del blur: quad 0..1 -> clip space pieno, nessuna camera (lavora in
// spazio texture, FBO 1:1 con l'hull della sessione).
const VS_BLIT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

// Precisione dei pass blur: con texture oltre i 1024 px i texel coords
// mediump perderebbero bit — highp dove c'è.
const FS_PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// Blit 1:1 del gruppo di ritaglio sul canvas (stesso orientamento NDC:
// niente flip). highp dove c'è: i texel coords su canvas larghi perderebbero
// bit in mediump.
const FS_BLIT = FS_PREC + `
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

// Quad della sessione Prospettiva: l'omografia manda rette in rette, quindi
// la geometria resta un quad di 4 vertici in MONDO (come la mesh warp, con
// pan/zoom nella matrice camera); la curvatura prospettica sta tutta nel
// campionamento — il fragment shader applica l'omografia inversa
// mondo→UV hull e divide per w (esatta, alla cbos). highp dove c'è: i px
// mondo arrivano a migliaia e mediump sgranerebbe il campionamento.
const VS_PERSP = `
attribute vec2 aPos;
uniform mat3 uMat;
varying vec2 vPos;
void main() {
  vPos = aPos;
  vec3 p = uMat * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const FS_PERSP = FS_PREC + `
uniform sampler2D uTex;
uniform float uAlpha;
uniform mat3 uH;
varying vec2 vPos;
void main() {
  vec3 s = uH * vec3(vPos, 1.0);
  gl_FragColor = texture2D(uTex, s.xy / s.z) * uAlpha;
}`;

// Gaussiana separabile (un asse per pass, uStep = un texel lungo l'asse).
// Pesi exp(-i²/2σ²) calcolati nello shader e normalizzati: il filtro lavora
// sui valori premultiplied — lo spazio corretto, niente aloni.
const FS_BLUR = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uSigma;
uniform int uR;
varying vec2 vUv;
const int MAX_R = ${FX_MAX_R};
void main() {
  vec4 acc = texture2D(uTex, vUv);
  float wsum = 1.0;
  float s2 = 2.0 * uSigma * uSigma;
  for (int i = 1; i <= MAX_R; i++) {
    if (i > uR) break;
    float fi = float(i);
    float w = exp(-(fi * fi) / s2);
    acc += (texture2D(uTex, vUv + uStep * fi) + texture2D(uTex, vUv - uStep * fi)) * w;
    wsum += 2.0 * w;
  }
  gl_FragColor = acc / wsum;
}`;

// Dab dello sfumino GPU: campiona la copia pre-dab (uTex, rect a 0,0 dello
// scratch) e la sua versione sfocata (uBlurT), mixa con la mask radiale
// smoothstep (stessa banda core/w del motore CPU) e col pull a 3 tap
// (0.6 centro + 0.2 per lato, offset costante del dab). Scrittura diretta
// senza blending: fuori dalla mask riscrive la base identica.
const FS_SMUDGE = FS_PREC + `
uniform sampler2D uTex;
uniform sampler2D uBlurT;
uniform vec2 uRectOrigin;
uniform vec2 uRectSize;
uniform vec2 uUvScale;
uniform vec2 uCenter;
uniform float uCore;
uniform float uWW;
uniform float uPressure;
uniform float uBlurK;
uniform float uDragK;
uniform vec2 uOff;
uniform vec2 uOffA;
uniform vec2 uOffB;
varying vec2 vUv;
void main() {
  vec2 suv = vUv * uUvScale;
  vec4 col = texture2D(uTex, suv);
  vec2 pos = uRectOrigin + vUv * uRectSize;
  float t = clamp((distance(pos, uCenter) - uCore) / uWW, 0.0, 1.0);
  float mask = (1.0 - t * t * (3.0 - 2.0 * t)) * uPressure;
  col = mix(col, texture2D(uBlurT, suv), mask * uBlurK);
  vec4 pulled = texture2D(uTex, suv + uOff) * 0.6
    + texture2D(uTex, suv + uOffA) * 0.2
    + texture2D(uTex, suv + uOffB) * 0.2;
  gl_FragColor = mix(col, pulled, mask * uDragK);
}`;

// Stamp del liquify GPU: aggiorna il CAMPO DI SPOSTAMENTO (RG = offset
// sorgente in px) sul rect del dab. Composizione corretta dei warp:
// D_new(p) = w(p) + D_old(p + w(p)) — il vecchio campo si campiona alla
// posizione warpata (uTex = copia pre-dab del campo, rect+pad a 0,0 dello
// scratch). Le formule dei modi replicano _liquifyPixel del motore CPU,
// col noise smussato al posto dell'hash a blocchi.
const FS_LIQ_STAMP = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uRectOrigin;
uniform vec2 uRectSize;
uniform vec2 uScrOrigin;
uniform float uScrS;
uniform vec2 uCenter;
uniform float uCore;
uniform float uWW;
uniform float uPressure;
uniform float uRadius;
uniform float uChaos;
uniform float uSeedF;
uniform vec2 uDXY;
uniform int uMode;
varying vec2 vUv;
float hashL(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeedF * 731.7) * 43758.5453); }
float noiseL(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashL(i), hashL(i + vec2(1.0, 0.0)), u.x),
             mix(hashL(i + vec2(0.0, 1.0)), hashL(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 pos = uRectOrigin + vUv * uRectSize;
  vec2 v = pos - uCenter;
  float t = clamp((length(v) - uCore) / uWW, 0.0, 1.0);
  float mask = (1.0 - t * t * (3.0 - 2.0 * t)) * uPressure;
  vec2 w = vec2(0.0);
  if (uMode == 0) {
    vec2 d = uDXY;
    if (uChaos > 0.001) {
      float n = noiseL(pos / 14.0) * 2.0 - 1.0;
      vec2 pp = vec2(-d.y, d.x);
      float pl = max(length(pp), 1e-6);
      d += pp / pl * (n * uChaos * uRadius * 0.08 * mask);
    }
    w = -d * ((0.9 + uChaos * 0.25) * mask);
  } else if (uMode == 1 || uMode == 2) {
    float sgn = uMode == 1 ? 1.0 : -1.0;
    float extra = uChaos * (noiseL(pos / 18.0) - 0.5);
    float a = -sgn * (0.78 + uChaos * 0.72) * mask * (1.0 + extra);
    float ca = cos(a); float sa = sin(a);
    vec2 rv = vec2(v.x * ca - v.y * sa, v.x * sa + v.y * ca);
    w = length(v) < 1.0 ? vec2(0.0) : rv - v;
  } else if (uMode == 3 || uMode == 4) {
    float sgn = uMode == 3 ? 1.0 : -1.0;
    w = v * (sgn * (0.46 + uChaos * 0.24) * mask);
  } else if (uMode == 5) {
    float ang = atan(v.y, v.x);
    float sectors = max(7.0, floor(10.0 + uChaos * 18.0 + 0.5));
    float q = floor(ang / 6.2831853 * sectors + 0.5);
    float qa = q / sectors * 6.2831853;
    float n = hashL(vec2(q, floor(length(v) / max(6.0, uRadius * 0.13))));
    float jag = (0.34 + uChaos * 0.38) * uRadius * mask * (0.45 + n);
    w = -vec2(cos(qa), sin(qa)) * jag;
  } else {
    vec2 u2 = uDXY;
    float ul = length(u2);
    u2 = ul < 0.01 ? vec2(1.0, 0.0) : u2 / ul;
    vec2 n2 = vec2(-u2.y, u2.x);
    float side = dot(v, n2);
    float s01 = clamp(abs(side) / max(1.0, uRadius), 0.0, 1.0);
    s01 = s01 * s01 * (3.0 - 2.0 * s01);
    float pull = (side >= 0.0 ? 1.0 : -1.0) * (0.54 + uChaos * 0.16) * uRadius * mask * s01;
    w = n2 * pull;
  }
  vec2 suv = (pos + w - uScrOrigin) / uScrS;
  gl_FragColor = vec4(w + texture2D(uTex, suv).xy, 0.0, 1.0);
}`;

// Resolve del liquify: UN solo ri-campionamento della base attraverso il
// campo totale — niente impasto progressivo (bilinear su bilinear) del
// motore CPU iterativo. Gira solo sul rect del dab (il campo cambia lì).
const FS_LIQ_RESOLVE = FS_PREC + `
uniform sampler2D uTex;
uniform sampler2D uDispT;
uniform vec2 uTexSize;
uniform vec2 uRectOrigin;
uniform vec2 uRectSize;
varying vec2 vUv;
void main() {
  vec2 pos = uRectOrigin + vUv * uRectSize;
  vec2 d = texture2D(uDispT, pos / uTexSize).xy;
  gl_FragColor = texture2D(uTex, (pos + d) / uTexSize);
}`;

// Blur di movimento: media uniforme (box) lungo la direzione, un solo pass.
// uStep = un tap lungo (cosθ, sinθ), già in spazio uv.
const FS_MOTION = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uStep;
uniform int uR;
varying vec2 vUv;
const int MAX_R = ${FX_MAX_R};
void main() {
  vec4 acc = texture2D(uTex, vUv);
  float wsum = 1.0;
  for (int i = 1; i <= MAX_R; i++) {
    if (i > uR) break;
    float fi = float(i);
    acc += texture2D(uTex, vUv + uStep * fi) + texture2D(uTex, vUv - uStep * fi);
    wsum += 2.0;
  }
  gl_FragColor = acc / wsum;
}`;

// Noise: random pixels/particles, con size controllabile. Size 1 equivale al
// noise per-pixel; salendo, la casualita' resta ma cresce la particella.
// uColor fonde mono -> canali indipendenti. Alpha intatta.
const FS_NOISE = FS_PREC + `
uniform sampler2D uTex;
uniform float uAmount;
uniform float uColor;
uniform float uSize;
uniform float uRoughness;
uniform float uSeed;
uniform vec2 uTexSize;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float pixelNoise(vec2 p) { return hash(p) + hash(p + vec2(17.13, -11.71)) - 1.0; }
float particleNoise(vec2 px, float size, float roughness, float seed) {
  float s = max(1.0, size);
  float rgh = clamp(roughness, 0.0, 1.0);
  if (s <= 1.05) return pixelNoise(px + vec2(seed, -seed));
  vec2 g = floor(px / s);
  float acc = 0.0;
  float wsum = 0.0;
  float jitter = 0.18 + rgh * 0.62;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 cell = g + vec2(float(xx), float(yy));
      float jx = (hash(cell + vec2(seed * 0.37, -seed * 0.21)) - 0.5) * jitter;
      float jy = (hash(cell + vec2(-seed * 0.13, seed * 0.49)) - 0.5) * jitter;
      vec2 center = (cell + vec2(0.5 + jx, 0.5 + jy)) * s;
      float rad = (0.38 + hash(cell + vec2(91.7, -54.3)) * (0.12 + rgh * 0.32)) * s;
      vec2 d = px - center;
      float d2 = dot(d, d);
      float r2 = rad * rad;
      if (d2 < r2) {
        float t = 1.0 - d2 / r2;
        float ww = t * t * (3.0 - 2.0 * t);
        float amp = pixelNoise(cell * vec2(23.31, 17.17) + vec2(seed, -seed));
        acc += amp * ww;
        wsum += ww;
      }
    }
  }
  float clump = wsum > 0.0 ? acc / wsum : pixelNoise(g + vec2(seed * 0.7, -seed * 0.4)) * 0.25;
  float micro = pixelNoise(px + vec2(seed * 2.13, -seed * 1.77));
  float microMix = 0.06 + rgh * 0.34;
  return clamp(clump * (1.0 - microMix) + micro * microMix, -1.0, 1.0);
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  vec2 px = vUv * uTexSize + uSeed;
  float nm = particleNoise(px, uSize, uRoughness, uSeed);
  vec3 nc = vec3(
    particleNoise(px + vec2(37.7, -27.521), uSize, uRoughness, uSeed + 37.7),
    particleNoise(px + vec2(69.3, -50.589), uSize, uRoughness, uSeed + 69.3),
    particleNoise(px + vec2(100.9, -73.657), uSize, uRoughness, uSeed + 100.9));
  vec3 n = mix(vec3(nm), nc, uColor);
  c.rgb = clamp(c.rgb + n * uAmount * c.a, vec3(0.0), vec3(c.a));
  gl_FragColor = c;
}`;

// Grana pellicola: size controlla la particella, roughness la sua regolarita'.
// Mono, alpha intatta, con peso tonale piu' forte nei mezzitoni.
const FS_GRAIN = FS_PREC + `
uniform sampler2D uTex;
uniform float uAmount;
uniform float uSize;
uniform float uRoughness;
uniform float uSeed;
uniform vec2 uTexSize;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float svnoise(vec2 p) { return vnoise(p) * 2.0 - 1.0; }
float pixelNoise(vec2 p) { return hash(p) + hash(p + vec2(17.13, -11.71)) - 1.0; }
float gaussianNoise(vec2 px, float seed) {
  float n =
    hash(px + vec2(seed * 0.11, -seed * 0.17)) +
    hash(px * vec2(1.37, 0.91) + vec2(-seed * 0.23, seed * 0.29)) +
    hash(px * vec2(0.73, 1.61) + vec2(19.17 + seed * 0.31, -7.43 - seed * 0.37)) +
    hash(px * vec2(1.91, 0.57) + vec2(-5.71 - seed * 0.41, 23.11 + seed * 0.43));
  return clamp((n - 2.0) * 0.86, -1.0, 1.0);
}
float grainParticleNoise(vec2 px, float size, float roughness, float seed) {
  float s = max(1.0, size);
  float rgh = clamp(roughness, 0.0, 1.0);
  if (s <= 1.05) return pixelNoise(px + vec2(seed, -seed));
  vec2 g = floor(px / s);
  float acc = 0.0;
  float wsum = 0.0;
  float jitter = 0.16 + rgh * 0.56;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 cell = g + vec2(float(xx), float(yy));
      float jx = (hash(cell + vec2(seed * 0.37, -seed * 0.21)) - 0.5) * jitter;
      float jy = (hash(cell + vec2(-seed * 0.13, seed * 0.49)) - 0.5) * jitter;
      vec2 center = (cell + vec2(0.5 + jx, 0.5 + jy)) * s;
      float rad = (0.32 + hash(cell + vec2(91.7, -54.3)) * (0.1 + rgh * 0.26)) * s;
      vec2 d = px - center;
      float d2 = dot(d, d);
      float r2 = rad * rad;
      if (d2 < r2) {
        float t = 1.0 - d2 / r2;
        float ww = t * t * (3.0 - 2.0 * t);
        float amp = gaussianNoise(cell * vec2(23.31, 17.17) + vec2(seed, -seed), seed);
        acc += amp * ww;
        wsum += ww;
      }
    }
  }
  float clump = wsum > 0.0 ? acc / wsum : pixelNoise(g + vec2(seed * 0.7, -seed * 0.4)) * 0.18;
  float micro = pixelNoise(px + vec2(seed * 2.13, -seed * 1.77));
  float microMix = 0.12 + rgh * 0.26;
  return clamp(clump * (1.0 - microMix) + micro * microMix, -1.0, 1.0);
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (c.a < 0.004) { gl_FragColor = c; return; }
  vec2 doc = vUv * uTexSize;
  float sz = max(1.0, uSize);
  float rgh = clamp(uRoughness, 0.0, 1.0);
  float sizeMix = clamp((sz - 1.0) / 14.0, 0.0, 1.0);
  float micro = gaussianNoise(doc + vec2(uSeed * 1.91, -uSeed * 1.37), uSeed);
  float fineScale = max(1.0, sz * 0.38);
  float fine = gaussianNoise((doc + vec2(uSeed * 0.67, -uSeed * 0.53)) / fineScale, uSeed + 31.7);
  float particle = grainParticleNoise(doc, max(1.0, sz * 0.7), rgh, uSeed);
  float bodyScale = max(1.0, sz * 0.95);
  float body = svnoise((doc + vec2(uSeed, -uSeed)) / bodyScale);
  float n = clamp((
    micro * (0.58 - sizeMix * 0.2 + rgh * 0.08) +
    fine * (0.18 - sizeMix * 0.06) +
    particle * (0.18 + sizeMix * 0.22 + rgh * 0.04) +
    body * (0.06 + sizeMix * 0.04 - rgh * 0.03)
  ) * 0.82, -1.0, 1.0);
  float l = dot(c.rgb / c.a, vec3(0.299, 0.587, 0.114));
  float mid = clamp(4.0 * l * (1.0 - l), 0.0, 1.0);
  float w = 0.16 + 0.84 * pow(mid, 0.72);
  c.rgb = clamp(c.rgb + n * uAmount * w * c.a, vec3(0.0), vec3(c.a));
  gl_FragColor = c;
}`;

// Traccia (Stile livello), pass 1: per ogni pixel la distanza VERTICALE
// minima (in px, ±uR) alla forma (alpha>0, canale R) e al suo complemento
// (canale G). 230 = non trovata entro uR (230² > 60² massimo della traccia:
// mai falsi positivi nel pass 2). Valori interi ≤ 230 esatti negli 8 bit.
const FS_DIST_V = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uStep;
uniform int uR;
varying vec2 vUv;
const int MAX_R = ${FX_MAX_R};
const float ALPHA_EPS = 0.001;
void main() {
  bool inside = texture2D(uTex, vUv).a > ALPHA_EPS;
  float dShape = inside ? 0.0 : 230.0;
  float dComp = inside ? 230.0 : 0.0;
  for (int i = 1; i <= MAX_R; i++) {
    if (i > uR) break;
    if (dShape < 229.0 && dComp < 229.0) break;
    float fi = float(i);
    bool up = texture2D(uTex, vUv - uStep * fi).a > ALPHA_EPS;
    bool dn = texture2D(uTex, vUv + uStep * fi).a > ALPHA_EPS;
    if (dShape > 229.0 && (up || dn)) dShape = fi;
    if (dComp > 229.0 && (!up || !dn)) dComp = fi;
  }
  gl_FragColor = vec4(dShape / 255.0, dComp / 255.0, 0.0, 1.0);
}`;

// Traccia, pass 2: distanza euclidea ESATTA dal bordo combinando
// dx² + (distanza verticale della colonna a dx)² (decomposizione classica
// della EDT), poi composizione dell'anello: esterna = sotto il contenuto,
// interna = colore sostituito dentro il bordo (alpha intatta), centrale =
// metà e metà. Bordo antialiasato con rampa di 1 px sulla distanza.
const FS_STROKE = FS_PREC + `
uniform sampler2D uTex;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform int uR;
uniform float uW;
uniform int uPos;
uniform vec3 uColor;
varying vec2 vUv;
const int MAX_R = ${FX_MAX_R};
void main() {
  vec4 c = texture2D(uSrc, vUv);
  vec2 d0 = texture2D(uTex, vUv).rg * 255.0;
  float d2s = d0.x * d0.x;
  float d2c = d0.y * d0.y;
  for (int i = 1; i <= MAX_R; i++) {
    if (i > uR) break;
    float fi = float(i);
    vec2 dl = texture2D(uTex, vUv - uStep * fi).rg * 255.0;
    vec2 dr = texture2D(uTex, vUv + uStep * fi).rg * 255.0;
    float fi2 = fi * fi;
    d2s = min(d2s, fi2 + min(dl.x * dl.x, dr.x * dr.x));
    d2c = min(d2c, fi2 + min(dl.y * dl.y, dr.y * dr.y));
  }
  float dOut = sqrt(d2s);
  float dIn = sqrt(d2c);
  float wO = uPos == 1 ? uW * 0.5 : uW;
  float covO = 0.0;
  float covI = 0.0;
  // anello esterno: anche SOTTO la frangia antialiasata del bordo (i pixel
  // con alpha > 0 contano "dentro" ma il loro residuo 1-a va riempito,
  // sennò lo sfondo trafila come cucitura punteggiata); il gate dIn < 2
  // limita il riempimento ai 2 px del bordo, mai sotto l'interno semi-
  // trasparente del contenuto
  if (uPos != 2 && (dOut > 0.0 || dIn < 2.0)) {
    covO = clamp(wO + 0.5 - dOut, 0.0, 1.0);
  }
  if (uPos != 0 && dIn > 0.0) {
    covI = clamp((uPos == 1 ? uW * 0.5 : uW) + 0.5 - dIn, 0.0, 1.0);
  }
  vec3 rgb1 = mix(c.rgb, uColor * c.a, covI);
  float sa = covO * (1.0 - c.a);
  gl_FragColor = vec4(rgb1 + uColor * sa, c.a + sa);
}`;

// Colore (Stile livello): sostituisce il colore del contenuto con uColor
// mantenendo l'alpha intatta — i bordi morbidi restano morbidi, cambia solo
// la tinta. Premultiplied: rgb = colore × a.
const FS_TINT = FS_PREC + `
uniform sampler2D uTex;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  float a = texture2D(uTex, vUv).a;
  gl_FragColor = vec4(uColor * a, a);
}`;

const FS_JFA_INIT = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uTexelSize;
varying vec2 vUv;
const float ALPHA_EPS = 0.001;
vec4 packUV(vec2 uv) {
  vec2 p = uv * 4094.0 + 1.0;
  return vec4(floor(p.x / 16.0) / 255.0, fract(p.x / 16.0) * 16.0 / 255.0,
              floor(p.y / 16.0) / 255.0, fract(p.y / 16.0) * 16.0 / 255.0);
}
void main() {
  float a = texture2D(uTex, vUv).a > ALPHA_EPS ? 1.0 : 0.0;
  float l = texture2D(uTex, vUv + vec2(-uTexelSize.x, 0.0)).a > ALPHA_EPS ? 1.0 : 0.0;
  float r = texture2D(uTex, vUv + vec2( uTexelSize.x, 0.0)).a > ALPHA_EPS ? 1.0 : 0.0;
  float t = texture2D(uTex, vUv + vec2(0.0, -uTexelSize.y)).a > ALPHA_EPS ? 1.0 : 0.0;
  float b = texture2D(uTex, vUv + vec2(0.0,  uTexelSize.y)).a > ALPHA_EPS ? 1.0 : 0.0;
  bool edge = (a > 0.5 && (l < 0.5 || r < 0.5 || t < 0.5 || b < 0.5)) ||
              (a < 0.5 && (l > 0.5 || r > 0.5 || t > 0.5 || b > 0.5));
  gl_FragColor = edge ? packUV(vUv) : vec4(0.0);
}`;

const FS_JFA_STEP = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uStep;
varying vec2 vUv;
vec2 unpackUV(vec4 c) {
  float px = floor(c.x * 255.0 * 16.0 + c.y * 255.0 + 0.5);
  float py = floor(c.z * 255.0 * 16.0 + c.w * 255.0 + 0.5);
  return vec2(px - 1.0, py - 1.0) / 4094.0;
}
vec4 packUV(vec2 uv) {
  vec2 p = uv * 4094.0 + 1.0;
  return vec4(floor(p.x / 16.0) / 255.0, fract(p.x / 16.0) * 16.0 / 255.0,
              floor(p.y / 16.0) / 255.0, fract(p.y / 16.0) * 16.0 / 255.0);
}
void main() {
  vec4 selfData = texture2D(uTex, vUv);
  bool seeded = dot(selfData, vec4(1.0)) > 0.0;
  vec2 bestUV = seeded ? unpackUV(selfData) : vec2(-1.0);
  float bestDist = seeded ? length((vUv - bestUV) / uTexelSize) : 999999.0;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      if (xx == 0 && yy == 0) continue;
      vec2 uv = vUv + vec2(float(xx), float(yy)) * uTexelSize * uStep;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
      vec4 data = texture2D(uTex, uv);
      if (dot(data, vec4(1.0)) > 0.0) {
        vec2 p = unpackUV(data);
        float d = length((vUv - p) / uTexelSize);
        if (d < bestDist) { bestDist = d; bestUV = p; }
      }
    }
  }
  gl_FragColor = bestUV.x >= 0.0 ? packUV(bestUV) : vec4(0.0);
}`;

const FS_JFA_TO_ALPHA = FS_PREC + `
uniform sampler2D uTex;
uniform sampler2D uOrigAlpha;
uniform vec2 uTexelSize;
uniform float uMaxDist;
varying vec2 vUv;
const float ALPHA_EPS = 0.001;
vec2 unpackUV(vec4 c) {
  float px = floor(c.x * 255.0 * 16.0 + c.y * 255.0 + 0.5);
  float py = floor(c.z * 255.0 * 16.0 + c.w * 255.0 + 0.5);
  return vec2(px - 1.0, py - 1.0) / 4094.0;
}
void main() {
  vec4 data = texture2D(uTex, vUv);
  float origA = texture2D(uOrigAlpha, vUv).a > ALPHA_EPS ? 1.0 : 0.0;
  if (dot(data, vec4(1.0)) == 0.0) {
    float h = origA > 0.5 ? 1.0 : 0.0;
    gl_FragColor = vec4(h, h, h, h);
    return;
  }
  vec2 nearestUV = unpackUV(data);
  float distPx = length((vUv - nearestUV) / uTexelSize);
  float d = clamp(distPx / max(uMaxDist, 1.0), 0.0, 1.0);
  float h = origA > 0.5 ? 0.5 + 0.5 * d : 0.5 - 0.5 * d;
  gl_FragColor = vec4(h, h, h, h);
}`;

const BEVEL_CONTOUR_GLSL = `
float applyContour(float t, int contour) {
  if (contour == 1) return sqrt(max(0.0, 1.0 - (1.0 - t) * (1.0 - t)));
  if (contour == 2) return 1.0 - abs(2.0 * t - 1.0);
  if (contour == 3) return t * t;
  if (contour == 4) return sqrt(t);
  if (contour == 5) return 0.5 - 0.5 * cos(t * 6.2831853);
  if (contour == 6) return 0.5 - 0.5 * cos(t * 12.5663706);
  if (contour == 7) return fract(t * 2.0);
  if (contour == 8) return floor(t * 4.0) / 4.0;
  return t;
}`;

const FS_BEVEL_NORMAL = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uTexelSize;
uniform float uDepth;
uniform int uStyle;
uniform float uDirection;
uniform int uTechnique;
uniform int uContour;
varying vec2 vUv;
${BEVEL_CONTOUR_GLSL}
vec2 mappedHeights(vec2 uv) {
  float raw = texture2D(uTex, uv).a;
  float base = raw;
  if (uStyle == 3) base = 1.0 - abs(raw - 0.5) * 2.0;
  float t = 0.0;
  if (uStyle == 0) t = clamp((raw - 0.5) * 2.0, 0.0, 1.0);
  else if (uStyle == 1) t = clamp((0.5 - raw) * 2.0, 0.0, 1.0);
  else if (uStyle == 2) t = raw;
  else if (uStyle == 3) t = clamp(1.0 - abs(raw - 0.5) * 2.0, 0.0, 1.0);
  if (uTechnique == 0) {
    if (uStyle == 0 || uStyle == 1) t = t * (2.0 - t);
    else t = smoothstep(0.0, 1.0, t);
  }
  t = applyContour(t, uContour);
  float h = raw;
  if (uStyle == 0) h = 0.5 + t * 0.5;
  else if (uStyle == 1) h = 0.5 - t * 0.5;
  else if (uStyle == 2) h = t;
  else if (uStyle == 3) h = raw >= 0.5 ? 0.5 + t * 0.5 : 0.5 - t * 0.5;
  return vec2(base, h);
}
void main() {
  vec2 off = uTexelSize * 1.5;
  vec2 tl = mappedHeights(vUv + off * vec2(-1.0, -1.0));
  vec2 tt = mappedHeights(vUv + off * vec2( 0.0, -1.0));
  vec2 tr = mappedHeights(vUv + off * vec2( 1.0, -1.0));
  vec2 ll = mappedHeights(vUv + off * vec2(-1.0,  0.0));
  vec2 rr = mappedHeights(vUv + off * vec2( 1.0,  0.0));
  vec2 bl = mappedHeights(vUv + off * vec2(-1.0,  1.0));
  vec2 bb = mappedHeights(vUv + off * vec2( 0.0,  1.0));
  vec2 br = mappedHeights(vUv + off * vec2( 1.0,  1.0));
  vec2 dx = ((tr + 2.0 * rr + br) - (tl + 2.0 * ll + bl)) / 8.0;
  vec2 dy = ((bl + 2.0 * bb + br) - (tl + 2.0 * tt + tr)) / 8.0;
  vec2 baseGrad = vec2(dx.x, dy.x);
  vec2 contGrad = vec2(dx.y, dy.y);
  float baseLen = length(baseGrad);
  float depthMult = max(uDepth, 0.01) * 3.0;
  vec2 grad = contGrad;
  if (uTechnique == 1) {
    if (baseLen > 0.0001) {
      float slope = dot(contGrad, baseGrad) / (baseLen * baseLen);
      grad = (baseGrad / baseLen) * depthMult * 0.5 * slope;
    } else grad = vec2(0.0);
  } else if (uTechnique == 2) {
    if (baseLen > 0.0001) {
      float slope = dot(contGrad, baseGrad) / (baseLen * baseLen);
      float soft = smoothstep(0.0, 0.05, baseLen);
      grad = (baseGrad / baseLen) * depthMult * 0.5 * soft * slope;
    } else grad = vec2(0.0);
  } else {
    grad = contGrad * depthMult * 2.0;
  }
  float dir = uDirection;
  if (uStyle == 3) dir = -dir;
  vec2 g = grad * dir;
  vec3 normal = normalize(vec3(-g.x, -g.y, 1.0));
  gl_FragColor = vec4(normal * 0.5 + 0.5, mappedHeights(vUv).x);
}`;

const FS_BEVEL_LIGHTING = FS_PREC + `
uniform sampler2D uNormalMap;
uniform float uAngle;
uniform float uAltitude;
uniform float uHighlightOpacity;
uniform float uShadowOpacity;
uniform int uStyle;
uniform int uContour;
varying vec2 vUv;
${BEVEL_CONTOUR_GLSL}
void main() {
  vec4 nd = texture2D(uNormalMap, vUv);
  vec3 normal = nd.rgb * 2.0 - 1.0;
  float blurredAlpha = nd.a;
  float ca = cos(uAltitude), sa = sin(uAltitude);
  vec3 lightDir = normalize(vec3(cos(uAngle) * ca, sin(uAngle) * ca, sa));
  if (uStyle == 3) normal = vec3(-normal.x, -normal.y, normal.z);
  float n = dot(normal, lightDir);
  float flatLight = sa;
  float t = 0.5;
  if (n > flatLight) t = 0.5 + 0.5 * clamp((n - flatLight) / (1.0 - flatLight + 0.0001), 0.0, 1.0);
  else t = 0.5 - 0.5 * clamp((flatLight - n) / (flatLight + 1.0 + 0.0001), 0.0, 1.0);
  float m = applyContour(t, uContour);
  float hl = clamp((m - 0.5) * 2.0, 0.0, 1.0) * uHighlightOpacity;
  float sh = clamp((0.5 - m) * 2.0, 0.0, 1.0) * uShadowOpacity;
  gl_FragColor = vec4(hl, sh, blurredAlpha, 1.0);
}`;

const FS_BEVEL_COMPOSITE = FS_PREC + `
uniform sampler2D uOriginal;
uniform sampler2D uLighting;
uniform vec3 uHighlightColor;
uniform vec3 uShadowColor;
uniform int uHighlightBlend;
uniform int uShadowBlend;
uniform int uStyle;
varying vec2 vUv;
vec3 blendMode(vec3 b, vec3 s, int mode) {
  if (mode == 1) return b * s;
  if (mode == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (mode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (mode == 4) {
    vec3 dd = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b),
               b + (2.0 * s - 1.0) * (dd - b), step(0.5, s));
  }
  if (mode == 5) return min(b, s);
  if (mode == 6) return max(b, s);
  if (mode == 7) return abs(b - s);
  if (mode == 8) return min(vec3(1.0), b + s);
  return s;
}
void main() {
  vec4 orig = texture2D(uOriginal, vUv);
  vec4 light = texture2D(uLighting, vUv);
  float hl = light.r;
  float sh = light.g;
  float blurredAlpha = light.b;
  float origAlpha = orig.a;
  vec3 base = origAlpha > 0.0 ? orig.rgb / origAlpha : vec3(0.0);
  vec3 hlColor = blendMode(base, uHighlightColor, uHighlightBlend);
  vec3 shColor = blendMode(base, uShadowColor, uShadowBlend);
  float edgeSoft = smoothstep(0.0, 0.2, origAlpha);
  float innerMask = origAlpha * edgeSoft;
  float outerMask = clamp(blurredAlpha - origAlpha, 0.0, 1.0);
  vec3 color = base;
  float alpha = origAlpha;
  if (uStyle == 0 || uStyle == 3) {
    color = mix(color, hlColor, hl * innerMask);
    color = mix(color, shColor, sh * innerMask);
  } else {
    vec3 inner = base;
    inner = mix(inner, hlColor, hl * innerMask);
    inner = mix(inner, shColor, sh * innerMask);
    float h = hl * outerMask;
    float s = sh * outerMask;
    float outerA = min(h + s, 1.0);
    vec3 outer = vec3(0.0);
    if (outerA > 0.0) outer = mix(uShadowColor, uHighlightColor, h / outerA);
    alpha = clamp(origAlpha + outerA, 0.0, 1.0);
    color = (inner * origAlpha + outer * outerA) / max(alpha, 0.0001);
  }
  gl_FragColor = vec4(color * alpha, alpha);
}`;

// Soglia: luminanza >= uThresh -> bianco, sotto -> nero (alla Photoshop).
// L'alpha non si tocca: i bordi morbidi restano morbidi ma il colore
// diventa puro. Premultiplied: bianco = (a,a,a,a), nero = (0,0,0,a).
const FS_THRESH = FS_PREC + `
uniform sampler2D uTex;
uniform float uThresh;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv);
  if (c.a < 0.004) { gl_FragColor = c; return; }
  float l = dot(c.rgb / c.a, vec3(0.299, 0.587, 0.114));
  float v = l >= uThresh ? c.a : 0.0;
  gl_FragColor = vec4(v, v, v, c.a);
}`;

// Halftone: Color=0 e' un retino monocromatico; Color=1 usa una rosetta
// CMYK con angoli convenzionali (15/75/0/45). I vuoti diventano trasparenti:
// cosi' il risultato funziona anche come base di una clipping mask. La
// griglia usa coordinate board-locali (uOrigin = origine texture rispetto al
// board), quindi resta stabile rispetto a pan/zoom e fra preview/commit.
const FS_HALFTONE = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform vec2 uOrigin;
uniform float uRadius;
uniform float uSpacing;
uniform float uAngle;
uniform float uColor;
varying vec2 vUv;
vec2 rot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
}
vec2 irot(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
vec2 cellUv(vec2 p, float a) {
  float cell = max(2.0, uSpacing);
  vec2 rp = rot(p, a);
  vec2 g = (floor(rp / cell) + 0.5) * cell;
  vec2 center = irot(g, a);
  vec2 uv = (center - uOrigin) / uTexSize;
  vec2 lo = vec2(0.5) / uTexSize;
  vec2 hi = (uTexSize - vec2(0.5)) / uTexSize;
  return clamp(uv, lo, hi);
}
float dotCov(vec2 p, float a, float amount) {
  amount = clamp(amount, 0.0, 1.0);
  if (amount <= 0.0001) return 0.0;
  float cell = max(2.0, uSpacing);
  vec2 q = rot(p, a) / cell;
  vec2 d = (fract(q) - 0.5) * cell;
  float r = max(0.25, uRadius) * sqrt(amount);
  return 1.0 - smoothstep(r - 0.75, r + 0.75, length(d));
}
vec3 straight(vec4 c) {
  return c.a > 0.004 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(1.0);
}
float lumAt(vec2 uv) {
  return dot(straight(texture2D(uTex, uv)), vec3(0.299, 0.587, 0.114));
}
float cmykAt(vec2 uv, float ch) {
  vec3 rgb = straight(texture2D(uTex, uv));
  float k = 1.0 - max(max(rgb.r, rgb.g), rgb.b);
  if (ch > 2.5) return k;
  float d = 1.0 - k;
  if (d <= 0.00001) return 0.0;
  vec3 cmy = clamp((1.0 - rgb - vec3(k)) / d, 0.0, 1.0);
  if (ch < 0.5) return cmy.r;
  if (ch < 1.5) return cmy.g;
  return cmy.b;
}
void main() {
  vec4 cur = texture2D(uTex, vUv);
  if (cur.a < 0.004) { gl_FragColor = cur; return; }
  vec2 p = vUv * uTexSize + uOrigin;
  float monoInk = dotCov(p, uAngle, 1.0 - lumAt(cellUv(p, uAngle)));
  vec3 paper = vec3(1.0 - monoInk);
  float cover = monoInk;
  float mixColor = clamp(uColor, 0.0, 1.0);
  if (mixColor > 0.001) {
    float ac = uAngle + 0.2617993878;
    float am = uAngle + 1.3089969390;
    float ay = uAngle;
    float ak = uAngle + 0.7853981634;
    float cInk = dotCov(p, ac, cmykAt(cellUv(p, ac), 0.0));
    float mInk = dotCov(p, am, cmykAt(cellUv(p, am), 1.0));
    float yInk = dotCov(p, ay, cmykAt(cellUv(p, ay), 2.0));
    float kInk = dotCov(p, ak, cmykAt(cellUv(p, ak), 3.0));
    vec3 color = vec3((1.0 - cInk) * (1.0 - kInk),
      (1.0 - mInk) * (1.0 - kInk),
      (1.0 - yInk) * (1.0 - kInk));
    float colorCover = 1.0 - (1.0 - cInk) * (1.0 - mInk) * (1.0 - yInk) * (1.0 - kInk);
    paper = mix(paper, color, mixColor);
    cover = mix(cover, colorCover, mixColor);
  }
  if (cover <= 0.0001) { gl_FragColor = vec4(0.0); return; }
  vec3 ink = clamp((paper - vec3(1.0 - cover)) / cover, 0.0, 1.0);
  float a = cur.a * cover;
  gl_FragColor = vec4(ink * a, a);
}`;

// Blur radiale (zoom): media lungo il raggio verso uCenter, scale da 1 a
// 1-uK — si raccoglie solo verso l'interno, il contenuto "scorre" in fuori
// e non si campiona mai oltre il board. Jitter di fase per pixel: rompe le
// bande dei tap radi (grana fine invece di anelli).
const FS_ZOOM = FS_PREC + `
uniform sampler2D uTex;
uniform vec2 uCenter;
uniform float uK;
uniform int uR;
varying vec2 vUv;
const int MAX_R = ${FX_MAX_R};
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 d = vUv - uCenter;
  float n = float(uR);
  float j = hash(vUv * 1024.0) - 0.5;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i <= MAX_R; i++) {
    if (i > uR) break;
    float s = 1.0 - uK * (float(i) + j) / n;
    acc += texture2D(uTex, uCenter + d * s);
    wsum += 1.0;
  }
  gl_FragColor = acc / wsum;
}`;

/** @param {WebGLRenderingContext} gl @param {number} type @param {string} src */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

/** @param {WebGLRenderingContext} gl @param {string} vs @param {string} fs */
function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

/**
 * Sessione dello strumento Sposta/Trasforma: il livello layerId NON si
 * disegna dai suoi chunk ma come UN SOLO quad — la texture piatta del
 * contenuto (hull chunk-aligned x,y,w,h, costruita una volta per sessione,
 * id = timbro) trasformata dall'affine mondo m e clippata al board. Un quad
 * unico evita le cuciture che il filtro bilineare aprirebbe tra chunk
 * adiacenti sotto rotazione/scala.
 * @typedef {Object} TransformFrame
 * @property {number|string} id timbro di sessione: cambia = texture da ricostruire
 * @property {number} layerId
 * @property {import('./store.js').ChunkStore} store
 * @property {number} x @property {number} y origine mondo della texture
 * @property {number} w @property {number} h
 * @property {number[]} m affine mondo [a,b,c,d,e,f]
 * @property {{pts: Float32Array, n: number, ver: number, bx: number, by: number, bw: number, bh: number}|null} [warp]
 *   sessione in modalità Warp con griglia non a riposo (vedi warp.js): il
 *   livello si disegna come MESH — superficie m∘Warp valutata su CPU ai
 *   nodi — invece che come quad; bx..bh = bbox contenuto (dominio griglia)
 * @property {{q: Float32Array, ver: number, bx: number, by: number, bw: number, bh: number}|null} [persp]
 *   sessione in modalità Prospettiva con quad non a riposo (vedi warp.js):
 *   il livello si disegna come quad di 4 vertici con l'omografia inversa
 *   mondo→UV nel fragment shader (esatta); bx..bh = bbox contenuto
 *   (dominio degli angoli). Mai insieme a warp (i tab si escludono)
 * @property {{pos: Float32Array, uv: Float32Array, idx: Uint16Array, pos0: Float32Array, tris: Uint32Array, order: Uint32Array, ver: number, meshVer: number}|null} [puppet]
 *   sessione in modalità Marionetta con deformazione attiva (vedi
 *   puppet.js): il livello si disegna come mesh di triangoli arbitrari —
 *   pos = vertici deformati (mondo), uv nello spazio dell'hull texture,
 *   idx già nell'ordine di piega/profondità. pos0/tris/order servono al
 *   bake 2D. Mai insieme a warp/persp (i tab si escludono)
 * @property {{x0:number,y0:number,x1:number,y1:number}} clip
 */

/**
 * Sessione del pannello Effetti: il livello layerId NON si disegna dai suoi
 * chunk ma come UN quad con la texture sfocata — la sorgente piatta (hull
 * chunk-aligned, id = timbro, costruita una volta per sessione) passa per i
 * pass dell'effetto in FBO, rieseguiti SOLO quando i parametri cambiano: a
 * slider fermo l'anteprima costa un draw. kind: 'gauss' = gaussiana
 * separabile in 2 pass (sigma); 'motion' = box direzionale in 1 pass
 * (angle radianti, dist px totali); 'zoom' = radiale verso il centro in 1
 * pass (k intensità 0..~0.3, cx/cy centro mondo); 'noise' = rumore random
 * (amount, colorMix, grainSize, roughness, seed); 'grain' = grana pellicola
 * (amount, grainSize, roughness, seed); 'thresh' = soglia bianco/nero sulla luminanza (thresh
 * 0..1); 'halftone' = retino a punti (radius/spacing px, angle radianti,
 * colorMix 0=mono 1=CMYK); 'stroke' = traccia del contorno in 2 pass EDT (strokeW px,
 * strokePos 0=esterna 1=centrale 2=interna, strokeR/G/B colore 0..1);
 * 'tint' = sostituzione del colore con alpha intatta (strokeR/G/B);
 * 'bevelEmboss' = smusso/rilievo rasterizzato al commit (bevel).
 * I pixel CPU non si toccano mai: il commit avviene al ✓ (fxReadback = lo
 * stesso risultato). kind 'smudge' = sessione sfumino GPU: la texture di
 * stato la mantengono i dab (smudgeDab), qui passa solo il quad live.
 * @typedef {Object} FxFrame
 * @property {number} id timbro di sessione: cambia = texture da ricostruire
 * @property {'gauss'|'motion'|'zoom'|'noise'|'grain'|'thresh'|'halftone'|'stroke'|'tint'|'bevelEmboss'|'smudge'|'liquify'} kind
 * @property {number} layerId
 * @property {import('./store.js').ChunkStore} store
 * @property {number} x @property {number} y origine mondo della texture
 * @property {number} w @property {number} h
 * @property {number} sigma deviazione standard (gauss, px mondo)
 * @property {number} radius raggio massimo dei punti (halftone, px mondo)
 * @property {number} spacing passo fra i centri dei punti (halftone, px mondo)
 * @property {number} angle direzione (motion, radianti)
 * @property {number} dist corsa totale (motion, px mondo)
 * @property {number} k intensità (zoom, 0..~0.3)
 * @property {number} cx @property {number} cy centro (zoom, px mondo)
 * @property {number} amount ampiezza del disturbo (noise/grain, 0..~0.5)
 * @property {number} colorMix mono->colore (noise, 0..1)
 * @property {number} grainSize px per granello (noise/grain)
 * @property {number} roughness regolarita' del granello (noise/grain, 0..1)
 * @property {number} seed pattern stabile per la sessione (noise/grain)
 * @property {number} thresh livello di soglia (thresh, 0..1)
 * @property {number} strokeW dimensione traccia (stroke, px mondo)
 * @property {number} strokePos 0 esterna, 1 centrale, 2 interna (stroke)
 * @property {number} strokeR @property {number} strokeG @property {number} strokeB colore traccia 0..1 (stroke)
 * @property {any} [bevel] configurazione Bevel & Emboss
 * @property {{x0:number,y0:number,x1:number,y1:number}} clip
 */

export class GLRenderer {
  /** @param {HTMLCanvasElement} canvas @param {{desynchronized?: boolean}} [opts] */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.kind = 'WebGL';
    this.contextLost = false;
    this.texCount = 0;
    this.uploadsThisFrame = 0;
    /** @type {() => ChunkStore[]} provider degli store vivi (context restore) */
    this._storesFn = () => [];
    this._rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this._wantMips = false;    // zoom < 1 nel frame corrente
    this._wantNearest = true;  // zoom > MAG_NEAREST_ZOOM nel frame corrente
    /** @type {WebGLTexture|null} cache screen-space dell'ultimo frame statico */
    this._screenCacheTex = null;
    this._screenCacheW = 0;
    this._screenCacheH = 0;
    this._screenCacheKey = '';
    this.screenCacheHitThisFrame = false;

    // desynchronized: presentazione a bassa latenza (Chrome). Può lampeggiare
    // su alcuni sistemi: il frame va a schermo fuori sincrono col loop.
    // Safari ignora l'opzione. Configurabile dal toggle nel pannello.
    // alpha: true — il canvas è un piano trasparente sopra la griglia CSS
    // (e sopra eventuali livelli testo più in basso nella pila).
    const ctxOpts = {
      alpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false,
      desynchronized: opts && opts.desynchronized !== undefined ? opts.desynchronized : true,
      powerPreference: 'high-performance',
    };
    // WebGL2 quando c'è: serve UNPACK_ROW_LENGTH per caricare solo il
    // sotto-rettangolo sporco del chunk. Gli shader (GLSL ES 1.0) e il resto
    // dell'API sono identici; su WebGL1 si torna all'upload del chunk intero.
    this.gl = /** @type {WebGLRenderingContext} */ (
      canvas.getContext('webgl2', ctxOpts) ||
      canvas.getContext('webgl', ctxOpts) || canvas.getContext('experimental-webgl', ctxOpts));
    if (!this.gl) { this.ok = false; return; }
    this.ok = true;
    this.isGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    this.kind = this.isGL2 ? 'WebGL2' : 'WebGL';

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // la CPU è la verità: si ricrea tutto dai buffer.
      // dropRendererResources copre anche i chunk nel pool: le loro texture
      // appartengono al contesto perso e ribinderle sarebbe INVALID_OPERATION.
      this._init();
      for (const st of this._storesFn()) st.dropRendererResources();
      this.contextLost = false;
    });

    this._init();
  }

  _init() {
    const gl = this.gl;
    // generazione del contesto: le risorse esterne (proxy dei board) la
    // confrontano per dimenticare ciò che apparteneva a un contesto morto
    this.ctxGen = (this.ctxGen || 0) + 1;
    this.progChunk = link(gl, VS_CHUNK, FS_CHUNK);
    this.progErase = link(gl, VS_CHUNK, FS_ERASE);
    this.progPaint = link(gl, VS_CHUNK, FS_PAINT);
    this.progBlit = link(gl, VS_BLIT, FS_BLIT);
    this.progMesh = link(gl, VS_MESH, FS_CHUNK);
    this.progPersp = link(gl, VS_PERSP, FS_PERSP);

    this.wMat = gl.getUniformLocation(this.progMesh, 'uMat');
    this.wAlpha = gl.getUniformLocation(this.progMesh, 'uAlpha');
    this.wTex = gl.getUniformLocation(this.progMesh, 'uTex');
    this.wPos = gl.getAttribLocation(this.progMesh, 'aPos');
    this.wUv = gl.getAttribLocation(this.progMesh, 'aUv');

    this.pMat = gl.getUniformLocation(this.progPersp, 'uMat');
    this.pH = gl.getUniformLocation(this.progPersp, 'uH');
    this.pAlpha = gl.getUniformLocation(this.progPersp, 'uAlpha');
    this.pTex = gl.getUniformLocation(this.progPersp, 'uTex');
    this.pPos = gl.getAttribLocation(this.progPersp, 'aPos');

    this.uMat = gl.getUniformLocation(this.progChunk, 'uMat');
    this.uOrigin = gl.getUniformLocation(this.progChunk, 'uOrigin');
    this.uSize = gl.getUniformLocation(this.progChunk, 'uSize');
    this.uAlpha = gl.getUniformLocation(this.progChunk, 'uAlpha');
    this.uTex = gl.getUniformLocation(this.progChunk, 'uTex');
    this.eMat = gl.getUniformLocation(this.progErase, 'uMat');
    this.eOrigin = gl.getUniformLocation(this.progErase, 'uOrigin');
    this.eSize = gl.getUniformLocation(this.progErase, 'uSize');
    this.eAlpha = gl.getUniformLocation(this.progErase, 'uAlpha');
    this.eLayerA = gl.getUniformLocation(this.progErase, 'uLayerA');
    this.eTex = gl.getUniformLocation(this.progErase, 'uTex');
    this.eMask = gl.getUniformLocation(this.progErase, 'uMask');
    this.plMat = gl.getUniformLocation(this.progPaint, 'uMat');
    this.plOrigin = gl.getUniformLocation(this.progPaint, 'uOrigin');
    this.plSize = gl.getUniformLocation(this.progPaint, 'uSize');
    this.plAlpha = gl.getUniformLocation(this.progPaint, 'uAlpha');
    this.plLayerA = gl.getUniformLocation(this.progPaint, 'uLayerA');
    this.plTex = gl.getUniformLocation(this.progPaint, 'uTex');
    this.plMask = gl.getUniformLocation(this.progPaint, 'uMask');
    this.bTex = gl.getUniformLocation(this.progBlit, 'uTex');

    // quad 0..1 condiviso
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.texCount = 0;
    this._screenCacheTex = null;
    this._screenCacheW = 0;
    this._screenCacheH = 0;
    this._screenCacheKey = '';
    this.screenCacheHitThisFrame = false;

    // texture piatta della sessione di trasformazione (vedi TransformFrame):
    // appartiene al contesto, al restore si dimentica e rinasce on-demand
    /** @type {WebGLTexture|null} */
    this._tfTex = null;
    /** @type {string|number} id del frame (numero, o 'stamp:layerId' in multi-selezione) */
    this._tfId = 0;
    this._tfMat = new Float32Array(9);
    // mesh della sessione Warp: stessa vita della texture piatta (al
    // restore i buffer appartengono al contesto morto e si dimenticano)
    /** @type {WebGLBuffer|null} */
    this._tfMeshPos = null;
    /** @type {WebGLBuffer|null} */
    this._tfMeshUv = null;
    /** @type {WebGLBuffer|null} */
    this._tfMeshIdx = null;
    /** @type {number} */
    this._tfMeshN = 0;
    /** @type {string} id|ver|segs|affine: posizioni da ricostruire */
    this._tfMeshSig = '';
    /** @type {string} id|segs: uv e indici da ricostruire */
    this._tfMeshKey = '';
    // quad della sessione Prospettiva: 4 vertici mondo + omografia inversa
    // (stessa vita della texture piatta: al restore si dimentica)
    /** @type {WebGLBuffer|null} */
    this._tfPerspBuf = null;
    this._tfPerspMat = new Float32Array(9);
    /** @type {string} id|ver|affine: vertici e matrice da ricostruire */
    this._tfPerspSig = '';
    // mesh della sessione Marionetta: triangoli arbitrari già pronti dal
    // solver (stessa vita della texture piatta)
    /** @type {WebGLBuffer|null} */
    this._tfPupPos = null;
    /** @type {WebGLBuffer|null} */
    this._tfPupUv = null;
    /** @type {WebGLBuffer|null} */
    this._tfPupIdx = null;
    /** @type {number} */
    this._tfPupN = 0;
    /** @type {string} id|ver: posizioni e indici da ricaricare */
    this._tfPupSig = '';
    /** @type {string} id|meshVer: uv da ricaricare */
    this._tfPupUvSig = '';

    // risorse della sessione Effetti (vedi FxFrame): sorgente piatta +
    // ping-pong del blur + FBO. Stesso ciclo di vita della trasformazione:
    // al restore si dimenticano (handle del contesto morto) e rinascono.
    /** @type {WebGLTexture|null} */
    this._fxSrc = null;
    /** @type {WebGLTexture|null} */
    this._fxPing = null;
    /** @type {WebGLTexture|null} */
    this._fxOut = null;
    /** @type {any|null} texture di lavoro per Bevel & Emboss in sessione FX */
    this._fxBevel = null;
    /** @type {WebGLFramebuffer|null} */
    this._fxFbo = null;
    /** @type {number} */
    this._fxId = 0;
    /** @type {string} */
    this._fxKey = ''; // firma kind+parametri dell'ultimo blur cotto
    // programmi degli effetti, compilati pigramente al primo uso per kind
    /** @type {Record<string, WebGLProgram>} */
    this._fxProgs = {};
    /** @type {Record<string, Record<string, WebGLUniformLocation>>} */
    this._fxUni = {};

    // sessione sfumino GPU (vedi smudgeBegin): stato + scratch dei dab.
    // Stesso ciclo di vita delle risorse fx: al restore si dimenticano.
    /** @type {WebGLTexture|null} */
    this._smState = null;
    /** @type {WebGLTexture|null} */
    this._smScratch = null;
    /** @type {WebGLTexture|null} */
    this._smBlur = null;
    /** @type {WebGLTexture|null} */
    this._smPing = null;
    /** @type {WebGLFramebuffer|null} */
    this._smFbo = null;
    this._smW = 0; this._smH = 0; this._smX = 0; this._smY = 0;
    this._smS = 0; this._smPad = 0; this._smMaxOff = 0;
    /** @type {{radius:number, hardness:number, sigma:number, drag:number, blurOpacity:number, useBlur:boolean}|null} */
    this._smP = null;

    // sessione liquify GPU (vedi liquifyBegin): base + campo di spostamento
    // RGBA16F + resolved. Stesso ciclo di vita: al restore si dimenticano.
    /** @type {WebGLTexture|null} */
    this._lqBase = null;
    /** @type {WebGLTexture|null} */
    this._lqDisp = null;
    /** @type {WebGLTexture|null} */
    this._lqScratch = null;
    /** @type {WebGLTexture|null} */
    this._lqResolved = null;
    /** @type {WebGLFramebuffer|null} */
    this._lqFbo = null;
    this._lqW = 0; this._lqH = 0; this._lqX = 0; this._lqY = 0;
    this._lqS = 0; this._lqPad = 0;
    /** @type {{radius:number, chaos:number, seed:number}|null} */
    this._lqP = null;

    /** @type {Map<number, any>} cache layerId -> texture styled */
    this._styleCache = new Map();
    /** @type {Record<string, WebGLProgram>} */
    this._styleProgs = {};
    /** @type {Record<string, Record<string, WebGLUniformLocation>>} */
    this._styleUni = {};

    // metodi di fusione "shader" (multiply, overlay, ...): programmi per
    // modo compilati pigramente; la texture backdrop (canvas-size) vive
    // solo finché un livello con uno di questi modi è in vista (VRAM)
    /** @type {Record<string, WebGLProgram>} */
    this._modeProgs = {};
    /** @type {Record<string, Record<string, WebGLUniformLocation>>} */
    this._modeUni = {};
    /** @type {WebGLTexture|null} */
    this._bdTex = null;
    /** @type {number} */
    this._bdW = 0;
    /** @type {number} */
    this._bdH = 0;
    this._bdUsed = false;
    // true mentre il livello corrente si disegna con blendFunc di modo
    // (screen/add): il tratto live DEVE passare dal pass combinato
    this._modeFF = false;

    // texture 1x1 trasparente per i chunk senza maschera gomma
    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(4));

    // FBO dei gruppi di ritaglio: texture canvas-size riusata da tutti i
    // gruppi (composti in sequenza), ricreata al resize / context restore
    /** @type {WebGLTexture|null} */
    this._grpTex = null;
    /** @type {WebGLFramebuffer|null} */
    this._grpFbo = null;
    /** @type {number} */
    this._grpW = 0;
    /** @type {number} */
    this._grpH = 0;
  }

  /** @param {number} wCss @param {number} hCss @param {number} dpr */
  resize(wCss, hCss, dpr) {
    const w = Math.round(wCss * dpr), h = Math.round(hCss * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** @param {() => ChunkStore[]} fn provider degli store da risanare al context restore */
  trackStores(fn) { this._storesFn = fn; }

  /** @param {Chunk} chunk */
  _ensureTex(chunk) {
    const gl = this.gl;
    if (!chunk.tex) {
      chunk.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CHUNK, CHUNK, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      chunk.texDirty = true;
      chunk.mips = false;
      chunk.mipOn = false;
      chunk.magNear = true; // la texture nasce con MAG_FILTER = NEAREST
      this.texCount++;
    }
    return chunk.tex;
  }

  // Filtri di campionamento in funzione dello zoom, aggiornati pigramente
  // per chunk (con la texture già bound sull'unità attiva):
  //   - zoom < 1 (minificazione): LINEAR campiona solo 4 texel e i tratti
  //     sottili si sgranano/spezzano -> mipmap, (ri)generate solo per i
  //     chunk cambiati e solo quando servono;
  //   - zoom 1..MAG_NEAREST_ZOOM: ingrandimento ammorbidito (MAG LINEAR);
  //   - oltre: pixel nitidi (MAG NEAREST) per il lavoro di dettaglio.
  /** @param {Chunk} chunk */
  _applyMips(chunk) {
    const gl = this.gl;
    if (this._wantMips) {
      if (!chunk.mips) {
        gl.generateMipmap(gl.TEXTURE_2D); // CHUNK=256 è POT: ok anche su WebGL1
        chunk.mips = true;
      }
      if (!chunk.mipOn) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        chunk.mipOn = true;
      }
    } else if (chunk.mipOn) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      chunk.mipOn = false;
    }
    if (this._wantNearest !== chunk.magNear) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,
        this._wantNearest ? gl.NEAREST : gl.LINEAR);
      chunk.magNear = this._wantNearest;
    }
  }

  // Upload dei soli chunk sporchi. Su WebGL2, se la texture è già valida,
  // carica solo il rettangolo sporco accumulato (UNPACK_ROW_LENGTH = stride
  // del chunk): un pennello piccolo passa da 256KB a pochi KB per chunk.
  // Ritorna i byte caricati.
  /** @param {ChunkStore} store */
  uploadDirty(store) {
    if (this.contextLost) { store.dirty.clear(); return 0; }
    const gl = this.gl;
    let bytes = 0;
    let rowLenSet = false;
    for (const chunk of store.dirty) {
      if (!store.map.has(chunk.key)) continue; // rilasciato nel frattempo
      if (this.isGL2 && chunk.tex && !chunk.texDirty && chunk.dirX1 >= chunk.dirX0) {
        const x0 = chunk.dirX0, y0 = chunk.dirY0;
        const w = chunk.dirX1 - x0 + 1, h = chunk.dirY1 - y0 + 1;
        if (!rowLenSet) {
          /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
            WebGL2RenderingContext.UNPACK_ROW_LENGTH, CHUNK);
          rowLenSet = true;
        }
        gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
        // vista che parte dal primo pixel del rect; le righe seguono lo
        // stride del chunk via ROW_LENGTH (byteOffset: memoria wasm)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array(chunk.data.buffer,
            chunk.data.byteOffset + (y0 * CHUNK + x0) * 4,
            ((h - 1) * CHUNK + w) * 4));
        bytes += w * h * 4;
        this.uploadsThisFrame++;
        chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
        chunk.mips = false; // il livello 0 è cambiato: catena mip stantia
      } else {
        if (rowLenSet) {
          // _uploadNow carica il chunk intero: stride di default
          /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
            WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
          rowLenSet = false;
        }
        this._uploadNow(chunk);
        bytes += chunk.data.length;
      }
    }
    if (rowLenSet) {
      /** @type {WebGL2RenderingContext} */ (gl).pixelStorei(
        WebGL2RenderingContext.UNPACK_ROW_LENGTH, 0);
    }
    store.dirty.clear();
    return bytes;
  }

  /** @param {Chunk} chunk */
  disposeChunkTex(chunk) {
    if (chunk.tex) {
      if (!this.contextLost) this.gl.deleteTexture(chunk.tex);
      chunk.tex = null;
      this.texCount--;
    }
  }

  // Lega programma chunk + quad + uniform comuni (anche dopo il pass gomma).
  /** @param {Camera} camera */
  _bindChunkProg(camera) {
    const gl = this.gl;
    gl.useProgram(this.progChunk);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progChunk, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.uMat, false, camera.matrix());
    gl.uniform2f(this.uSize, CHUNK, CHUNK);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Disegna i livelli raster del gruppo dal basso verso l'alto, con
   * l'opacità del livello. Lo stroke live entra subito sopra il livello
   * attivo; con la gomma il livello attivo è attenuato dalla maschera.
   * I layer nel set proxies.skip non si disegnano: al loro posto ci sono i
   * quad piatti dei board (proxies.quads), uno per board — lo zoom-out non
   * paga più un draw e una texture per ogni chunk.
   * transform: il livello in sessione Sposta/Trasforma si disegna come quad
   * unico con la matrice della sessione e scissor sul board — anteprima
   * fedele del commit, zero pixel mossi (vedi TransformFrame).
   * fx: il livello in sessione Effetti si disegna come quad sfocato con
   * scissor sul board — anteprima identica al commit (vedi FxFrame).
   * textQuads/svgQuads: i vettori NON in editing stanno nella pila come gli
   * altri e si disegnano qui come quad cotti (texture dal bake CPU), con
   * scissor sul loro board — il run raster non si spezza più sull'SVG.
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {import('./board_proxy.js').ProxyFrame|null} [proxies]
   * @param {TransformFrameSet} [transform] frame singolo o array (multi-selezione)
   * @param {FxFrame|null} [fx]
   * @param {import('./text_quad.js').TextQuadCache|null} [textQuads]
   * @param {import('./svg_quad.js').SvgQuadCache|null} [svgQuads]
   */
  render(camera, layers, activeId, strokeStore, strokeOpacity, eraserLive, proxies = null, transform = null, fx = null, textQuads = null, svgQuads = null) {
    if (this.contextLost) return;
    const gl = this.gl;
    this.uploadsThisFrame = 0;
    this.screenCacheHitThisFrame = false;
    this._wantMips = camera.zoom < 1;
    this._wantNearest = camera.zoom > MAG_NEAREST_ZOOM;
    const screenCacheOk = this._canUseScreenCache(strokeStore, proxies, transform, fx, textQuads, svgQuads);
    const screenCacheKey = screenCacheOk
      ? this._makeScreenCacheKey(camera, layers, activeId, proxies, textQuads, svgQuads)
      : '';
    if (!screenCacheOk) this._screenCacheKey = '';
    if (screenCacheOk && this._screenCacheTex &&
      this._screenCacheW === this.canvas.width &&
      this._screenCacheH === this.canvas.height &&
      this._screenCacheKey === screenCacheKey) {
      this.screenCacheHitThisFrame = true;
      this._drawScreenCache();
      return;
    }
    // sessione finita o cambiata: la texture piatta vecchia si libera subito
    if (this._tfTex && transform === null) {
      this._freeTransformTex();
    }
    const fxLive = fx !== null && (fx.kind === 'smudge' || fx.kind === 'liquify');
    if (this._fxSrc && (fx === null || fxLive || fx.id !== this._fxId)) this._freeFxTex();
    // blur su FBO propri PRIMA del present (viewport/blend/program suoi);
    // no-op se sigma non è cambiato dall'ultimo frame. I kind 'smudge' e
    // 'liquify' NON cuociono nulla qui: le loro texture le mantengono i dab.
    if (fx !== null && !fxLive) this._ensureFxBlur(fx);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // piano trasparente: la griglia CSS (e i piani sotto) restano visibili
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._bindChunkProg(camera);

    // quad dei board proxati (i board non si sovrappongono: ordine libero)
    if (proxies && proxies.quads.length > 0) {
      gl.uniform1f(this.uAlpha, 1);
      for (const q of proxies.quads) {
        gl.uniform2f(this.uSize, q.w, q.h);
        gl.uniform2f(this.uOrigin, q.x, q.y);
        gl.bindTexture(gl.TEXTURE_2D, q.tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.uniform2f(this.uSize, CHUNK, CHUNK);
    }
    const skip = proxies ? proxies.skip : null;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;
      if (skip !== null && skip.has(layer.id)) continue;
      if (layer.kind === 'text') {
        // testo cotto alla sua posizione nella pila (l'SVG vivo dei testi
        // in editing non passa da qui: ha il suo piano)
        if (textQuads) {
          const q = textQuads.quadFor(layer.id, camera);
          if (q) this._drawTextQuad(camera, layer, q);
        }
        continue;
      }
      if (layer.kind === 'svg') {
        if (svgQuads) {
          const q = svgQuads.quadFor(layer.id, camera);
          if (q) this._drawVectorQuad(camera, layer, q);
        }
        continue;
      }
      if (layer.kind !== 'raster') continue;
      // membro di un gruppo di ritaglio: lo disegna il pass della sua base
      // (e se la base è nascosta o a opacità 0, l'intero gruppo è invisibile)
      if (layer.clip && layer.clipBase) continue;
      // base di un gruppo? I figli sono la catena CONTIGUA di clippati sopra
      // (base risolta a monte da App._frame, mai attraverso i board)
      let gEnd = i + 1;
      while (gEnd < layers.length &&
        layers[gEnd].clip && layers[gEnd].clipBase === layer) gEnd++;
      if (gEnd > i + 1) {
        this._renderClipGroup(camera, layers, i, gEnd, activeId, strokeStore,
          strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1);
        i = gEnd - 1;
        continue;
      }
      const mode = layer.mode || 'normal';
      const layerTransform = transformForLayer(transform, layer.id);
      const inSession = layerTransform !== null ||
        (fx !== null && fx.layerId === layer.id);
      if (SHADER_MODES.has(mode)) {
        if (inSession) {
          // in sessione il livello è un quad/mesh, non chunk: si disegna
          // nell'FBO trasparente e si presenta col pass di fusione —
          // modo live anche durante il drag
          this._drawBlendSession(camera, layer, mode, activeId, strokeStore,
            strokeOpacity, eraserLive, layerTransform, fx, cx0, cy0, cx1, cy1);
        } else {
          // modo "shader": pass dedicato col backdrop
          const live = layer.id === activeId && strokeStore !== null && strokeStore.map.size > 0;
          this._drawBlendLayer(camera, layer, mode, live ? strokeStore : null,
            strokeOpacity, live && eraserLive, cx0, cy0, cx1, cy1);
        }
        this._bindChunkProg(camera); // il pass fusione ha cambiato programma
        continue;
      }
      this._modeFF = this._setModeBlend(mode); // screen/add: blendFunc esatto
      this._drawLayer(camera, layer, activeId, strokeStore, strokeOpacity,
        eraserLive, layerTransform, fx, cx0, cy0, cx1, cy1);
      if (this._modeFF) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this._modeFF = false;
      }
    }
    // la texture backdrop vive solo finché un modo shader è in vista
    if (this._bdTex && !this._bdUsed) {
      gl.deleteTexture(this._bdTex);
      this._bdTex = null;
      this._bdW = 0;
      this._bdH = 0;
    }
    this._bdUsed = false;
    if (screenCacheOk) this._captureScreenCache(screenCacheKey);
  }

  /**
   * Cache screen-space: quando documento, camera e proxy sono identici al
   * frame precedente, un blit sostituisce centinaia/migliaia di draw live.
   * Non entra durante tratti, trasformazioni, effetti, build proxy o bake
   * testo: quei frame devono aggiornare il contenuto reale prima di cacheare.
   * @param {ChunkStore|null} strokeStore
   * @param {import('./board_proxy.js').ProxyFrame|null} proxies
   * @param {TransformFrameSet} transform
   * @param {FxFrame|null} fx
   * @param {import('./text_quad.js').TextQuadCache|null} textQuads
   * @param {import('./svg_quad.js').SvgQuadCache|null} svgQuads
   */
  _canUseScreenCache(strokeStore, proxies, transform, fx, textQuads, svgQuads) {
    if (strokeStore && strokeStore.map.size > 0) return false;
    if (transform !== null || fx !== null) return false;
    if (proxies && proxies.loading && proxies.loading.size > 0) return false;
    if (textQuads && textQuads.bakedThisFrame > 0) return false;
    if (svgQuads && svgQuads.bakedThisFrame > 0) return false;
    return true;
  }

  /**
   * @param {Camera} camera @param {Layer[]} layers @param {number} activeId
   * @param {import('./board_proxy.js').ProxyFrame|null} proxies
   * @param {import('./text_quad.js').TextQuadCache|null} textQuads
   * @param {import('./svg_quad.js').SvgQuadCache|null} svgQuads
   */
  _makeScreenCacheKey(camera, layers, activeId, proxies, textQuads, svgQuads) {
    const parts = [
      this.ctxGen, this.canvas.width, this.canvas.height,
      camera.x, camera.y, camera.zoom, camera.w, camera.h, camera.dpr,
      activeId, textQuads ? (textQuads.cacheSerial || 0) : 0,
      svgQuads ? (svgQuads.cacheSerial || 0) : 0,
    ];
    if (proxies) {
      parts.push(proxies.quads.length, proxies.skip.size);
      for (const id of proxies.skip) parts.push(id);
    } else {
      parts.push(0, 0);
    }
    for (const l of layers) {
      parts.push(l.id, l.kind || '', l.visible ? 1 : 0, l.opacity, l.mode || 'normal',
        l.clip ? 1 : 0, l.clipBase ? l.clipBase.id : 0);
      if (l.store) parts.push(l.store.ver, l.store.map.size);
      else parts.push(l.ver || 0);
    }
    return parts.join('|');
  }

  _ensureScreenCacheTex() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (!this._screenCacheTex) {
      this._screenCacheTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._screenCacheTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._screenCacheW = 0;
      this._screenCacheH = 0;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this._screenCacheTex);
    }
    if (this._screenCacheW !== w || this._screenCacheH !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._screenCacheW = w;
      this._screenCacheH = h;
      this._screenCacheKey = '';
    }
  }

  /** @param {string} key */
  _captureScreenCache(key) {
    const gl = this.gl;
    this._ensureScreenCacheTex();
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0,
      this.canvas.width, this.canvas.height);
    this._screenCacheKey = key;
  }

  _drawScreenCache() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.progBlit);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progBlit, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.bTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._screenCacheTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Quad di un livello testo cotto (TextQuadCache): texture dal canvas del
  // bake (caricata/ricaricata qui, premoltiplicata all'upload come il testo
  // del proxy), scissor sul board del livello — lo stesso clip dell'SVG.
  // Presuppone progChunk legato; lascia lo stato dei chunk com'era.
  /** @typedef {{canvas: HTMLCanvasElement, tex: WebGLTexture|null, texGen: number, texDirty: boolean, x: number, y: number, w: number, h: number}} VectorQuad */

  /** @param {Camera} camera @param {Layer} layer @param {import('./text_quad.js').TextQuadEntry} q */
  _drawTextQuad(camera, layer, q) {
    this._drawVectorQuad(camera, layer, q);
  }

  /** @param {Camera} camera @param {Layer} layer @param {VectorQuad} q */
  _drawVectorQuad(camera, layer, q) {
    const gl = this.gl;
    this._ensureTextQuadTex(q);
    // il blending del livello è normal per testo/SVG cotti.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const b = layer.clipBoard;
    if (b) {
      let c = this._tqClip;
      if (!c) c = this._tqClip = { x0: 0, y0: 0, x1: 0, y1: 0 };
      c.x0 = b.x; c.y0 = b.y;
      c.x1 = b.x + b.w - 1; c.y1 = b.y + b.h - 1;
      this._scissorClip(camera, c);
    }
    gl.uniform1f(this.uAlpha, layer.opacity);
    gl.uniform2f(this.uSize, q.w, q.h);
    gl.uniform2f(this.uOrigin, q.x, q.y);
    gl.bindTexture(gl.TEXTURE_2D, q.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniform2f(this.uSize, CHUNK, CHUNK); // stato per i chunk dopo
    if (b) gl.disable(gl.SCISSOR_TEST);
  }

  // Texture del bake testo: (ri)creata col contesto corrente e ricaricata
  // dal canvas quando il bake cambia (texDirty). Il canvas è straight-alpha:
  // si premoltiplica all'upload. MAG sempre LINEAR (contenuto vettoriale a
  // risoluzione finita: NEAREST lo squadretterebbe); in minificazione su
  // WebGL2 le mipmap coprono il transitorio dello zoom prima della
  // ricottura (su WebGL1 il bake è NPOT: niente mip, LINEAR basta perché
  // la scala cotta segue lo zoom assestato).
  /** @param {VectorQuad} q bake testo o SVG (stessi campi texture) */
  _ensureTextQuadTex(q) {
    const gl = this.gl;
    if (q.tex && q.texGen === this.ctxGen && !q.texDirty) return;
    if (!q.tex || q.texGen !== this.ctxGen) {
      q.tex = gl.createTexture();
      q.texGen = this.ctxGen;
      gl.bindTexture(gl.TEXTURE_2D, q.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, q.tex);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, q.canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (this.isGL2) {
      gl.generateMipmap(gl.TEXTURE_2D); // NPOT: ok su WebGL2
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    q.texDirty = false;
    this.uploadsThisFrame++;
  }

  // Disegna UN livello (chunk, gomma live o quad di sessione) sul render
  // target corrente. Presuppone progChunk legato; il blending del target è
  // del chiamante (gruppi di ritaglio: DST_ALPHA per i figli).
  /**
   * @param {Camera} camera @param {Layer} layer @param {number} activeId
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {TransformFrame|null} transform frame del SOLO layer (narrowed dal chiamante via transformForLayer)
   * @param {FxFrame|null} fx
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawLayer(camera, layer, activeId, strokeStore, strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    const live = layer.id === activeId && strokeStore && strokeStore.map.size > 0;
    if (transform !== null && transform.layerId === layer.id) {
      // sessione Sposta/Trasforma: un quad con matrice camera·T
      this._ensureTransformTex(transform);
      this._scissorClip(camera, transform.clip);
      if (transform.warp) {
        // modalità Warp: mesh al posto del quad (vedi VS_MESH e warp.js)
        this._drawTransformMesh(camera, transform, layer.opacity);
        this._bindChunkProg(camera); // il pass mesh ha cambiato programma
        gl.disable(gl.SCISSOR_TEST);
        return;
      }
      if (transform.persp) {
        // modalità Prospettiva: quad con omografia nel fragment shader
        this._drawTransformPersp(camera, transform, layer.opacity);
        this._bindChunkProg(camera); // il pass prospettiva ha cambiato programma
        gl.disable(gl.SCISSOR_TEST);
        return;
      }
      if (transform.puppet) {
        // modalità Marionetta: mesh di triangoli arbitrari (vedi puppet.js)
        this._drawTransformPuppet(camera, transform, layer.opacity);
        this._bindChunkProg(camera); // il pass mesh ha cambiato programma
        gl.disable(gl.SCISSOR_TEST);
        return;
      }
      const t = transform.m, cm = camera.matrix(), M = this._tfMat;
      M[0] = cm[0] * t[0]; M[1] = cm[4] * t[1]; M[2] = 0;
      M[3] = cm[0] * t[2]; M[4] = cm[4] * t[3]; M[5] = 0;
      M[6] = cm[0] * t[4] + cm[6]; M[7] = cm[4] * t[5] + cm[7]; M[8] = 1;
      gl.uniformMatrix3fv(this.uMat, false, M);
      gl.uniform1f(this.uAlpha, layer.opacity);
      gl.uniform2f(this.uSize, transform.w, transform.h);
      gl.uniform2f(this.uOrigin, transform.x, transform.y);
      gl.bindTexture(gl.TEXTURE_2D, this._tfTex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniformMatrix3fv(this.uMat, false, cm); // stato per i layer dopo
      gl.uniform2f(this.uSize, CHUNK, CHUNK);
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    if (fx !== null && (fx.kind === 'smudge' || fx.kind === 'liquify') && fx.layerId === layer.id) {
      // sessione sfumino/liquify GPU: il livello è la texture di sessione,
      // clippata al board (i dab l'hanno già aggiornata in questo frame)
      const tex = fx.kind === 'smudge' ? this._smState : this._lqResolved;
      if (tex) {
        this._scissorClip(camera, fx.clip);
        gl.uniform1f(this.uAlpha, layer.opacity);
        gl.uniform2f(this.uSize, fx.w, fx.h);
        gl.uniform2f(this.uOrigin, fx.x, fx.y);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.uniform2f(this.uSize, CHUNK, CHUNK);
        gl.disable(gl.SCISSOR_TEST);
        return;
      }
    }
    if (fx !== null && fx.kind !== 'smudge' && fx.kind !== 'liquify' && fx.layerId === layer.id && this._fxOut) {
      // sessione Effetti: il livello è il quad cotto, clippato al board
      this._scissorClip(camera, fx.clip);
      gl.uniform1f(this.uAlpha, layer.opacity);
      gl.uniform2f(this.uSize, fx.w, fx.h);
      gl.uniform2f(this.uOrigin, fx.x, fx.y);
      gl.bindTexture(gl.TEXTURE_2D, this._fxOut);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniform2f(this.uSize, CHUNK, CHUNK);
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    if (live && eraserLive) {
      this._drawErase(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1);
      this._bindChunkProg(camera); // il pass gomma ha cambiato programma
      return;
    }
    if (live && (layer.opacity < 1 || this._modeFF)) {
      // livello semitrasparente (o con blendFunc di modo attivo): tratto e
      // chunk si compongono fuori dal canvas e si presentano in UN draw
      // (vedi FS_PAINT) — l'over diretto qui sotto applicherebbe opacità o
      // modo due volte dove si sovrappongono
      this._drawPaintLive(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1);
      this._bindChunkProg(camera); // il pass pittura ha cambiato programma
      return;
    }
    gl.uniform1f(this.uAlpha, layer.opacity);
    this._drawStore(layer.store, cx0, cy0, cx1, cy1);
    if (live) {
      // visivamente il tratto appartiene al livello: ne eredita l'opacità
      // (a opacità 1 l'over diretto coincide già col commit)
      gl.uniform1f(this.uAlpha, strokeOpacity * layer.opacity);
      this._drawStore(strokeStore, cx0, cy0, cx1, cy1);
    }
  }

  // Gruppo di ritaglio (vedi commento sugli shader): base + figli composti
  // nell'FBO canvas-size — base con blending normale (la SUA alpha è la
  // forma del gruppo), figli con DST_ALPHA (il colore sostituisce, l'alpha
  // resta della base) — poi UN blit sul canvas. Tutto live gratis: tratti
  // e sessioni della base o dei figli passano dagli stessi path per-livello.
  /**
   * @param {Camera} camera @param {Layer[]} layers
   * @param {number} baseIdx @param {number} endIdx
   * @param {number} activeId @param {ChunkStore|null} strokeStore
   * @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {TransformFrameSet} transform @param {FxFrame|null} fx
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _renderClipGroup(camera, layers, baseIdx, endIdx, activeId, strokeStore, strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    this._ensureGroupTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._grpFbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const baseTransform = transformForLayer(transform, layers[baseIdx].id);
    this._drawLayer(camera, layers[baseIdx], activeId, strokeStore,
      strokeOpacity, eraserLive, baseTransform, fx, cx0, cy0, cx1, cy1);
    gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (let j = baseIdx + 1; j < endIdx; j++) {
      const child = layers[j];
      if (!child.visible || child.opacity <= 0) continue;
      this._drawLayer(camera, child, activeId, strokeStore,
        strokeOpacity, eraserLive, transformForLayer(transform, child.id), fx, cx0, cy0, cx1, cy1);
    }
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // il gruppo si presenta sul canvas con un blit 1:1 (stesso NDC: no flip);
    // il metodo di fusione della BASE si applica QUI, al gruppo intero
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const base = layers[baseIdx];
    const mode = base.mode || 'normal';
    const inSession = baseTransform !== null ||
      (fx !== null && fx.layerId === base.id);
    if (SHADER_MODES.has(mode)) {
      // bbox del gruppo = bbox della base: l'alpha dei figli è inchiodata
      // alla sua (DST_ALPHA), fuori dai suoi chunk il gruppo è vuoto; con
      // la base in sessione il contenuto è il quad: bbox = clip di sessione
      const live = base.id === activeId && strokeStore !== null &&
        strokeStore.map.size > 0 && !eraserLive;
      const rect = inSession
        ? this._clipRectDev(camera, baseTransform !== null ? baseTransform.clip : fx.clip)
        : this._chunkRectDev(camera, base.store,
          live ? strokeStore : null, cx0, cy0, cx1, cy1);
      if (rect) this._blendBlitGroup(mode, rect);
      this._bindChunkProg(camera);
      return;
    }
    const ff = this._setModeBlend(mode); // screen/add: blendFunc esatto
    gl.useProgram(this.progBlit);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progBlit, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.bTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (ff) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._bindChunkProg(camera); // stato per i layer dopo
  }

  // FBO dei gruppi: texture canvas-size, creata/ridimensionata pigramente.
  _ensureGroupTarget() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (!this._grpTex) {
      this._grpTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._grpW = 0;
      this._grpH = 0;
    }
    if (this._grpW !== w || this._grpH !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._grpW = w;
      this._grpH = h;
    }
    if (!this._grpFbo) {
      this._grpFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._grpFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, this._grpTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  // Costruisce (una volta per sessione) la texture piatta del livello:
  // i chunk copiati fianco a fianco — dentro UN livello non si sovrappongono,
  // quindi niente compositing, solo texSubImage2D. LINEAR per la rotazione.
  /** @param {TransformFrame} tf */
  _ensureTransformTex(tf) {
    if (this._tfId === tf.id && this._tfTex) return;
    this._freeTransformTex();
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tf.w, tf.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const c of tf.store.map.values()) {
      const ox = c.cx * CHUNK - tf.x, oy = c.cy * CHUNK - tf.y;
      if (ox < 0 || oy < 0 || ox + CHUNK > tf.w || oy + CHUNK > tf.h) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length));
    }
    this._tfTex = tex;
    this._tfId = tf.id;
  }

  _freeTransformTex() {
    if (this._tfTex) {
      this.gl.deleteTexture(this._tfTex);
      this._tfTex = null;
    }
    this._tfId = 0;
    if (this._tfMeshPos) {
      this.gl.deleteBuffer(this._tfMeshPos);
      this.gl.deleteBuffer(this._tfMeshUv);
      this.gl.deleteBuffer(this._tfMeshIdx);
      this._tfMeshPos = null;
      this._tfMeshUv = null;
      this._tfMeshIdx = null;
    }
    this._tfMeshN = 0;
    this._tfMeshSig = '';
    this._tfMeshKey = '';
    if (this._tfPerspBuf) {
      this.gl.deleteBuffer(this._tfPerspBuf);
      this._tfPerspBuf = null;
    }
    this._tfPerspSig = '';
    if (this._tfPupPos) {
      this.gl.deleteBuffer(this._tfPupPos);
      this.gl.deleteBuffer(this._tfPupUv);
      this.gl.deleteBuffer(this._tfPupIdx);
      this._tfPupPos = null;
      this._tfPupUv = null;
      this._tfPupIdx = null;
    }
    this._tfPupN = 0;
    this._tfPupSig = '';
    this._tfPupUvSig = '';
  }

  // Mesh della sessione Warp: superficie valutata su CPU SOLO quando
  // griglia/affine cambiano (la firma copre anche il timbro di sessione);
  // pan/zoom restano nella matrice camera del vertex shader e a parametri
  // fermi l'anteprima costa un drawElements. Stessa texture piatta del quad.
  /** @param {Camera} camera @param {TransformFrame} tf @param {number} alpha */
  _drawTransformMesh(camera, tf, alpha) {
    const gl = this.gl, w = tf.warp;
    // 16 suddivisioni per cella: le curve restano lisce anche a 5×5 senza
    // superare i ~9.4k vertici (indici a 16 bit larghi)
    const segs = Math.min(96, w.n * 16);
    const sig = `${tf.id}|${w.ver}|${segs}|${tf.m.join(',')}`;
    if (sig !== this._tfMeshSig) this._buildTransformMesh(tf, segs, sig);
    gl.useProgram(this.progMesh);
    gl.uniformMatrix3fv(this.wMat, false, camera.matrix());
    gl.uniform1f(this.wAlpha, alpha);
    gl.uniform1i(this.wTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._tfTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfMeshPos);
    gl.enableVertexAttribArray(this.wPos);
    gl.vertexAttribPointer(this.wPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfMeshUv);
    gl.enableVertexAttribArray(this.wUv);
    gl.vertexAttribPointer(this.wUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._tfMeshIdx);
    gl.drawElements(gl.TRIANGLES, this._tfMeshN, gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    // gli attributi della mesh non devono restare abilitati per i chunk
    gl.disableVertexAttribArray(this.wPos);
    gl.disableVertexAttribArray(this.wUv);
  }

  /** @param {TransformFrame} tf @param {number} segs @param {string} sig */
  _buildTransformMesh(tf, segs, sig) {
    const gl = this.gl, w = tf.warp;
    if (!this._tfMeshPos) {
      this._tfMeshPos = gl.createBuffer();
      this._tfMeshUv = gl.createBuffer();
      this._tfMeshIdx = gl.createBuffer();
      this._tfMeshKey = '';
    }
    const pads = warpPads(w.bx, w.by, w.bw, w.bh, tf.x, tf.y, tf.w, tf.h);
    const bbox = { x: w.bx, y: w.by, w: w.bw, h: w.bh };
    const u0 = -pads.l / w.bw, u1 = 1 + pads.r / w.bw;
    const v0 = -pads.t / w.bh, v1 = 1 + pads.b / w.bh;
    const pos = warpGridWorld(w.pts, w.n, bbox, tf.m, u0, u1, v0, v1, segs, segs);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfMeshPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    this._tfMeshSig = sig;
    const cols = segs + 1;
    // indici nell'ordine di piega (più spostato = disegnato dopo = sopra):
    // dipendono dal warp, si ricostruiscono insieme alle posizioni
    const order = warpFoldOrder(pos, bbox, tf.m, u0, u1, v0, v1, segs, segs);
    const idx = new Uint16Array(segs * segs * 6);
    let q = 0;
    for (const cell of order) {
      const i = (cell / segs) | 0, j = cell % segs;
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = d;
      idx[q++] = a; idx[q++] = d; idx[q++] = c;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._tfMeshIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    this._tfMeshN = segs * segs * 6;
    const key = `${tf.id}|${segs}`;
    if (this._tfMeshKey === key) return;
    this._tfMeshKey = key;
    // uv nello spazio dell'hull (la texture piatta): statici per sessione
    const uv = new Float32Array(cols * cols * 2);
    let k = 0;
    for (let i = 0; i < cols; i++) {
      const sy = (w.by - pads.t + (w.bh + pads.t + pads.b) * i / segs - tf.y) / tf.h;
      for (let j = 0; j < cols; j++) {
        uv[k++] = (w.bx - pads.l + (w.bw + pads.l + pads.r) * j / segs - tf.x) / tf.w;
        uv[k++] = sy;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfMeshUv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  }

  // Mesh della sessione Marionetta: posizioni/indici arrivano già pronti
  // dal solver (transform_ui) e si ricaricano SOLO quando la deformazione
  // cambia (ver); le UV sono statiche per mesh (meshVer). Pan e zoom
  // restano nella matrice camera: a deformazione ferma l'anteprima costa un
  // drawElements. Stessa texture piatta e stesso programma della mesh Warp.
  /** @param {Camera} camera @param {TransformFrame} tf @param {number} alpha */
  _drawTransformPuppet(camera, tf, alpha) {
    const gl = this.gl, p = tf.puppet;
    if (!this._tfPupPos) {
      this._tfPupPos = gl.createBuffer();
      this._tfPupUv = gl.createBuffer();
      this._tfPupIdx = gl.createBuffer();
      this._tfPupSig = '';
      this._tfPupUvSig = '';
    }
    const sig = `${tf.id}|${p.ver}`;
    if (sig !== this._tfPupSig) {
      this._tfPupSig = sig;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPupPos);
      gl.bufferData(gl.ARRAY_BUFFER, p.pos, gl.DYNAMIC_DRAW);
      // gli indici portano l'ordine di piega/profondità: cambiano col solve
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._tfPupIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.idx, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      this._tfPupN = p.idx.length;
      const uvSig = `${tf.id}|${p.meshVer}`;
      if (uvSig !== this._tfPupUvSig) {
        this._tfPupUvSig = uvSig;
        gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPupUv);
        gl.bufferData(gl.ARRAY_BUFFER, p.uv, gl.STATIC_DRAW);
      }
    }
    gl.useProgram(this.progMesh);
    gl.uniformMatrix3fv(this.wMat, false, camera.matrix());
    gl.uniform1f(this.wAlpha, alpha);
    gl.uniform1i(this.wTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._tfTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPupPos);
    gl.enableVertexAttribArray(this.wPos);
    gl.vertexAttribPointer(this.wPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPupUv);
    gl.enableVertexAttribArray(this.wUv);
    gl.vertexAttribPointer(this.wUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._tfPupIdx);
    gl.drawElements(gl.TRIANGLES, this._tfPupN, gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    // gli attributi della mesh non devono restare abilitati per i chunk
    gl.disableVertexAttribArray(this.wPos);
    gl.disableVertexAttribArray(this.wUv);
  }

  // Quad della sessione Prospettiva: i 4 vertici mondo (il dominio esteso
  // del bordo morbido, vedi warpPads) e l'omografia inversa mondo→UV hull
  // come uniform — ricostruiti SOLO quando angoli o affine cambiano; pan e
  // zoom restano nella matrice camera e a parametri fermi l'anteprima costa
  // un drawArrays. Stessa texture piatta del quad affine.
  /** @param {Camera} camera @param {TransformFrame} tf @param {number} alpha */
  _drawTransformPersp(camera, tf, alpha) {
    const gl = this.gl, p = tf.persp;
    const sig = `${tf.id}|${p.ver}|${tf.m.join(',')}`;
    if (sig !== this._tfPerspSig) {
      const bbox = { x: p.bx, y: p.by, w: p.bw, h: p.bh };
      const M = perspWorldToSrc(p.q, bbox, tf.m, tf.x, tf.y, tf.w, tf.h);
      if (!M) return; // degenere (la UI lo impedisce): meglio nulla che spazzatura
      // colonna per colonna: uniformMatrix3fv non traspone (spec WebGL)
      const H = this._tfPerspMat;
      H[0] = M[0]; H[1] = M[3]; H[2] = M[6];
      H[3] = M[1]; H[4] = M[4]; H[5] = M[7];
      H[6] = M[2]; H[7] = M[5]; H[8] = M[8];
      const pads = warpPads(p.bx, p.by, p.bw, p.bh, tf.x, tf.y, tf.w, tf.h);
      // (u0,v0)..(u1,v1) a griglia 1×1 = i 4 angoli in ordine TRIANGLE_STRIP
      const pos = perspGridWorld(p.q, bbox, tf.m,
        -pads.l / p.bw, 1 + pads.r / p.bw, -pads.t / p.bh, 1 + pads.b / p.bh, 1, 1);
      if (!this._tfPerspBuf) this._tfPerspBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPerspBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      this._tfPerspSig = sig;
    }
    gl.useProgram(this.progPersp);
    gl.uniformMatrix3fv(this.pMat, false, camera.matrix());
    gl.uniformMatrix3fv(this.pH, false, this._tfPerspMat);
    gl.uniform1f(this.pAlpha, alpha);
    gl.uniform1i(this.pTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._tfTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._tfPerspBuf);
    gl.enableVertexAttribArray(this.pPos);
    gl.vertexAttribPointer(this.pPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // l'attributo non deve restare abilitato per i chunk
    gl.disableVertexAttribArray(this.pPos);
  }

  // ---- pannello Effetti: blur dell'anteprima ----

  // Programma di un pass effetto, compilato al primo uso e ATTIVATO
  // (useProgram + quad + uTex). name = kind del FxFrame o pass dedicato
  // ('strokeDist'). Ritorna le location delle uniform del programma.
  /** @param {string} name */
  _bindFxProg(name) {
    const gl = this.gl;
    let prog = this._fxProgs[name];
    if (!prog) {
      /** @type {Record<string, string>} */
      const sources = {
        gauss: FS_BLUR, motion: FS_MOTION, zoom: FS_ZOOM, noise: FS_NOISE,
        grain: FS_GRAIN, thresh: FS_THRESH, halftone: FS_HALFTONE,
        strokeDist: FS_DIST_V, stroke: FS_STROKE,
        tint: FS_TINT, smudge: FS_SMUDGE,
        liqStamp: FS_LIQ_STAMP, liqResolve: FS_LIQ_RESOLVE,
      };
      prog = link(gl, VS_BLIT, sources[name]);
      this._fxProgs[name] = prog;
      /** @type {Record<string, WebGLUniformLocation>} */
      const u = {};
      for (const uname of ['uTex', 'uStep', 'uSigma', 'uR', 'uCenter', 'uK',
        'uAmount', 'uColor', 'uSize', 'uRoughness', 'uSeed', 'uTexSize', 'uThresh',
        'uRadius', 'uSpacing', 'uAngle', 'uOrigin', 'uSrc', 'uW', 'uPos',
        'uBlurT', 'uRectOrigin', 'uRectSize', 'uUvScale', 'uCore', 'uWW',
        'uPressure', 'uBlurK', 'uDragK', 'uOff', 'uOffA', 'uOffB',
        'uDispT', 'uScrOrigin', 'uScrS', 'uChaos', 'uSeedF', 'uDXY', 'uMode']) {
        const loc = gl.getUniformLocation(prog, uname);
        if (loc) u[uname] = loc;
      }
      this._fxUni[name] = u;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const u = this._fxUni[name];
    gl.uniform1i(u.uTex, 0);
    return u;
  }

  // Texture RGBA w×h vuota, CLAMP (l'hull ha >= 3σ di trasparente attorno
  // al contenuto: il clamp al bordo equivale all'estensione a zero).
  // nearest = true per le texture di LAVORO campionate ai centri esatti dei
  // texel (es. il ping delle distanze della traccia): col LINEAR una deriva
  // fp minuscola del vUv fa sanguinare i valori vicini — sul campo delle
  // distanze il tappo "non trovato" (230) inquina i texel adiacenti e
  // l'anello si buca a strisce.
  /** @param {number} w @param {number} h @param {boolean} [nearest] */
  _newFxTex(w, h, nearest = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const f = nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  // Sorgente piatta della sessione: i chunk copiati fianco a fianco, una
  // volta per sessione (id = timbro), come la texture della trasformazione.
  /** @param {FxFrame} fx */
  _ensureFxSrc(fx) {
    if (this._fxId === fx.id && this._fxSrc) return;
    this._freeFxTex();
    const gl = this.gl;
    this._fxSrc = this._newFxTex(fx.w, fx.h);
    gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
    for (const c of fx.store.map.values()) {
      const ox = c.cx * CHUNK - fx.x, oy = c.cy * CHUNK - fx.y;
      if (ox < 0 || oy < 0 || ox + CHUNK > fx.w || oy + CHUNK > fx.h) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length));
    }
    this._fxOut = this._newFxTex(fx.w, fx.h);
    this._fxFbo = gl.createFramebuffer();
    this._fxId = fx.id;
    this._fxKey = '';
  }

  // Cuoce l'effetto nella texture out, rieseguito solo quando i parametri
  // cambiano. gauss = due pass separabili (orizzontale -> ping, verticale ->
  // out); motion/zoom = un pass diretto src -> out. Blend e scissor OFF: i
  // pass sono copie pure in spazio texture; lo stato che tocca (program,
  // attrib, viewport, FBO) è ripristinato dal flusso di render() subito dopo.
  /** @param {FxFrame} fx */
  _ensureFxBlur(fx) {
    this._ensureFxSrc(fx);
    const key = `${fx.kind}|${fx.sigma}|${fx.radius}|${fx.spacing}|${fx.angle}|${fx.dist}|${fx.k}|${fx.cx}|${fx.cy}|` +
      `${fx.amount}|${fx.colorMix}|${fx.grainSize}|${fx.roughness}|${fx.seed}|${fx.thresh}|` +
      `${fx.strokeW}|${fx.strokePos}|${fx.strokeR}|${fx.strokeG}|${fx.strokeB}|` +
      `${fx.bevel ? JSON.stringify(fx.bevel) : ''}`;
    if (this._fxKey === key) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.viewport(0, 0, fx.w, fx.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    // la sorgente: NEAREST per i pass che campionano ai centri esatti dei
    // texel (tutti tranne motion/zoom, che leggono a offset frazionari e
    // vogliono il bilineare)
    const srcNear = fx.kind !== 'motion' && fx.kind !== 'zoom';
    gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, srcNear ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, srcNear ? gl.NEAREST : gl.LINEAR);
    if (fx.kind === 'gauss') {
      if (!this._fxPing) this._fxPing = this._newFxTex(fx.w, fx.h, true);
      const u = this._bindFxProg('gauss');
      gl.uniform1f(u.uSigma, fx.sigma);
      gl.uniform1i(u.uR, Math.min(FX_MAX_R, Math.max(1, Math.ceil(3 * fx.sigma))));
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxPing, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
      gl.uniform2f(u.uStep, 1 / fx.w, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._fxPing);
      gl.uniform2f(u.uStep, 0, 1 / fx.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (fx.kind === 'stroke') {
      // traccia: pass 1 distanze verticali in ping, pass 2 EDT + anello
      // (legge ping su TEXTURE0 e il contenuto su TEXTURE1)
      if (!this._fxPing) this._fxPing = this._newFxTex(fx.w, fx.h, true);
      const taps = Math.min(FX_MAX_R, Math.max(1, Math.ceil(fx.strokeW) + 1));
      let u = this._bindFxProg('strokeDist');
      gl.uniform1i(u.uR, taps);
      gl.uniform2f(u.uStep, 0, 1 / fx.h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxPing, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      u = this._bindFxProg('stroke');
      gl.uniform1i(u.uR, taps);
      gl.uniform2f(u.uStep, 1 / fx.w, 0);
      gl.uniform1f(u.uW, fx.strokeW);
      gl.uniform1i(u.uPos, fx.strokePos);
      gl.uniform3f(u.uColor, fx.strokeR, fx.strokeG, fx.strokeB);
      gl.uniform1i(u.uSrc, 1);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._fxPing);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else if (fx.kind === 'bevelEmboss') {
      this._ensureFxBevel(fx);
    } else {
      const u = this._bindFxProg(fx.kind);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
      if (fx.kind === 'motion') {
        // tap a passo ~1 px lungo la direzione, corsa ±dist/2
        const half = fx.dist / 2;
        const taps = Math.min(FX_MAX_R, Math.max(1, Math.ceil(half)));
        const spacing = half / taps;
        gl.uniform1i(u.uR, taps);
        gl.uniform2f(u.uStep,
          Math.cos(fx.angle) * spacing / fx.w,
          Math.sin(fx.angle) * spacing / fx.h);
      } else if (fx.kind === 'zoom') {
        // tap proporzionali all'intensità: il jitter copre il resto
        gl.uniform1f(u.uK, fx.k);
        gl.uniform1i(u.uR, Math.min(FX_MAX_R, Math.max(16, Math.round(fx.k * 400))));
        gl.uniform2f(u.uCenter, (fx.cx - fx.x) / fx.w, (fx.cy - fx.y) / fx.h);
      } else if (fx.kind === 'thresh') {
        gl.uniform1f(u.uThresh, fx.thresh);
      } else if (fx.kind === 'halftone') {
        gl.uniform1f(u.uRadius, fx.radius);
        gl.uniform1f(u.uSpacing, fx.spacing || fx.radius * 2);
        gl.uniform1f(u.uAngle, fx.angle);
        gl.uniform1f(u.uColor, fx.colorMix);
        gl.uniform2f(u.uTexSize, fx.w, fx.h);
        gl.uniform2f(u.uOrigin, fx.x - fx.clip.x0, fx.y - fx.clip.y0);
      } else if (fx.kind === 'tint') {
        gl.uniform3f(u.uColor, fx.strokeR, fx.strokeG, fx.strokeB);
      } else {
        // noise/grain: operazioni puntuali, pattern deterministico dal seed
        gl.uniform1f(u.uAmount, fx.amount);
        gl.uniform1f(u.uSeed, fx.seed);
        gl.uniform2f(u.uTexSize, fx.w, fx.h);
        gl.uniform1f(u.uSize, fx.grainSize);
        gl.uniform1f(u.uRoughness, fx.roughness);
        if (fx.kind === 'noise') gl.uniform1f(u.uColor, fx.colorMix);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._fxKey = key;
  }

  // Risultato del blur per il commit: l'ESATTO contenuto dell'anteprima
  // (stesso shader, stessa texture). Pixel premultiplied, riga 0 = mondo in
  // alto. Il min(r,g,b, a) ripara l'arrotondamento indipendente dei canali
  // negli 8 bit dell'FBO (r potrebbe superare a di 1). null senza contesto:
  // il chiamante passa al fallback CPU.
  /** @param {FxFrame} fx @returns {import('./fx_blur.js').FxResult|null} */
  fxReadback(fx) {
    if (this.contextLost || !this.ok) return null;
    this._ensureFxBlur(fx);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
    const out = new Uint8ClampedArray(fx.w * fx.h * 4);
    gl.readPixels(0, 0, fx.w, fx.h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (out[i] > a) out[i] = a;
      if (out[i + 1] > a) out[i + 1] = a;
      if (out[i + 2] > a) out[i + 2] = a;
    }
    return { x: fx.x, y: fx.y, w: fx.w, h: fx.h, data: out };
  }

  // ---- sfumino GPU: copy+stamp su una texture di stato ----

  /**
   * Avvia la sessione sfumino GPU: lo stato del livello vive in UNA texture
   * (riga 0 = mondo in alto, come le sessioni fx), i dab sono draw call
   * (smudgeDab), il live e' il quad nello slot fx di _drawLayer (kind
   * 'smudge'), il commit e' smudgeReadback del rettangolo toccato. null =
   * niente GPU (contesto perso o board oltre MAX_TEXTURE_SIZE): il
   * chiamante resta sul motore CPU wasm/JS.
   * @param {number} layerId @param {ChunkStore} store
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {{radius:number, hardness:number, sigma:number, drag:number, blurOpacity:number, useBlur:boolean}} p
   * @returns {FxFrame|null}
   */
  smudgeBegin(layerId, store, clip, p) {
    if (!this.ok || this.contextLost) return null;
    const gl = this.gl;
    const w = clip.x1 - clip.x0 + 1;
    const h = clip.y1 - clip.y0 + 1;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (w > maxTex || h > maxTex) return null;
    this.smudgeEnd();
    // stato = chunk affiancati (stessa costruzione della sorgente fx)
    this._smState = this._newFxTex(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this._smState);
    for (const c of store.map.values()) {
      const ox = c.cx * CHUNK - clip.x0, oy = c.cy * CHUNK - clip.y0;
      if (ox < 0 || oy < 0 || ox + CHUNK > w || oy + CHUNK > h) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length));
    }
    // scratch della copia pre-dab, dimensionato sul dab massimo; il pull
    // oltre mezzo raggio si clampa (solo catch-up estremo, non si vede)
    const maxOff = Math.max(2, p.radius * 0.5);
    const pad = Math.ceil(Math.max(p.sigma * 3 + 2, maxOff + p.radius * 0.07 + 2));
    const S = Math.min(Math.max(w, h), Math.ceil(p.radius) * 2 + pad * 2 + 2);
    this._smScratch = this._newFxTex(S, S);
    if (p.useBlur) {
      this._smBlur = this._newFxTex(S, S);
      this._smPing = this._newFxTex(S, S);
    }
    this._smFbo = gl.createFramebuffer();
    this._smW = w; this._smH = h;
    this._smX = clip.x0; this._smY = clip.y0;
    this._smS = S;
    this._smPad = pad;
    this._smMaxOff = maxOff;
    this._smP = p;
    return {
      id: -1, kind: 'smudge', layerId, store,
      x: clip.x0, y: clip.y0, w, h, clip,
      sigma: 0, radius: 0, spacing: 0, angle: 0, dist: 0, k: 0, cx: 0, cy: 0,
      amount: 0, colorMix: 0, grainSize: 0, roughness: 0, seed: 0, thresh: 0,
      strokeW: 0, strokePos: 0, strokeR: 0, strokeG: 0, strokeB: 0,
    };
  }

  /**
   * Un dab: azzera lo scratch (i margini oltre il rect clampato = mondo
   * trasparente, come nel motore CPU), copia il rect pre-dab dallo stato,
   * blur separabile opzionale, stamp sul rect. Lo stato GL che tocca viene
   * ripristinato in fondo: i dab girano FUORI da render().
   * @param {number} cx @param {number} cy centro del dab (mondo)
   * @param {number} pressure
   * @param {number} dirX @param {number} dirY @param {number} dragOffset
   * @param {number} dragK drag se il dab trascina, 0 altrimenti
   * @param {number} blurK blurOpacity*(1-drag) se sfoca, 0 altrimenti
   */
  smudgeDab(cx, cy, pressure, dirX, dirY, dragOffset, dragK, blurK) {
    if (!this._smState || this.contextLost) return;
    const gl = this.gl;
    const p = /** @type {NonNullable<typeof this._smP>} */ (this._smP);
    if (dragOffset > this._smMaxOff) dragOffset = this._smMaxOff;
    const S = this._smS;
    const r = p.radius;
    const pad = this._smPad;
    const sx = cx - this._smX, sy = cy - this._smY; // coordinate stato
    let rx0 = Math.floor(sx - r) - pad;
    let ry0 = Math.floor(sy - r) - pad;
    let rx1 = Math.ceil(sx + r) + pad;
    let ry1 = Math.ceil(sy + r) + pad;
    if (rx0 < 0) rx0 = 0;
    if (ry0 < 0) ry0 = 0;
    if (rx1 > this._smW - 1) rx1 = this._smW - 1;
    if (ry1 > this._smH - 1) ry1 = this._smH - 1;
    const rw = Math.min(rx1 - rx0 + 1, S), rh = Math.min(ry1 - ry0 + 1, S);
    if (rw <= 0 || rh <= 0) return;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smScratch, 0);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smState, 0);
    gl.bindTexture(gl.TEXTURE_2D, this._smScratch);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, rx0, ry0, rw, rh);
    if (blurK > 0 && this._smBlur && this._smPing) {
      const u = this._bindFxProg('gauss');
      gl.uniform1f(u.uSigma, p.sigma);
      gl.uniform1i(u.uR, Math.min(FX_MAX_R, Math.max(1, Math.ceil(3 * p.sigma))));
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smPing, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._smScratch);
      gl.uniform2f(u.uStep, 1 / S, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smBlur, 0);
      gl.bindTexture(gl.TEXTURE_2D, this._smPing);
      gl.uniform2f(u.uStep, 0, 1 / S);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const u = this._bindFxProg('smudge');
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smState, 0);
    gl.viewport(rx0, ry0, rw, rh);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurK > 0 && this._smBlur ? this._smBlur : this._smScratch);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._smScratch);
    gl.uniform1i(u.uBlurT, 1);
    gl.uniform2f(u.uRectOrigin, rx0, ry0);
    gl.uniform2f(u.uRectSize, rw, rh);
    gl.uniform2f(u.uUvScale, rw / S, rh / S);
    gl.uniform2f(u.uCenter, sx, sy);
    const core = r * p.hardness;
    gl.uniform1f(u.uCore, core);
    gl.uniform1f(u.uWW, Math.max(1, r - core));
    gl.uniform1f(u.uPressure, pressure);
    gl.uniform1f(u.uBlurK, blurK);
    gl.uniform1f(u.uDragK, dragK);
    const offX = -dirX * dragOffset, offY = -dirY * dragOffset;
    const cs = Math.max(0.5, r * 0.07);
    const crX = -dirY * cs, crY = dirX * cs;
    gl.uniform2f(u.uOff, offX / S, offY / S);
    gl.uniform2f(u.uOffA, (offX + crX) / S, (offY + crY) / S);
    gl.uniform2f(u.uOffB, (offX - crX) / S, (offY - crY) / S);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // ripristino per il flusso di render
    gl.disableVertexAttribArray(gl.getAttribLocation(this._fxProgs.smudge, 'aPos'));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Pixel correnti dello stato nel rettangolo mondo dato, premultiplied
   * riparato come fxReadback. null a contesto perso (il tratto si perde:
   * i chunk CPU restano allo stato pre-tratto, coerente col restore).
   * @param {{x0:number, y0:number, x1:number, y1:number}} rect mondo
   * @returns {{x:number, y:number, w:number, h:number, data:Uint8ClampedArray}|null}
   */
  smudgeReadback(rect) {
    if (!this._smState || this.contextLost) return null;
    const gl = this.gl;
    const x0 = Math.max(rect.x0 - this._smX, 0), y0 = Math.max(rect.y0 - this._smY, 0);
    const x1 = Math.min(rect.x1 - this._smX, this._smW - 1);
    const y1 = Math.min(rect.y1 - this._smY, this._smH - 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._smFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._smState, 0);
    const out = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (out[i] > a) out[i] = a;
      if (out[i + 1] > a) out[i + 1] = a;
      if (out[i + 2] > a) out[i + 2] = a;
    }
    return { x: this._smX + x0, y: this._smY + y0, w, h, data: out };
  }

  smudgeEnd() {
    const gl = this.gl;
    if (this._smState) { gl.deleteTexture(this._smState); this._smState = null; }
    if (this._smScratch) { gl.deleteTexture(this._smScratch); this._smScratch = null; }
    if (this._smBlur) { gl.deleteTexture(this._smBlur); this._smBlur = null; }
    if (this._smPing) { gl.deleteTexture(this._smPing); this._smPing = null; }
    if (this._smFbo) { gl.deleteFramebuffer(this._smFbo); this._smFbo = null; }
    this._smP = null;
  }

  // ---- liquify GPU: campo di spostamento accumulato ----

  /**
   * Avvia la sessione liquify GPU: base del livello in una texture RGBA8,
   * campo di spostamento RGBA16F (RG = offset sorgente in px, zero-init
   * garantito da WebGL), resolved RGBA8 presentato nello slot fx (kind
   * 'liquify'). Serve WebGL2 + EXT_color_buffer_float: senza, null e il
   * chiamante resta sul motore CPU.
   * @param {number} layerId @param {ChunkStore} store
   * @param {{x0:number,y0:number,x1:number,y1:number}} clip
   * @param {{radius:number, chaos:number, seed:number}} p
   * @returns {FxFrame|null}
   */
  liquifyBegin(layerId, store, clip, p) {
    if (!this.ok || this.contextLost || !this.isGL2) return null;
    const gl = /** @type {WebGL2RenderingContext} */ (this.gl);
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    const w = clip.x1 - clip.x0 + 1;
    const h = clip.y1 - clip.y0 + 1;
    if (w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || h > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
    this.liquifyEnd();
    this._lqBase = this._newFxTex(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this._lqBase);
    for (const c of store.map.values()) {
      const ox = c.cx * CHUNK - clip.x0, oy = c.cy * CHUNK - clip.y0;
      if (ox < 0 || oy < 0 || ox + CHUNK > w || oy + CHUNK > h) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length));
    }
    /** @param {number} tw @param {number} th */
    const newF = (tw, th) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, tw, th, 0, gl.RGBA, gl.HALF_FLOAT, null);
      return tex;
    };
    this._lqDisp = newF(w, h);
    // scratch della copia pre-dab del campo: il vecchio campo si campiona a
    // pos+w, quindi il pad copre lo spostamento massimo (~1.5r, tappato)
    const pad = Math.min(Math.ceil(p.radius * 1.5) + 4, 768);
    const S = Math.min(Math.max(w, h), Math.ceil(p.radius) * 2 + pad * 2 + 2);
    this._lqScratch = newF(S, S);
    this._lqResolved = this._newFxTex(w, h);
    this._lqFbo = gl.createFramebuffer();
    // resolved parte come copia della base (campo nullo = identita')
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._lqFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqBase, 0);
    gl.bindTexture(gl.TEXTURE_2D, this._lqResolved);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._lqW = w; this._lqH = h;
    this._lqX = clip.x0; this._lqY = clip.y0;
    this._lqS = S;
    this._lqPad = pad;
    this._lqP = p;
    return {
      id: -1, kind: 'liquify', layerId, store,
      x: clip.x0, y: clip.y0, w, h, clip,
      sigma: 0, radius: 0, spacing: 0, angle: 0, dist: 0, k: 0, cx: 0, cy: 0,
      amount: 0, colorMix: 0, grainSize: 0, roughness: 0, seed: 0, thresh: 0,
      strokeW: 0, strokePos: 0, strokeR: 0, strokeG: 0, strokeB: 0,
    };
  }

  /**
   * Un dab: copia del campo (rect+pad) nello scratch, stamp del modo sul
   * campo (composizione D_new(p) = w(p) + D_old(p+w(p))), resolve del rect
   * dalla base attraverso il campo totale. Stato GL ripristinato in coda.
   * @param {number} mode 0=push 1=twirlR 2=twirlL 3=pinch 4=expand 5=crystals 6=edge
   * @param {number} cx @param {number} cy centro (mondo)
   * @param {number} dx @param {number} dy spinta del dab (px, gia' clampata)
   * @param {number} strength pressione x forza (0..1)
   */
  liquifyDab(mode, cx, cy, dx, dy, strength) {
    if (!this._lqDisp || this.contextLost) return;
    const gl = this.gl;
    const p = /** @type {NonNullable<typeof this._lqP>} */ (this._lqP);
    const r = p.radius;
    const pad = this._lqPad;
    const S = this._lqS;
    const sx = cx - this._lqX, sy = cy - this._lqY;
    let rx0 = Math.max(Math.floor(sx - r), 0);
    let ry0 = Math.max(Math.floor(sy - r), 0);
    let rx1 = Math.min(Math.ceil(sx + r), this._lqW - 1);
    let ry1 = Math.min(Math.ceil(sy + r), this._lqH - 1);
    const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
    if (rw <= 0 || rh <= 0) return;
    // scratch: copia del campo attorno al rect (clamp ai bordi dello stato)
    const scx0 = Math.max(rx0 - pad, 0), scy0 = Math.max(ry0 - pad, 0);
    const scw = Math.min(Math.min(rx1 + pad, this._lqW - 1) - scx0 + 1, S);
    const sch = Math.min(Math.min(ry1 + pad, this._lqH - 1) - scy0 + 1, S);

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._lqFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqScratch, 0);
    gl.viewport(0, 0, S, S);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqDisp, 0);
    gl.bindTexture(gl.TEXTURE_2D, this._lqScratch);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, scx0, scy0, scw, sch);
    // stamp sul campo
    let u = this._bindFxProg('liqStamp');
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqDisp, 0);
    gl.viewport(rx0, ry0, rw, rh);
    gl.bindTexture(gl.TEXTURE_2D, this._lqScratch);
    gl.uniform2f(u.uRectOrigin, rx0, ry0);
    gl.uniform2f(u.uRectSize, rw, rh);
    gl.uniform2f(u.uScrOrigin, scx0, scy0);
    gl.uniform1f(u.uScrS, S);
    gl.uniform2f(u.uCenter, sx, sy);
    const core = r * 0.18; // stessa durezza del falloff CPU (_maskAt)
    gl.uniform1f(u.uCore, core);
    gl.uniform1f(u.uWW, Math.max(1, r - core));
    gl.uniform1f(u.uPressure, strength);
    gl.uniform1f(u.uRadius, r);
    gl.uniform1f(u.uChaos, p.chaos);
    gl.uniform1f(u.uSeedF, p.seed);
    gl.uniform2f(u.uDXY, dx, dy);
    gl.uniform1i(u.uMode, mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // resolve del rect: base -> resolved attraverso il campo
    u = this._bindFxProg('liqResolve');
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqResolved, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._lqDisp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._lqBase);
    gl.uniform1i(u.uDispT, 1);
    gl.uniform2f(u.uTexSize, this._lqW, this._lqH);
    gl.uniform2f(u.uRectOrigin, rx0, ry0);
    gl.uniform2f(u.uRectSize, rw, rh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // ripristino per il flusso di render (i dab girano FUORI da render())
    gl.disableVertexAttribArray(gl.getAttribLocation(this._fxProgs.liqResolve, 'aPos'));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Pixel correnti del resolved nel rettangolo mondo dato (premultiplied
   * riparato come fxReadback). null a contesto perso.
   * @param {{x0:number, y0:number, x1:number, y1:number}} rect mondo
   * @returns {{x:number, y:number, w:number, h:number, data:Uint8ClampedArray}|null}
   */
  liquifyReadback(rect) {
    if (!this._lqResolved || this.contextLost) return null;
    const gl = this.gl;
    const x0 = Math.max(rect.x0 - this._lqX, 0), y0 = Math.max(rect.y0 - this._lqY, 0);
    const x1 = Math.min(rect.x1 - this._lqX, this._lqW - 1);
    const y1 = Math.min(rect.y1 - this._lqY, this._lqH - 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._lqFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._lqResolved, 0);
    const out = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (out[i] > a) out[i] = a;
      if (out[i + 1] > a) out[i + 1] = a;
      if (out[i + 2] > a) out[i + 2] = a;
    }
    return { x: this._lqX + x0, y: this._lqY + y0, w, h, data: out };
  }

  liquifyEnd() {
    const gl = this.gl;
    if (this._lqBase) { gl.deleteTexture(this._lqBase); this._lqBase = null; }
    if (this._lqDisp) { gl.deleteTexture(this._lqDisp); this._lqDisp = null; }
    if (this._lqScratch) { gl.deleteTexture(this._lqScratch); this._lqScratch = null; }
    if (this._lqResolved) { gl.deleteTexture(this._lqResolved); this._lqResolved = null; }
    if (this._lqFbo) { gl.deleteFramebuffer(this._lqFbo); this._lqFbo = null; }
    this._lqP = null;
  }

  /** @param {string} name */
  _bindStyleProg(name) {
    const gl = this.gl;
    let prog = this._styleProgs[name];
    if (!prog) {
      /** @type {Record<string, string>} */
      const sources = {
        jfaInit: FS_JFA_INIT,
        jfaStep: FS_JFA_STEP,
        jfaAlpha: FS_JFA_TO_ALPHA,
        bevelNormal: FS_BEVEL_NORMAL,
        bevelLighting: FS_BEVEL_LIGHTING,
        bevelComposite: FS_BEVEL_COMPOSITE,
      };
      prog = this._styleProgs[name] = link(gl, VS_BLIT, sources[name]);
      /** @type {Record<string, WebGLUniformLocation>} */
      const u = {};
      for (const n of ['uTex', 'uOrigAlpha', 'uTexelSize', 'uStep', 'uMaxDist',
        'uDepth', 'uStyle', 'uDirection', 'uTechnique', 'uContour', 'uNormalMap',
        'uAngle', 'uAltitude', 'uHighlightOpacity', 'uShadowOpacity',
        'uOriginal', 'uLighting', 'uHighlightColor', 'uShadowColor',
        'uHighlightBlend', 'uShadowBlend']) {
        const loc = gl.getUniformLocation(prog, n);
        if (loc) u[n] = loc;
      }
      this._styleUni[name] = u;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    return this._styleUni[name];
  }

  /** @param {any} cache */
  _freeStyleCache(cache) {
    if (!cache || this.contextLost) return;
    const gl = this.gl;
    const seen = new Set();
    for (const k of ['src', 'tmpA', 'tmpB', 'alpha', 'normal', 'light', 'out']) {
      const tex = cache[k];
      if (tex && !seen.has(tex)) {
        seen.add(tex);
        gl.deleteTexture(tex);
      }
    }
    if (cache.fbo) gl.deleteFramebuffer(cache.fbo);
  }

  /** @param {WebGLTexture} tex @param {number} w @param {number} h @param {string} name @param {(u: Record<string, WebGLUniformLocation>) => void} uniforms */
  _styleDraw(tex, w, h, name, uniforms) {
    const gl = this.gl;
    const u = this._bindStyleProg(name);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (u.uTex) gl.uniform1i(u.uTex, 0);
    uniforms(u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** @param {any} cache @param {WebGLTexture} input @param {number} w @param {number} h @param {number} sigma */
  _styleBlur(cache, input, w, h, sigma) {
    const gl = this.gl;
    if (sigma <= 0) return input;
    const u = this._bindFxProg('gauss');
    const r = Math.min(FX_MAX_R, Math.max(1, Math.ceil(3 * sigma)));
    gl.viewport(0, 0, w, h);
    gl.uniform1f(u.uSigma, sigma);
    gl.uniform1i(u.uR, r);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.tmpA, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform2f(u.uStep, 1 / w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.tmpB, 0);
    gl.bindTexture(gl.TEXTURE_2D, cache.tmpA);
    gl.uniform2f(u.uStep, 0, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return cache.tmpB;
  }

  /** @param {any} cache */
  _freeFxBevelCache(cache) {
    if (!cache || this.contextLost) return;
    const gl = this.gl;
    for (const k of ['tmpA', 'tmpB', 'alpha', 'normal', 'light']) {
      if (cache[k]) gl.deleteTexture(cache[k]);
    }
  }

  /** @param {WebGLTexture} tex @param {number} w @param {number} h */
  _copyFxTexture(tex, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progBlit);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(this.progBlit, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(this.bTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** @param {FxFrame} fx */
  _ensureFxBevel(fx) {
    const cfg = fx.bevel;
    if (!cfg || cfg.size <= 0) {
      this._copyFxTexture(this._fxSrc, fx.w, fx.h);
      return;
    }
    let cache = this._fxBevel;
    if (cache && (cache.w !== fx.w || cache.h !== fx.h)) {
      this._freeFxBevelCache(cache);
      cache = null;
    }
    const gl = this.gl;
    if (!cache) {
      cache = {
        w: fx.w, h: fx.h,
        tmpA: this._newFxTex(fx.w, fx.h, true),
        tmpB: this._newFxTex(fx.w, fx.h, true),
        alpha: this._newFxTex(fx.w, fx.h, true),
        normal: this._newFxTex(fx.w, fx.h, true),
        light: this._newFxTex(fx.w, fx.h, true),
      };
      this._fxBevel = cache;
    }
    cache.fbo = this._fxFbo;
    const w = fx.w, h = fx.h;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.tmpA, 0);
    this._styleDraw(this._fxSrc, w, h, 'jfaInit', (u) => {
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
    });

    let read = cache.tmpA, write = cache.tmpB;
    const passes = Math.max(1, Math.ceil(Math.log2(Math.max(w, h))));
    for (let i = passes - 1; i >= 0; i--) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, write, 0);
      this._styleDraw(read, w, h, 'jfaStep', (u) => {
        gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
        gl.uniform1f(u.uStep, Math.pow(2, i));
      });
      const t = read; read = write; write = t;
    }

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.alpha, 0);
    this._styleDraw(read, w, h, 'jfaAlpha', (u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
      gl.uniform1i(u.uOrigAlpha, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
      gl.uniform1f(u.uMaxDist, Math.max(1, cfg.size));
    });

    let alphaTex = cache.alpha;
    const baseBlur = cfg.technique === 'chisel-soft'
      ? Math.max(0.75, Math.min(3, cfg.size / 12))
      : 0.55;
    alphaTex = this._styleBlur(cache, alphaTex, w, h, baseBlur);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.normal, 0);
    this._styleDraw(alphaTex, w, h, 'bevelNormal', (u) => {
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
      gl.uniform1f(u.uDepth, cfg.depth / 100);
      gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
      gl.uniform1f(u.uDirection, cfg.direction === 'down' ? -1 : 1);
      gl.uniform1i(u.uTechnique, BEVEL_TECHNIQUE_INDEX[cfg.technique] ?? 0);
      gl.uniform1i(u.uContour, CONTOUR_INDEX[cfg.glossContour] ?? 0);
    });

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.light, 0);
    this._styleDraw(cache.normal, w, h, 'bevelLighting', (u) => {
      if (u.uNormalMap) gl.uniform1i(u.uNormalMap, 0);
      gl.uniform1f(u.uAngle, cfg.angle * Math.PI / 180);
      gl.uniform1f(u.uAltitude, cfg.altitude * Math.PI / 180);
      gl.uniform1f(u.uHighlightOpacity, cfg.highlightOpacity / 100);
      gl.uniform1f(u.uShadowOpacity, cfg.shadowOpacity / 100);
      gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
      gl.uniform1i(u.uContour, CONTOUR_INDEX[cfg.glossContour] ?? 0);
    });

    let lightTex = cache.light;
    if (cfg.soften > 0) lightTex = this._styleBlur(cache, lightTex, w, h, Math.max(0.5, cfg.soften / 2));

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fxFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._fxOut, 0);
    this._bindStyleProg('bevelComposite');
    const u = this._styleUni.bevelComposite;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._fxSrc);
    gl.uniform1i(u.uOriginal, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lightTex);
    gl.uniform1i(u.uLighting, 1);
    const hl = hexRgb01(cfg.highlightColor), sh = hexRgb01(cfg.shadowColor);
    gl.uniform3f(u.uHighlightColor, hl[0], hl[1], hl[2]);
    gl.uniform3f(u.uShadowColor, sh[0], sh[1], sh[2]);
    gl.uniform1i(u.uHighlightBlend, STYLE_BLEND_INDEX[cfg.highlightMode] ?? 2);
    gl.uniform1i(u.uShadowBlend, STYLE_BLEND_INDEX[cfg.shadowMode] ?? 1);
    gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** @param {Layer} layer */
  _styledLayerTexture(layer) {
    const cfg = activeBevel(layer);
    if (!cfg || !layer.store || layer.store.map.size === 0) return null;
    const rect = bevelRect(layer, layer.clipBoard);
    if (!rect) return null;
    const key = `${layer.id}|${layer.store.ver}|${layerStyleKey(layer)}|${rect.x}|${rect.y}|${rect.w}|${rect.h}|${this.ctxGen}`;
    let cache = this._styleCache.get(layer.id);
    if (cache && cache.key === key && cache.out) return cache;
    if (cache && (cache.w !== rect.w || cache.h !== rect.h)) {
      this._freeStyleCache(cache);
      cache = null;
    }
    const gl = this.gl;
    if (!cache) {
      cache = {
        key: '',
        x: rect.x, y: rect.y, w: rect.w, h: rect.h, clip: rect.clip,
        src: this._newFxTex(rect.w, rect.h, true),
        tmpA: this._newFxTex(rect.w, rect.h, true),
        tmpB: this._newFxTex(rect.w, rect.h, true),
        alpha: this._newFxTex(rect.w, rect.h, true),
        normal: this._newFxTex(rect.w, rect.h, true),
        light: this._newFxTex(rect.w, rect.h, true),
        out: this._newFxTex(rect.w, rect.h),
        fbo: gl.createFramebuffer(),
      };
      this._styleCache.set(layer.id, cache);
    }
    cache.key = key;
    cache.x = rect.x; cache.y = rect.y; cache.w = rect.w; cache.h = rect.h; cache.clip = rect.clip;
    const w = rect.w, h = rect.h;

    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindTexture(gl.TEXTURE_2D, cache.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const c of layer.store.map.values()) {
      const ox = c.cx * CHUNK - rect.x, oy = c.cy * CHUNK - rect.y;
      if (ox < 0 || oy < 0 || ox + CHUNK > w || oy + CHUNK > h) continue;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ox, oy, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length));
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.tmpA, 0);
    this._styleDraw(cache.src, w, h, 'jfaInit', (u) => {
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
    });

    let read = cache.tmpA, write = cache.tmpB;
    const passes = Math.max(1, Math.ceil(Math.log2(Math.max(w, h))));
    for (let i = passes - 1; i >= 0; i--) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, write, 0);
      this._styleDraw(read, w, h, 'jfaStep', (u) => {
        gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
        gl.uniform1f(u.uStep, Math.pow(2, i));
      });
      const t = read; read = write; write = t;
    }

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.alpha, 0);
    this._styleDraw(read, w, h, 'jfaAlpha', (u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, cache.src);
      gl.uniform1i(u.uOrigAlpha, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
      gl.uniform1f(u.uMaxDist, Math.max(1, cfg.size));
    });

    let alphaTex = cache.alpha;
    const baseBlur = cfg.technique === 'chisel-soft'
      ? Math.max(0.75, Math.min(3, cfg.size / 12))
      : 0.55;
    alphaTex = this._styleBlur(cache, alphaTex, w, h, baseBlur);

    gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.normal, 0);
    this._styleDraw(alphaTex, w, h, 'bevelNormal', (u) => {
      gl.uniform2f(u.uTexelSize, 1 / w, 1 / h);
      gl.uniform1f(u.uDepth, cfg.depth / 100);
      gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
      gl.uniform1f(u.uDirection, cfg.direction === 'down' ? -1 : 1);
      gl.uniform1i(u.uTechnique, BEVEL_TECHNIQUE_INDEX[cfg.technique] ?? 0);
      gl.uniform1i(u.uContour, CONTOUR_INDEX[cfg.glossContour] ?? 0);
    });

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.light, 0);
    this._styleDraw(cache.normal, w, h, 'bevelLighting', (u) => {
      if (u.uNormalMap) gl.uniform1i(u.uNormalMap, 0);
      gl.uniform1f(u.uAngle, cfg.angle * Math.PI / 180);
      gl.uniform1f(u.uAltitude, cfg.altitude * Math.PI / 180);
      gl.uniform1f(u.uHighlightOpacity, cfg.highlightOpacity / 100);
      gl.uniform1f(u.uShadowOpacity, cfg.shadowOpacity / 100);
      gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
      gl.uniform1i(u.uContour, CONTOUR_INDEX[cfg.glossContour] ?? 0);
    });

    let lightTex = cache.light;
    if (cfg.soften > 0) lightTex = this._styleBlur(cache, lightTex, w, h, Math.max(0.5, cfg.soften / 2));

    gl.bindFramebuffer(gl.FRAMEBUFFER, cache.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cache.out, 0);
    this._bindStyleProg('bevelComposite');
    const u = this._styleUni.bevelComposite;
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cache.src);
    gl.uniform1i(u.uOriginal, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lightTex);
    gl.uniform1i(u.uLighting, 1);
    const hl = hexRgb01(cfg.highlightColor), sh = hexRgb01(cfg.shadowColor);
    gl.uniform3f(u.uHighlightColor, hl[0], hl[1], hl[2]);
    gl.uniform3f(u.uShadowColor, sh[0], sh[1], sh[2]);
    gl.uniform1i(u.uHighlightBlend, STYLE_BLEND_INDEX[cfg.highlightMode] ?? 2);
    gl.uniform1i(u.uShadowBlend, STYLE_BLEND_INDEX[cfg.shadowMode] ?? 1);
    gl.uniform1i(u.uStyle, BEVEL_STYLE_INDEX[cfg.style] ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return cache;
  }

  _freeFxTex() {
    const gl = this.gl;
    if (!this.contextLost) {
      if (this._fxSrc) gl.deleteTexture(this._fxSrc);
      if (this._fxPing) gl.deleteTexture(this._fxPing);
      if (this._fxOut) gl.deleteTexture(this._fxOut);
      this._freeFxBevelCache(this._fxBevel);
      if (this._fxFbo) gl.deleteFramebuffer(this._fxFbo);
    }
    this._fxSrc = this._fxPing = this._fxOut = null;
    this._fxBevel = null;
    this._fxFbo = null;
    this._fxId = 0;
    this._fxKey = '';
  }

  // Scissor sul rettangolo mondo [clip.x0..x1]×[clip.y0..y1] (inclusivo):
  // l'origine GL è in basso a sinistra, quindi la y va ribaltata.
  /** @param {Camera} camera @param {TransformFrame['clip']} clip */
  _scissorClip(camera, clip) {
    const gl = this.gl, d = camera.dpr, z = camera.zoom;
    const x0 = ((clip.x0 - camera.x) * z + camera.w * 0.5) * d;
    const y0 = ((clip.y0 - camera.y) * z + camera.h * 0.5) * d;
    const x1 = ((clip.x1 + 1 - camera.x) * z + camera.w * 0.5) * d;
    const y1 = ((clip.y1 + 1 - camera.y) * z + camera.h * 0.5) * d;
    const left = Math.max(0, Math.round(x0));
    const right = Math.min(this.canvas.width, Math.round(x1));
    const top = Math.max(0, Math.round(y0));
    const bottom = Math.min(this.canvas.height, Math.round(y1));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(left, this.canvas.height - bottom,
      Math.max(0, right - left), Math.max(0, bottom - top));
  }

  // Gomma live sul livello attivo: chunk * (1 - maschera stroke) * opacità.
  /**
   * @param {Camera} camera @param {Layer} layer @param {ChunkStore} strokeStore
   * @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawErase(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    gl.useProgram(this.progErase);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPosE = gl.getAttribLocation(this.progErase, 'aPos');
    gl.enableVertexAttribArray(aPosE);
    gl.vertexAttribPointer(aPosE, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.eMat, false, camera.matrix());
    gl.uniform2f(this.eSize, CHUNK, CHUNK);
    gl.uniform1f(this.eAlpha, strokeOpacity);
    gl.uniform1f(this.eLayerA, layer.opacity);
    gl.uniform1i(this.eTex, 0);
    gl.uniform1i(this.eMask, 1);
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      gl.activeTexture(gl.TEXTURE0);
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      const sc = strokeStore.getByKey(chunk.key);
      if (sc && (!sc.tex || sc.texDirty)) this._uploadNow(sc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sc && sc.tex ? sc.tex : this.dummyTex);
      if (sc && sc.tex) this._applyMips(sc);
      gl.uniform2f(this.eOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  // Pennello live su livello semitrasparente: (tratto over chunk) × opacità
  // per ogni chunk visibile, in un pass unico a due texture (vedi FS_PAINT).
  // I chunk del tratto su zone vuote del livello passano con uTex dummy
  // (resta tratto × opacità, già esatto).
  /**
   * @param {Camera} camera @param {Layer} layer @param {ChunkStore} strokeStore
   * @param {number} strokeOpacity
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawPaintLive(camera, layer, strokeStore, strokeOpacity, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    gl.useProgram(this.progPaint);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPosP = gl.getAttribLocation(this.progPaint, 'aPos');
    gl.enableVertexAttribArray(aPosP);
    gl.vertexAttribPointer(aPosP, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(this.plMat, false, camera.matrix());
    gl.uniform2f(this.plSize, CHUNK, CHUNK);
    gl.uniform1f(this.plAlpha, strokeOpacity);
    gl.uniform1f(this.plLayerA, layer.opacity);
    gl.uniform1i(this.plTex, 0);
    gl.uniform1i(this.plMask, 1);
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      gl.activeTexture(gl.TEXTURE0);
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      const sc = strokeStore.getByKey(chunk.key);
      if (sc && (!sc.tex || sc.texDirty)) this._uploadNow(sc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sc && sc.tex ? sc.tex : this.dummyTex);
      if (sc && sc.tex) this._applyMips(sc);
      gl.uniform2f(this.plOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.activeTexture(gl.TEXTURE1);
    for (const sc of strokeStore.map.values()) {
      if (sc.cx < cx0 || sc.cx > cx1 || sc.cy < cy0 || sc.cy > cy1) continue;
      if (layer.store.getByKey(sc.key)) continue; // già composto sopra
      if (!sc.tex || sc.texDirty) this._uploadNow(sc);
      gl.bindTexture(gl.TEXTURE_2D, sc.tex);
      this._applyMips(sc);
      gl.uniform2f(this.plOrigin, sc.cx * CHUNK, sc.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  // blendFunc fisso del modo (esatto sul premultiplied): true se applicato.
  /** @param {string} mode */
  _setModeBlend(mode) {
    const gl = this.gl;
    if (mode === 'screen') {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
      return true;
    }
    if (mode === 'add') {
      gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      return true;
    }
    return false;
  }

  // Programma del modo shader, compilato al primo uso (pattern dei fx).
  /** @param {string} mode */
  _modeProg(mode) {
    let prog = this._modeProgs[mode];
    if (!prog) {
      const gl = this.gl;
      prog = this._modeProgs[mode] = link(gl, VS_CHUNK, FS_BLEND(BLEND_FN[mode]));
      /** @type {Record<string, WebGLUniformLocation>} */
      const u = {};
      for (const n of ['uMat', 'uOrigin', 'uSize', 'uTex', 'uMask', 'uBack',
        'uBackSize', 'uAlpha', 'uLayerA', 'uEraser']) {
        u[n] = gl.getUniformLocation(prog, n);
      }
      this._modeUni[mode] = u;
    }
    return prog;
  }

  // Texture backdrop canvas-size per i modi shader (NEAREST: copia 1:1).
  _ensureBackdrop() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (!this._bdTex) {
      this._bdTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._bdTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._bdW = 0;
      this._bdH = 0;
    }
    if (this._bdW !== w || this._bdH !== h) {
      gl.bindTexture(gl.TEXTURE_2D, this._bdTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this._bdW = w;
      this._bdH = h;
    }
  }

  // Rettangolo DEVICE (origine GL in basso a sinistra) dei chunk visibili
  // di store (∪ strokeStore se dato), espanso al pixel intero e clampato al
  // canvas; null se non c'è nulla in vista.
  /**
   * @param {Camera} camera @param {ChunkStore} store @param {ChunkStore|null} strokeStore
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  _chunkRectDev(camera, store, strokeStore, cx0, cy0, cx1, cy1) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    /** @param {ChunkStore} st */
    const scan = (st) => {
      for (const c of st.map.values()) {
        if (c.cx < cx0 || c.cx > cx1 || c.cy < cy0 || c.cy > cy1) continue;
        if (c.cx < bx0) bx0 = c.cx;
        if (c.cx > bx1) bx1 = c.cx;
        if (c.cy < by0) by0 = c.cy;
        if (c.cy > by1) by1 = c.cy;
      }
    };
    scan(store);
    if (strokeStore) scan(strokeStore);
    if (bx1 < bx0) return null;
    const d = camera.dpr, z = camera.zoom;
    const left = ((bx0 * CHUNK - camera.x) * z + camera.w * 0.5) * d;
    const right = (((bx1 + 1) * CHUNK - camera.x) * z + camera.w * 0.5) * d;
    const top = ((by0 * CHUNK - camera.y) * z + camera.h * 0.5) * d;
    const bottom = (((by1 + 1) * CHUNK - camera.y) * z + camera.h * 0.5) * d;
    const L = Math.max(0, Math.floor(left));
    const R = Math.min(this.canvas.width, Math.ceil(right));
    const T = Math.max(0, Math.floor(top));
    const B = Math.min(this.canvas.height, Math.ceil(bottom));
    if (R <= L || B <= T) return null;
    return { x: L, y: this.canvas.height - B, w: R - L, h: B - T };
  }

  // Copia il rettangolo dal render target corrente nella texture backdrop
  // (stesse coordinate: lo shader campiona con gl_FragCoord/uBackSize).
  /** @param {{x:number,y:number,w:number,h:number}} rect */
  _copyBackdrop(rect) {
    const gl = this.gl;
    this._ensureBackdrop();
    this._bdUsed = true;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._bdTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, rect.x, rect.y, rect.w, rect.h);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Stato comune del pass fusione: programma, attributi, uniform fissi.
  // Ritorna le location; blending spento e scissor sul rect (il fragment
  // calcola l'intera formula, scrive anche dove il sorgente è vuoto).
  /**
   * @param {string} mode @param {{x:number,y:number,w:number,h:number}} rect
   * @param {Float32Array} mat @param {number} strokeOpacity @param {number} layerA
   * @param {boolean} eraser
   */
  _beginBlendPass(mode, rect, mat, strokeOpacity, layerA, eraser) {
    const gl = this.gl;
    const prog = this._modeProg(mode), u = this._modeUni[mode];
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix3fv(u.uMat, false, mat);
    gl.uniform2f(u.uBackSize, this._bdW, this._bdH);
    gl.uniform1f(u.uAlpha, strokeOpacity);
    gl.uniform1f(u.uLayerA, layerA);
    gl.uniform1f(u.uEraser, eraser ? 1 : 0);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uMask, 1);
    gl.uniform1i(u.uBack, 2);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, rect.y, rect.w, rect.h);
    return u;
  }

  _endBlendPass() {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Livello con modo shader: copia il backdrop nel bbox dei chunk visibili
  // e ricompone (livello + eventuale tratto/gomma live) con la formula W3C.
  /**
   * @param {Camera} camera @param {Layer} layer @param {string} mode
   * @param {ChunkStore|null} strokeStore @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawBlendLayer(camera, layer, mode, strokeStore, strokeOpacity, eraserLive, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    // la gomma può solo togliere: i chunk del tratto senza chunk del
    // livello non aggiungono nulla al bbox
    const rect = this._chunkRectDev(camera, layer.store,
      eraserLive ? null : strokeStore, cx0, cy0, cx1, cy1);
    if (!rect) return;
    this._copyBackdrop(rect);
    const u = this._beginBlendPass(mode, rect, camera.matrix(),
      strokeOpacity, layer.opacity, eraserLive);
    gl.uniform2f(u.uSize, CHUNK, CHUNK);
    for (const chunk of layer.store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      gl.activeTexture(gl.TEXTURE0);
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      const sc = strokeStore ? strokeStore.getByKey(chunk.key) : null;
      if (sc && (!sc.tex || sc.texDirty)) this._uploadNow(sc);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sc && sc.tex ? sc.tex : this.dummyTex);
      if (sc && sc.tex) this._applyMips(sc);
      gl.uniform2f(u.uOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    if (strokeStore && !eraserLive) {
      // tratto su zone vuote del livello: chunk dummy
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
      gl.activeTexture(gl.TEXTURE1);
      for (const sc of strokeStore.map.values()) {
        if (sc.cx < cx0 || sc.cx > cx1 || sc.cy < cy0 || sc.cy > cy1) continue;
        if (layer.store.getByKey(sc.key)) continue; // già composto sopra
        if (!sc.tex || sc.texDirty) this._uploadNow(sc);
        gl.bindTexture(gl.TEXTURE_2D, sc.tex);
        this._applyMips(sc);
        gl.uniform2f(u.uOrigin, sc.cx * CHUNK, sc.cy * CHUNK);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    this._endBlendPass();
  }

  /** @param {Camera} camera @param {Layer} layer @param {string} mode @param {any} styled */
  _drawBlendStyledLayer(camera, layer, mode, styled) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const rect = this._clipRectDev(camera, styled.clip);
    if (!rect) return;
    this._copyBackdrop(rect);
    const u = this._beginBlendPass(mode, rect, camera.matrix(), 0, layer.opacity, false);
    gl.uniform2f(u.uSize, styled.w, styled.h);
    gl.uniform2f(u.uOrigin, styled.x, styled.y);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, styled.out);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this._wantNearest ? gl.NEAREST : gl.LINEAR);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._endBlendPass();
  }

  // Rettangolo DEVICE (origine GL in basso) del clip di sessione, espanso
  // al pixel intero e clampato al canvas; null se fuori vista.
  /** @param {Camera} camera @param {TransformFrame['clip']} clip */
  _clipRectDev(camera, clip) {
    const d = camera.dpr, z = camera.zoom;
    const x0 = ((clip.x0 - camera.x) * z + camera.w * 0.5) * d;
    const y0 = ((clip.y0 - camera.y) * z + camera.h * 0.5) * d;
    const x1 = ((clip.x1 + 1 - camera.x) * z + camera.w * 0.5) * d;
    const y1 = ((clip.y1 + 1 - camera.y) * z + camera.h * 0.5) * d;
    const L = Math.max(0, Math.floor(x0));
    const R = Math.min(this.canvas.width, Math.ceil(x1));
    const T = Math.max(0, Math.floor(y0));
    const B = Math.min(this.canvas.height, Math.ceil(y1));
    if (R <= L || B <= T) return null;
    return { x: L, y: this.canvas.height - B, w: R - L, h: B - T };
  }

  // Sessione Sposta/Trasforma/Effetti su un livello con modo shader: il
  // quad/mesh della sessione si disegna nell'FBO trasparente dei gruppi
  // (stesso path per-livello di _drawLayer, opacità inclusa) e si presenta
  // col pass di fusione — il modo è live anche durante il drag, identico
  // al commit. Costo: un pass FBO + un blit, solo in sessione.
  /**
   * @param {Camera} camera @param {Layer} layer @param {string} mode
   * @param {number} activeId @param {ChunkStore|null} strokeStore
   * @param {number} strokeOpacity @param {boolean} eraserLive
   * @param {TransformFrame|null} transform @param {FxFrame|null} fx
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawBlendSession(camera, layer, mode, activeId, strokeStore, strokeOpacity, eraserLive, transform, fx, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    this._ensureGroupTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._grpFbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this._drawLayer(camera, layer, activeId, strokeStore, strokeOpacity,
      eraserLive, transform, fx, cx0, cy0, cx1, cy1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const clip = transform !== null && transform.layerId === layer.id
      ? transform.clip : fx.clip;
    const rect = this._clipRectDev(camera, clip);
    if (rect) this._blendBlitGroup(mode, rect); // opacità già nel quad
  }

  // Blit del gruppo di ritaglio col modo della base: _grpTex (gruppo già
  // composto, opacità della base inclusa) over canvas con la formula W3C.
  /** @param {string} mode @param {{x:number,y:number,w:number,h:number}} rect */
  _blendBlitGroup(mode, rect) {
    const gl = this.gl;
    this._copyBackdrop(rect);
    const u = this._beginBlendPass(mode, rect, BLIT_MAT, 0, 1, false);
    gl.uniform2f(u.uOrigin, 0, 0);
    gl.uniform2f(u.uSize, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._grpTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this._endBlendPass();
  }

  // Upload immediato di un chunk la cui texture è assente o stantia
  // (eviction, pool, context restore). La CPU è la verità.
  /** @param {Chunk} chunk */
  _uploadNow(chunk) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._ensureTex(chunk));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CHUNK, CHUNK, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.length));
    chunk.texDirty = false;
    // il chunk intero è in texture: l'eventuale rect accumulato è coperto
    chunk.dirX0 = CHUNK; chunk.dirY0 = CHUNK; chunk.dirX1 = -1; chunk.dirY1 = -1;
    chunk.mips = false;
    this.uploadsThisFrame++;
  }

  /**
   * @param {ChunkStore} store
   * @param {number} cx0 @param {number} cy0 @param {number} cx1 @param {number} cy1
   */
  _drawStore(store, cx0, cy0, cx1, cy1) {
    const gl = this.gl;
    for (const chunk of store.map.values()) {
      if (chunk.cx < cx0 || chunk.cx > cx1 || chunk.cy < cy0 || chunk.cy > cy1) continue;
      if (!chunk.tex || chunk.texDirty) this._uploadNow(chunk);
      gl.bindTexture(gl.TEXTURE_2D, chunk.tex);
      this._applyMips(chunk);
      gl.uniform2f(this.uOrigin, chunk.cx * CHUNK, chunk.cy * CHUNK);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // Tiene la VRAM limitata: oltre maxTex, le texture dei chunk fuori
  // schermo vengono liberate (verranno ricaricate on-demand alla vista).
  /** @param {ChunkStore[]} stores @param {Camera} camera @param {number} [maxTex] @param {Set<ChunkStore>|null} [covered] */
  evict(stores, camera, maxTex = 1024, covered = null) {
    if (this.contextLost || this.texCount <= maxTex) return;
    // prima gli store coperti da un quad proxy: non si disegnano affatto,
    // le loro texture vanno via anche se dentro la vista
    if (covered !== null) {
      for (const store of stores) {
        if (!covered.has(store)) continue;
        for (const chunk of store.map.values()) {
          if (this.texCount <= maxTex) return;
          if (chunk.tex) {
            this.gl.deleteTexture(chunk.tex);
            chunk.tex = null;
            chunk.texDirty = true;
            this.texCount--;
          }
        }
      }
    }
    const r = camera.visibleRect(this._rect);
    const cx0 = Math.floor(r.x0 / CHUNK), cy0 = Math.floor(r.y0 / CHUNK);
    const cx1 = Math.floor(r.x1 / CHUNK), cy1 = Math.floor(r.y1 / CHUNK);
    for (const store of stores) {
      if (covered !== null && covered.has(store)) continue; // già svuotati sopra
      for (const chunk of store.map.values()) {
        if (this.texCount <= maxTex) return;
        if (chunk.cx >= cx0 && chunk.cx <= cx1 && chunk.cy >= cy0 && chunk.cy <= cy1) continue;
        if (chunk.tex) {
          this.gl.deleteTexture(chunk.tex);
          chunk.tex = null;
          chunk.texDirty = true;
          this.texCount--;
        }
      }
    }
  }

  // Il canvas sta per essere sostituito (cambio attributi di contesto):
  // rilascia il contesto subito invece di aspettare il GC dell'elemento.
  dispose() {
    if (!this.gl) return;
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
