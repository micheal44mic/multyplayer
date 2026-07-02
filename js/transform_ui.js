// STRUMENTO SPOSTA/TRASFORMA — sessione con bbox, maniglie di scala e
// rotazione, conferma esplicita (✓/Invio) o annullo (✗/Esc).
// Filosofia anti-lag e anti-degrado: durante i gesti NESSUN pixel si tocca —
// tutti i ritocchi si accumulano in un'unica affine (sposta+ruota+scala,
// pivot al centro della bbox) e l'anteprima è il quad del renderer (vedi
// TransformFrame); al ✓ si ricampiona UNA volta sola dai pixel originali.
// Traslazione intera pura al ✓ = translateStore: bit-exact, undo leggero.
// Testo: niente texture — sposta/scala vivono su item.x/y/size (vettoriale,
// zero perdita); la rotazione del testo non esiste nel modello (prima si
// rasterizza, poi si ruota).
// Ciclo di vita PER FRAME (sync): se il bersaglio (tool, livello, canvas)
// cambia con una trasformazione pendente, questa si conferma da sola —
// stile Procreate: uscire = applicare; l'annullo è solo esplicito.
// MODALITÀ WARP (tab nell'header, alla Photoshop/cbos): griglia
// 3×3/4×4/5×5 = patch di Bézier di grado 3/4/5 sulla bbox (vedi warp.js),
// composta SOPRA l'affine. Tre gesti: punto di controllo (gli angoli
// portano con sé le maniglie di bordo, con le linee-maniglia disegnate),
// drag SULLA superficie (la spinta si distribuisce ai punti con pesi
// Bernstein a norma minima: il punto afferrato segue il dito) e drag fuori
// = traslazione. Anteprima a mesh GPU/bake 2D, commit one-shot warpStore.
// Solo livelli raster (il testo prima si rasterizza).
// MODALITÀ PROSPETTIVA (tab nell'header, alla cbos): 4 angoli liberi =
// omografia sulla bbox (vedi warp.js), composta SOPRA l'affine come il
// warp. Il quad resta convesso per costruzione (il drag che lo romperebbe
// non si applica: oltre l'omografia degenera). Anteprima quad GPU con
// divisione prospettica/bake 2D, commit one-shot perspStore. Warp e
// prospettiva NON si compongono tra loro: il salto diretto da un tab
// all'altro applica la sessione (uscire = applicare, come Procreate).
// MODALITÀ MARIONETTA (tab nell'header, il Puppet Warp di Photoshop): il
// contenuto viene triangolato sulla sola zona con alpha (vedi puppet.js) e
// si pianta una PUNTINA cliccando sulla mesh; il toggle Move/Ruota decide
// se trascinarla o ruotarla, le puntine ferme ancorano. Alt+click resta una
// scorciatoia desktop per eliminare, Shift+click seleziona multiplo in Move,
// Canc elimina le selezionate. Opzioni alla Photoshop: Modalità
// (elasticità), Mostra rete, Ruota Auto/Fisso. La marionetta NON si compone con l'affine: entrare nel
// tab applica la sessione pendente (uscire = applicare, come gli altri tab)
// e dentro il tab il drag sul canvas pianta puntine invece di traslare.

import { brush } from './brush.js';
import { CHUNK_SHIFT, contentBBox, translateStore, translateStoreWrapped, transformStore, wrapStoreIntoClip } from './store.js';
import { blockBox, touchText } from './text_layer.js';
import { multiplyMatrix, svgWorldBox, touchSvg } from './svg_layer.js';
import { makeLattice, latticeIdentity, resampleLattice, warpGridWorld, warpStore, warpUvAt, warpPushWeights, makePerspQuad, perspIdentity, perspConvex, perspStore } from './warp.js';
import { buildPuppetMesh, puppetHit, PuppetSolver, puppetTriOrder, puppetStore } from './puppet.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./store.js').ChunkStore} ChunkStore */
/** @typedef {import('./renderer_gl.js').TransformFrame} TransformFrame */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PUPPET_EXPANSION = 2; // px sorgente, fisso come default Photoshop
const SMART_GUIDE_KEY = 'fable-paint.smart-guides';
const SMART_GUIDE_SNAP_PX = 8; // raggio schermo: resta naturale a ogni zoom
const SMART_GUIDE_MAX_WORLD = 48;
const SMART_GUIDE_MIN_WORLD = 0.5;
const PRECISION_FIELDS = /** @type {const} */ (['x', 'y', 'w', 'h', 'rot']);
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

// Maniglie: posizione nella bbox in unità (u,v) 0..1.
// Angoli = scala uniforme, lati = stira un asse, 'rot' = ruota (solo raster).
/** @type {[string, number, number][]} */
const DOTS = [
  ['tl', 0, 0], ['tr', 1, 0], ['br', 1, 1], ['bl', 0, 1],
  ['tm', 0.5, 0], ['rm', 1, 0.5], ['bm', 0.5, 1], ['lm', 0, 0.5],
];
const CORNER = new Set(['tl', 'tr', 'br', 'bl']);
const ROT_SNAP = 0.026; // ~1.5°: aggancio a 0/90/180/270 (torna al lossless)

/**
 * Una puntina del puppet warp (alla Photoshop).
 * @typedef {Object} PupPin
 * @property {number} id
 * @property {number} v vertice della mesh ancorato
 * @property {number} rx @property {number} ry ancora a riposo (mondo)
 * @property {number} tx @property {number} ty bersaglio corrente (mondo)
 * @property {number} rot angolo (rad), vincolante se fixed
 * @property {boolean} fixed rotazione fissa (toggle Ruota o select "Fisso")
 * @property {number} depth ordine interno puntina nelle pieghe
 * @property {boolean} sel selezionata (punto nero al centro)
 * @property {number} ang ultimo angolo emergente (lettura, modalità Auto)
 */

/**
 * Stato della modalità Marionetta, per sessione (pigro: nasce al primo
 * ingresso nel tab). mesh null = contenuto non triangolabile.
 * @typedef {Object} PupState
 * @property {import('./puppet.js').PuppetMesh|null} mesh
 * @property {Float32Array} def vertici deformati (mondo)
 * @property {Float32Array} uv UV dei vertici nello spazio dell'hull texture
 * @property {Uint16Array} idx indici GL nell'ordine di disegno corrente
 * @property {Uint32Array} order triangoli dal meno al più "sopra"
 * @property {PuppetSolver|null} solver
 * @property {Float32Array} vdep profondità per vertice (dalla puntina più vicina)
 * @property {PupPin[]} pins
 * @property {number} nextPin
 * @property {number} pinsVer timbro di puntine/selezione (il DOM si risincronizza)
 * @property {number} ver timbro della deformazione (anteprime invalidano qui)
 * @property {number} meshVer timbro della mesh (uv/topologia da ricostruire)
 * @property {boolean} on deformazione non a riposo (= parteciperà al commit)
 * @property {number} relax frame di rilassamento del solver ancora dovuti
 */

/**
 * Elemento dentro una trasformazione multi-layer. Conserva la fotografia
 * geometrica iniziale del singolo layer, mentre la sessione conserva la bbox
 * del gruppo.
 * @typedef {Object} TfItem
 * @property {number} layerId @property {'raster'|'text'|'svg'} kind
 * @property {number} bx @property {number} by @property {number} bw @property {number} bh
 * @property {number} texX @property {number} texY @property {number} texW @property {number} texH
 * @property {number} ix0 @property {number} iy0 @property {number} s0
 * @property {[number, number, number, number, number, number]} m0
 */

/**
 * Stato della sessione. La trasformazione è
 * T = Translate(c+t) · Rot(θ) · Scale(sx,sy) · Translate(-c), pivot c fisso.
 * @typedef {Object} TfSession
 * @property {number} layerId @property {number} boardId
 * @property {'raster'|'text'|'svg'|'multi'} kind
 * @property {number} stamp timbro per la texture del renderer
 * @property {string} targetSig firma dei layer selezionati da cui nasce
 * @property {TfItem[]} items layer della trasformazione multi/singola
 * @property {boolean} hasText
 * @property {number} bx @property {number} by bbox contenuto alla partenza
 * @property {number} bw @property {number} bh
 * @property {number} cx @property {number} cy pivot (centro bbox)
 * @property {number} tx @property {number} ty traslazione (px mondo interi)
 * @property {number} theta @property {number} sx @property {number} sy
 * @property {number} texX @property {number} texY hull chunk-aligned (raster)
 * @property {number} texW @property {number} texH
 * @property {number} ix0 @property {number} iy0 @property {number} s0 testo: item alla partenza
 * @property {[number, number, number, number, number, number]} m0 SVG: matrice alla partenza
 * @property {number} gridN celle warp per lato (3/4/5)
 * @property {Float32Array|null} wpts ancore warp in unità bbox (pigre: nate al primo ingresso nel tab)
 * @property {number} wver timbro della griglia (anteprime e gizmo invalidano qui)
 * @property {boolean} won griglia non a riposo (= il warp parteciperà al commit)
 * @property {Float32Array|null} ppts angoli prospettiva (TL,TR,BR,BL) in unità bbox (pigri come wpts)
 * @property {number} pver timbro del quad prospettiva
 * @property {boolean} pon quad non a riposo (= la prospettiva parteciperà al commit)
 * @property {PupState|null} pup stato Marionetta (pigro come wpts/ppts)
 */

export class TransformTool {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    /** @type {TfSession|null} */
    this._session = null;
    this._stamp = 0;
    this._emptyKey = ''; // livello visto vuoto: niente rescan a ogni frame
    /** @type {{kind: string, gx: number, gy: number, tx0?: number, ty0?: number, th0?: number, sx0?: number, sy0?: number, idx?: number, pts0?: Float32Array, w?: Float64Array, pins0?: Map<number, {tx: number, ty: number}>, pinId?: number, a0?: number|null, rot0?: number, fixed0?: boolean, moved?: boolean, sx?: number, sy?: number, deleteOnTap?: boolean}|null} */
    this._drag = null;
    this._sig = '';
    this._visible = false;
    this._liveSig = '';
    this._liveNext = 0;
    this._tmp = { x: 0, y: 0 };
    /** @type {'affine'|'persp'|'warp'|'puppet'} tab attiva nell'header (persp/warp/puppet solo raster) */
    this.mode = 'affine';
    this._keepMode = false; // one-shot: il tab scelto sopravvive al prossimo _begin
    this._gridN = 3; // densità della griglia warp: persiste tra le sessioni
    // preferenze Marionetta: persistono tra le sessioni (alla Photoshop)
    /** @type {'rigid'|'normal'|'distort'} */
    this._pupMode = 'normal';
    /** @type {'move'|'rotate'} */
    this._pupAction = 'move';
    this._pupShowMesh = true;  // Mostra rete
    this.smartGuides = this._loadSmartGuides();
    /** @type {{x0:number,y0:number,x1:number,y1:number,cx:number,cy:number}[]|null} */
    this._smartRefs = null;
    /** @type {{board: import('./boards.js').Board, v: number[], h: number[]}|null} */
    this._guideState = null;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'tfgizmo');
    svg.setAttribute('aria-hidden', 'true');
    this.svg = svg;
    this.guideEl = document.createElementNS(SVG_NS, 'path');
    this.guideEl.setAttribute('class', 'tg-smart-guide');
    // griglia warp SOTTO il bordo (linee leggere, solo visuali) + raggi
    // angolo→maniglia di bordo (alla Photoshop)
    this.gridEl = document.createElementNS(SVG_NS, 'path');
    this.gridEl.setAttribute('class', 'tg-grid');
    this.handleEl = document.createElementNS(SVG_NS, 'path');
    this.handleEl.setAttribute('class', 'tg-hline');
    this.edgeEl = document.createElementNS(SVG_NS, 'path');
    this.edgeEl.setAttribute('class', 'tg-edge');
    this.spokeEl = document.createElementNS(SVG_NS, 'path');
    this.spokeEl.setAttribute('class', 'tg-spoke');
    svg.append(this.guideEl, this.gridEl, this.handleEl, this.edgeEl, this.spokeEl);
    /** @type {Map<string, SVGCircleElement>} */
    this._dots = new Map();
    for (const [k] of DOTS) this._addDot(k, CORNER.has(k) ? 'tg-corner' : 'tg-side');
    this._addDot('rot', 'tg-rot');
    /** @type {{el: SVGCircleElement, k: number}[]} punti warp di BORDO
     * (k = indice nel reticolo), ricreati al cambio griglia — gli interni
     * non si vedono né si toccano: l'interno si lavora col drag-superficie */
    this._warpDots = [];
    /** @type {SVGCircleElement[]} angoli della prospettiva (TL,TR,BR,BL):
     * sempre 4, nati una volta — la densità qui non cambia mai */
    this._perspDots = [];
    for (let k = 0; k < 4; k++) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'tg-warp tg-warp-corner');
      c.setAttribute('r', '7');
      c.style.display = 'none';
      c.addEventListener('pointerdown', (e) => this._perspDown(e, k));
      c.addEventListener('pointermove', (e) => this._perspMove(e));
      const pup = () => { this._drag = null; };
      c.addEventListener('pointerup', pup);
      c.addEventListener('pointercancel', pup);
      svg.appendChild(c);
      this._perspDots.push(c);
    }
    // Marionetta: la rete si disegna su un canvas overlay (migliaia di
    // spigoli: il path SVG sarebbe un macigno), SOTTO il gizmo — le puntine
    // sono gruppi SVG nel gizmo e gli restano sopra
    this.meshCnv = document.createElement('canvas');
    this.meshCnv.id = 'puppet-mesh';
    document.body.appendChild(this.meshCnv);
    // cerchio della rotazione (drag Ruota su una puntina, alla Photoshop)
    this._rotCirc = document.createElementNS(SVG_NS, 'circle');
    this._rotCirc.setAttribute('class', 'tg-rotcirc');
    this._rotCirc.setAttribute('r', '26');
    this._rotCirc.style.display = 'none';
    svg.appendChild(this._rotCirc);
    /** @type {Map<number, {g: SVGGElement, ring: SVGCircleElement, dot: SVGCircleElement}>} pin id → DOM */
    this._pinEls = new Map();
    document.body.appendChild(svg);

    this.okBtn = this._button('tg-ok', '✓', 'Apply (Enter)', () => this.confirm(true));
    this.noBtn = this._button('tg-no', '✕', 'Cancel (Esc)', () => this.cancel());

    // riuso dei buffer del campionamento della griglia (gizmo)
    /** @type {Float32Array|null} */
    this._gizGrid = null;

    // tab Trasforma/Warp + griglia nell'header (index.html#move-opts):
    // visibilità gestita da sync() — appare col tool, come #select-opts
    this._opts = document.getElementById('move-opts');
    /** @type {[('affine'|'persp'|'warp'|'puppet'), HTMLButtonElement][]} */
    this._tabBtns = [
      ['affine', /** @type {HTMLButtonElement} */ (document.getElementById('tf-tab-affine'))],
      ['persp', /** @type {HTMLButtonElement} */ (document.getElementById('tf-tab-persp'))],
      ['warp', /** @type {HTMLButtonElement} */ (document.getElementById('tf-tab-warp'))],
      ['puppet', /** @type {HTMLButtonElement} */ (document.getElementById('tf-tab-puppet'))],
    ];
    this._gridWrap = document.getElementById('tf-grid');
    /** @type {HTMLButtonElement[]} */
    this._gridBtns = Array.from(this._gridWrap.querySelectorAll('.tf-gbtn'));
    this._smartBtn = /** @type {HTMLButtonElement} */ (document.getElementById('tf-smart'));
    for (const [mode, btn] of this._tabBtns) {
      btn.addEventListener('click', () => this.setMode(mode));
    }
    for (const b of this._gridBtns) {
      b.addEventListener('click', () => this.setGrid(Number(b.dataset.n)));
    }
    this._smartBtn.addEventListener('click', () => this.setSmartGuides(!this.smartGuides));
    this._precisionWrap = document.getElementById('tf-precision');
    this._alignWrap = document.getElementById('tf-align');
    this._precisionInputs = Object.fromEntries(PRECISION_FIELDS.map((key) =>
      [key, /** @type {HTMLInputElement} */ (document.getElementById('tf-' + key))]));
    this._ratioLocked = true;
    this._ratioBtn = /** @type {HTMLButtonElement} */ (document.getElementById('tf-ratio'));
    for (const key of PRECISION_FIELDS) {
      const input = this._precisionInputs[key];
      input.addEventListener('change', () => this._applyPrecisionField(key));
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        this._applyPrecisionField(key);
        input.blur();
      });
    }
    this._ratioBtn.addEventListener('click', () => {
      this._ratioLocked = !this._ratioLocked;
      this._syncPrecision();
    });
    this._alignBtns = Array.from(this._alignWrap.querySelectorAll('[data-align]'));
    for (const b of this._alignBtns) {
      b.addEventListener('click', () => this._alignToCanvas(b.dataset.align || ''));
    }
    this._distributeBtns = Array.from(this._alignWrap.querySelectorAll('[data-distribute]'));
    for (const b of this._distributeBtns) {
      b.addEventListener('click', () => this._distributeSelection(b.dataset.distribute || ''));
    }
    // opzioni Marionetta (riga nell'header, visibile solo nel tab)
    this._pupOpts = document.getElementById('puppet-opts');
    this._ppMode = /** @type {HTMLSelectElement} */ (document.getElementById('pp-mode'));
    /** @type {[('move'|'rotate'), HTMLButtonElement][]} */
    this._ppActionBtns = [
      ['move', /** @type {HTMLButtonElement} */ (document.getElementById('pp-act-move'))],
      ['rotate', /** @type {HTMLButtonElement} */ (document.getElementById('pp-act-rot'))],
    ];
    this._ppShowMesh = /** @type {HTMLInputElement} */ (document.getElementById('pp-showmesh'));
    this._ppRot = /** @type {HTMLSelectElement} */ (document.getElementById('pp-rot'));
    this._ppAng = /** @type {HTMLInputElement} */ (document.getElementById('pp-ang'));
    this._ppMode.addEventListener('change', () => {
      this._pupMode = /** @type {any} */ (this._ppMode.value);
      this._pupWake();
    });
    for (const [action, btn] of this._ppActionBtns) {
      btn.addEventListener('click', () => this._setPupAction(action));
    }
    this._ppShowMesh.addEventListener('change', () => {
      this._pupShowMesh = this._ppShowMesh.checked;
      this._sig = '';
    });
    this._ppRot.addEventListener('change', () => this._pupRotChanged());
    this._ppAng.addEventListener('change', () => this._pupRotChanged());
    this._optsShown = false;
    this._syncOpts();
  }

  /** @param {string} cls @param {string} label @param {string} title @param {() => void} fn */
  _button(cls, label, title, fn) {
    const b = document.createElement('button');
    b.className = 'tg-btn ' + cls;
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.display = 'none';
    b.addEventListener('click', fn);
    document.body.appendChild(b);
    return b;
  }

  /** @param {string} key @param {string} cls */
  _addDot(key, cls) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('r', key === 'rot' ? '7' : '6');
    c.addEventListener('pointerdown', (e) => this._handleDown(e, key));
    c.addEventListener('pointermove', (e) => this._handleMove(e));
    const up = () => {
      this._drag = null;
      this._smartRefs = null;
      this._clearSmartGuides();
      this._sig = '';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    this.svg.appendChild(c);
    this._dots.set(key, c);
  }

  get active() { return this._session !== null; }
  get dragging() { return this._drag !== null; }

  // Trasformazione non-identità in attesa di ✓/✗ (blocca undo/redo).
  get pending() {
    const s = this._session;
    return !!s && (s.tx !== 0 || s.ty !== 0 || s.theta !== 0 || s.sx !== 1 || s.sy !== 1 ||
      s.won || s.pon || !!(s.pup && s.pup.on));
  }

  // T mondo→mondo come [a,b,c,d,e,f].
  /** @param {TfSession} s */
  _matrix(s) {
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const a = s.sx * cos, b = s.sx * sin, c = -s.sy * sin, d = s.sy * cos;
    return [a, b, c, d,
      s.cx + s.tx - a * s.cx - c * s.cy,
      s.cy + s.ty - b * s.cx - d * s.cy];
  }

  // ---- ciclo di vita (ogni frame, da App._frame) ----
  /** @param {import('./camera.js').Camera} cam */
  sync(cam) {
    const want = brush.tool === 'move' ? this._target() : null;
    const s = this._session;
    if (s && (!want || want.sig !== s.targetSig)) this.confirm();
    if (!this._session && want) this._beginTarget(want);
    // tab nell'header: visibili col tool, Warp spento sul testo
    const show = brush.tool === 'move';
    if (show !== this._optsShown) {
      this._optsShown = show;
      this._opts.hidden = !show;
    }
    const cur = this._session;
    const vectorOnly = !!cur && cur.kind !== 'raster';
    if (vectorOnly && this.mode !== 'affine') this.setMode('affine');
    for (const [mode, btn] of this._tabBtns) {
      if (mode !== 'affine' && btn.disabled !== vectorOnly) btn.disabled = vectorOnly;
    }
    if (this.mode === 'warp') this._ensureLattice();
    if (this.mode === 'persp') this._ensurePQuad();
    if (this.mode === 'puppet') this._ensurePuppet();
    this._puppetTick();
    this._syncGizmo(cam);
    this._syncPrecision();
    this._emitLive(false);
  }

  // ---- modalità (tab Trasforma/Prospettiva/Warp/Marionetta) e densità ----
  /** @param {'affine'|'persp'|'warp'|'puppet'} m */
  setMode(m) {
    if (m === this.mode) return;
    const s = this._session;
    if (m !== 'affine' && s && s.kind !== 'raster') return; // prima si rasterizza
    // le modalità non si compongono tra loro (e la marionetta nemmeno con
    // l'affine): il salto diretto applica la sessione (uscire = applicare)
    // e si riparte puliti — ma il tab scelto resta: la sessione nuova NON
    // deve ripartire da Trasforma
    if (s) {
      const aff = s.tx !== 0 || s.ty !== 0 || s.theta !== 0 || s.sx !== 1 || s.sy !== 1;
      const won = !!(s.wpts && s.won), pon = !!(s.ppts && s.pon), pup = !!(s.pup && s.pup.on);
      const need =
        (m === 'warp' && (pon || pup)) ||
        (m === 'persp' && (won || pup)) ||
        (m === 'puppet' && (won || pon || aff)) ||
        (m === 'affine' && pup);
      if (need) {
        this.confirm();
        this._keepMode = true;
      }
    }
    this.mode = m;
    if (m === 'warp') this._ensureLattice();
    if (m === 'persp') this._ensurePQuad();
    if (m === 'puppet') this._ensurePuppet();
    this._syncOpts();
    this._sig = ''; // il gizmo cambia faccia
  }

  /** @param {number} n */
  setGrid(n) {
    this._gridN = n;
    const s = this._session;
    if (s && s.kind === 'raster' && s.gridN !== n) {
      // la piega si conserva: le ancore nuove sono la superficie corrente
      // campionata ai nodi della griglia nuova (alla Photoshop)
      if (s.wpts && s.won) s.wpts = resampleLattice(s.wpts, s.gridN, n);
      else if (s.wpts) s.wpts = makeLattice(n);
      s.gridN = n;
      s.wver++;
      this._sig = '';
    }
    this._syncOpts();
  }

  // Le ancore nascono al primo ingresso nel tab Warp (a riposo: nessun
  // costo finché non si trascina).
  _ensureLattice() {
    const s = this._session;
    if (s && s.kind === 'raster' && !s.wpts) {
      s.wpts = makeLattice(s.gridN);
      s.won = false;
      s.wver++;
    }
  }

  // Il quad nasce al primo ingresso nel tab Prospettiva (a riposo: nessun
  // costo finché non si trascina).
  _ensurePQuad() {
    const s = this._session;
    if (s && s.kind === 'raster' && !s.ppts) {
      s.ppts = makePerspQuad();
      s.pon = false;
      s.pver++;
    }
  }

  // ---- Marionetta (Puppet Warp alla Photoshop) ----

  // La mesh nasce al primo ingresso nel tab (triangolazione one-shot del
  // contenuto: decine di ms, una volta per sessione).
  _ensurePuppet() {
    const s = this._session;
    if (!s || s.kind !== 'raster' || s.pup) return;
    const layer = this.app.boards.layerById(s.layerId);
    if (!layer || !layer.store) return;
    const mesh = buildPuppetMesh(layer.store,
      { x: s.bx, y: s.by, w: s.bw, h: s.bh }, PUPPET_EXPANSION, 'normal');
    s.pup = this._makePup(mesh, s);
    this._sig = '';
  }

  /** @param {import('./puppet.js').PuppetMesh|null} mesh @param {TfSession} s @returns {PupState} */
  _makePup(mesh, s) {
    if (!mesh) {
      return {
        mesh: null, def: new Float32Array(0), uv: new Float32Array(0),
        idx: new Uint16Array(0), order: new Uint32Array(0), solver: null,
        vdep: new Float32Array(0), pins: [], nextPin: 1, pinsVer: 1,
        ver: 1, meshVer: 1, on: false, relax: 0,
      };
    }
    const n = mesh.pos0.length >> 1;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[i * 2] = (mesh.pos0[i * 2] - s.texX) / s.texW;
      uv[i * 2 + 1] = (mesh.pos0[i * 2 + 1] - s.texY) / s.texH;
    }
    const T = (mesh.tris.length / 3) | 0;
    const order = new Uint32Array(T);
    for (let t = 0; t < T; t++) order[t] = t;
    return {
      mesh, def: mesh.pos0.slice(), uv,
      idx: new Uint16Array(mesh.tris), order,
      solver: new PuppetSolver(mesh.pos0, mesh.tris),
      vdep: new Float32Array(n),
      pins: [], nextPin: 1, pinsVer: 1,
      ver: 1, meshVer: 1, on: false, relax: 0,
    };
  }

  // Sveglia il solver (parametri cambiati, puntine mosse): rilassa nei
  // prossimi frame.
  _pupWake() {
    const s = this._session;
    if (s && s.pup && s.pup.mesh) {
      s.pup.relax = 45;
      this._sig = '';
    }
  }

  /** @param {PupState} pup deformazione non a riposo? */
  _pupMoved(pup) {
    for (const p of pup.pins) {
      if (Math.abs(p.tx - p.rx) > 0.01 || Math.abs(p.ty - p.ry) > 0.01) return true;
      if (p.fixed && p.rot !== 0) return true;
    }
    return false;
  }

  // Ordine per vertice = ordine della puntina più vicina (a riposo).
  /** @param {PupState} pup */
  _pupVdep(pup) {
    const mesh = pup.mesh;
    if (!mesh) return;
    const n = mesh.pos0.length >> 1;
    if (pup.pins.length === 0) { pup.vdep.fill(0); return; }
    for (let i = 0; i < n; i++) {
      const x = mesh.pos0[i * 2], y = mesh.pos0[i * 2 + 1];
      let bd = Infinity, dep = 0;
      for (const p of pup.pins) {
        const dx = p.rx - x, dy = p.ry - y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; dep = p.depth; }
      }
      pup.vdep[i] = dep;
    }
  }

  // Riordina i triangoli (pieghe + ordine puntina) e rigenera gli
  // indici GL nell'ordine nuovo.
  /** @param {PupState} pup */
  _pupSort(pup) {
    const mesh = pup.mesh;
    if (!mesh) return;
    pup.order = puppetTriOrder(mesh.pos0, pup.def, mesh.tris, pup.vdep, pup.order);
    const tris = mesh.tris;
    let q = 0;
    for (let i = 0; i < pup.order.length; i++) {
      const t = pup.order[i] * 3;
      pup.idx[q++] = tris[t];
      pup.idx[q++] = tris[t + 1];
      pup.idx[q++] = tris[t + 2];
    }
  }

  // Un tick del solver per frame (chiamato da sync): mentre si trascina o
  // finché il rilassamento non si esaurisce. La deformazione converge
  // morbida sotto il dito, come il Puppet Warp vero.
  _puppetTick() {
    const s = this._session;
    const pup = s ? s.pup : null;
    if (!pup || !pup.mesh || !pup.solver || this.mode !== 'puppet') return;
    const draggingPin = this._drag !== null &&
      (this._drag.kind === 'pin' || this._drag.kind === 'pinrot');
    if (pup.pins.length === 0 || (!draggingPin && pup.relax <= 0)) return;
    pup.solver.step(pup.def, pup.pins, this._pupMode, 2);
    if (!draggingPin) pup.relax--;
    // angolo emergente per la lettura nel campo Ruota (modalità Auto)
    for (const p of pup.pins) p.ang = p.fixed ? p.rot : pup.solver.angleAt(p.v);
    pup.on = this._pupMoved(pup);
    this._pupSort(pup);
    pup.ver++;
    this._sig = '';
  }

  // Pianta una puntina (click sulla mesh) o deseleziona (click fuori).
  // La puntina nasce alla posizione corrente: piantarla non deforma nulla.
  /** @param {number} x @param {number} y mondo */
  _puppetDown(x, y) {
    const s = this._session, pup = s.pup;
    if (!pup || !pup.mesh) return;
    const v = puppetHit(pup.def, pup.mesh.tris, x, y);
    if (v < 0) {
      let any = false;
      for (const p of pup.pins) { if (p.sel) { p.sel = false; any = true; } }
      if (any) { pup.pinsVer++; this._sig = ''; }
      return;
    }
    let pin = pup.pins.find((p) => p.v === v);
    if (!pin) {
      pin = {
        id: pup.nextPin++, v,
        rx: pup.mesh.pos0[v * 2], ry: pup.mesh.pos0[v * 2 + 1],
        tx: pup.def[v * 2], ty: pup.def[v * 2 + 1],
        rot: 0, fixed: false, depth: 0, sel: false, ang: 0,
      };
      pup.pins.push(pin);
      pup.solver.setPins(pup.pins);
      this._pupVdep(pup);
    }
    for (const p of pup.pins) p.sel = p === pin;
    pup.pinsVer++;
    if (this._pupAction === 'rotate') this._beginPinRotate(pup, pin, x, y, null, null, false);
    else this._beginPinDrag(pup, x, y);
    this._sig = '';
  }

  /** @param {PupState} pup @param {number} x @param {number} y mondo */
  _beginPinDrag(pup, x, y) {
    /** @type {Map<number, {tx: number, ty: number}>} */
    const pins0 = new Map();
    for (const p of pup.pins) if (p.sel) pins0.set(p.id, { tx: p.tx, ty: p.ty });
    this._drag = { kind: 'pin', gx: x, gy: y, pins0 };
    pup.relax = 45;
  }

  /** @param {PupState} pup @param {PupPin} pin @param {number} x @param {number} y mondo @param {number|null} sx @param {number|null} sy @param {boolean} deleteOnTap */
  _beginPinRotate(pup, pin, x, y, sx, sy, deleteOnTap) {
    const cx = pup.def[pin.v * 2], cy = pup.def[pin.v * 2 + 1];
    const nearCenter = Math.hypot(x - cx, y - cy) < 0.001;
    this._drag = {
      kind: 'pinrot', pinId: pin.id, gx: x, gy: y,
      rot0: pin.fixed ? pin.rot : pin.ang,
      fixed0: pin.fixed,
      a0: nearCenter ? null : Math.atan2(y - cy, x - cx),
      moved: false,
      sx: sx === null ? undefined : sx,
      sy: sy === null ? undefined : sy,
      deleteOnTap,
    };
    pup.relax = 45;
  }

  /** @param {PupState} pup @param {any} d @param {number} x @param {number} y mondo @param {number|null} sx @param {number|null} sy */
  _rotatePinDrag(pup, d, x, y, sx, sy) {
    const pin = pup.pins.find((p) => p.id === d.pinId);
    if (!pin) return;
    if (!d.moved) {
      const ds = sx !== null && sy !== null && d.sx !== undefined && d.sy !== undefined
        ? Math.abs(sx - d.sx) + Math.abs(sy - d.sy)
        : Math.hypot(x - d.gx, y - d.gy);
      if (ds < 4) return;
      d.moved = true;
    }
    const cx = pup.def[pin.v * 2], cy = pup.def[pin.v * 2 + 1];
    const a = Math.atan2(y - cy, x - cx);
    if (d.a0 === null || d.a0 !== d.a0) {
      d.a0 = a;
      d.rot0 = pin.fixed ? pin.rot : pin.ang;
    }
    pin.rot = d.rot0 + (a - d.a0);
    pin.fixed = true;
    pup.solver.setPins(pup.pins);
    pup.relax = 45;
    pup.pinsVer++;
    this._sig = '';
  }

  // Elimina una puntina; senza più puntine la mesh torna a riposo.
  /** @param {number} id */
  _deletePin(id) {
    const s = this._session, pup = s ? s.pup : null;
    if (!pup || !pup.mesh) return;
    const i = pup.pins.findIndex((p) => p.id === id);
    if (i < 0) return;
    pup.pins.splice(i, 1);
    pup.solver.setPins(pup.pins);
    this._pupVdep(pup);
    if (pup.pins.length === 0) {
      pup.def.set(pup.mesh.pos0);
      pup.on = false;
      this._pupSort(pup);
      pup.ver++;
    } else {
      pup.relax = 45;
    }
    pup.pinsVer++;
    this._sig = '';
  }

  // Canc/Backspace col tab Marionetta attivo: via le puntine selezionate.
  /** @returns {boolean} true se ha consumato il tasto */
  deletePins() {
    const s = this._session, pup = s ? s.pup : null;
    if (this.mode !== 'puppet' || !pup || !pup.mesh) return false;
    const sel = pup.pins.filter((p) => p.sel);
    if (sel.length === 0) return false;
    for (const p of sel) this._deletePin(p.id);
    return true;
  }

  // Select Ruota (Auto/Fisso) o campo gradi cambiati: si applica alle
  // puntine selezionate.
  _pupRotChanged() {
    const s = this._session, pup = s ? s.pup : null;
    if (!pup || !pup.mesh) return;
    const fixed = this._ppRot.value === 'fixed';
    const rot = (Number(this._ppAng.value) || 0) * Math.PI / 180;
    let any = false;
    for (const p of pup.pins) {
      if (!p.sel) continue;
      p.fixed = fixed;
      if (fixed) p.rot = rot;
      any = true;
    }
    if (!any) return;
    pup.solver.setPins(pup.pins);
    this._pupWake();
  }

  // Riflette nel campo Ruota la prima puntina selezionata (chiamato dal
  // gizmo quando puntine/selezione cambiano).
  /** @param {PupState} pup */
  _pupReflectRot(pup) {
    const sel = pup.pins.find((p) => p.sel);
    const en = !!sel;
    if (this._ppRot.disabled === en) {
      this._ppRot.disabled = !en;
      this._ppAng.disabled = !en;
    }
    if (!sel) return;
    if (this._ppRot.value !== (sel.fixed ? 'fixed' : 'auto')) {
      this._ppRot.value = sel.fixed ? 'fixed' : 'auto';
    }
    if (document.activeElement !== this._ppAng) {
      const deg = Math.round((sel.fixed ? sel.rot : sel.ang) * 180 / Math.PI);
      this._ppAng.value = String(deg);
    }
  }

  _syncOpts() {
    for (const [mode, btn] of this._tabBtns) {
      const active = this.mode === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    this._gridWrap.hidden = this.mode !== 'warp';
    this._pupOpts.hidden = this.mode !== 'puppet';
    if (this.mode === 'puppet') {
      this._ppMode.value = this._pupMode;
      this._ppShowMesh.checked = this._pupShowMesh;
    }
    this._syncPupAction();
    const n = this._session ? this._session.gridN : this._gridN;
    for (const b of this._gridBtns) {
      b.classList.toggle('active', Number(b.dataset.n) === n);
    }
    this._syncSmartGuidesButton();
  }

  /** @param {TfSession} s */
  _precisionMetrics(s) {
    const box = this._boxFor(s);
    return {
      x: box.x0,
      y: box.y0,
      w: Math.abs(s.bw * s.sx),
      h: Math.abs(s.bh * s.sy),
      rot: s.theta * DEG,
    };
  }

  /** @param {number} v */
  _precisionText(v) {
    if (!Number.isFinite(v)) return '';
    const r = Math.round(v);
    return Math.abs(v - r) < 0.01 ? String(r) : String(Math.round(v * 10) / 10);
  }

  /** @param {HTMLInputElement} input @param {number} v */
  _setPrecisionInput(input, v) {
    if (document.activeElement === input) return;
    input.value = this._precisionText(v);
  }

  _syncPrecision() {
    const s = this._session;
    const show = !!s && this.mode === 'affine';
    if (this._precisionWrap) this._precisionWrap.hidden = !show;
    if (this._alignWrap) this._alignWrap.hidden = !show;
    if (!show) return;
    const m = this._precisionMetrics(s);
    for (const key of PRECISION_FIELDS) {
      this._setPrecisionInput(this._precisionInputs[key], m[key]);
    }
    this._precisionInputs.rot.disabled = s.kind === 'text' || s.hasText;
    const ratioOn = this._ratioLocked || s.kind === 'text' || s.hasText;
    this._ratioBtn.classList.toggle('active', ratioOn);
    this._ratioBtn.setAttribute('aria-pressed', ratioOn ? 'true' : 'false');
    for (const b of this._distributeBtns || []) b.disabled = s.items.length < 3;
  }

  /** @param {TfSession} s */
  _applyLiveForm(s) {
    if (s.kind === 'text') this._applyText();
    if (s.kind === 'svg') this._applySvg();
    if (s.kind === 'multi') this._applyMultiLive();
  }

  _afterPrecisionChange() {
    const s = this._session;
    if (!s) return;
    this._applyLiveForm(s);
    this._clearSmartGuides();
    this._sig = '';
    this._syncPrecision();
    this._emitLive(true);
    this.app.requestFrame();
  }

  /** @param {'w'|'h'} field @param {number} target */
  _setPrecisionSize(field, target) {
    const s = this._session;
    if (!s || !Number.isFinite(target) || target <= 0) return;
    const curW = Math.max(0.001, Math.abs(s.bw * s.sx));
    const curH = Math.max(0.001, Math.abs(s.bh * s.sy));
    const locked = this._ratioLocked || s.kind === 'text' || s.hasText;
    const signX = s.sx < 0 ? -1 : 1;
    const signY = s.sy < 0 ? -1 : 1;
    if (locked) {
      const k = field === 'w' ? target / curW : target / curH;
      s.sx *= k;
      s.sy *= k;
      return;
    }
    if (field === 'w') s.sx = signX * target / Math.max(1, s.bw);
    else s.sy = signY * target / Math.max(1, s.bh);
  }

  /** @param {string} field */
  _applyPrecisionField(field) {
    const s = this._session;
    if (!s || this.mode !== 'affine') return;
    const input = this._precisionInputs[field];
    if (!input || input.disabled) return;
    const v = Number.parseFloat(input.value);
    if (!Number.isFinite(v)) {
      this._syncPrecision();
      return;
    }
    const before = this._boxFor(s);
    if (field === 'x') {
      s.tx += v - before.x0;
    } else if (field === 'y') {
      s.ty += v - before.y0;
    } else if (field === 'w' || field === 'h') {
      this._setPrecisionSize(/** @type {'w'|'h'} */ (field), Math.max(1, v));
      const after = this._boxFor(s);
      s.tx += before.x0 - after.x0;
      s.ty += before.y0 - after.y0;
    } else if (field === 'rot') {
      if (s.kind === 'text' || s.hasText) return;
      s.theta = v * RAD;
    }
    this._afterPrecisionChange();
  }

  /** @param {string} mode */
  _alignToCanvas(mode) {
    const s = this._session;
    const board = s ? this.app.boards.byId(s.boardId) : null;
    if (!s || !board || this.mode !== 'affine') return;
    const box = this._boxFor(s);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = board.x - box.x0;
    else if (mode === 'hcenter') dx = board.x + board.w / 2 - box.cx;
    else if (mode === 'right') dx = board.x + board.w - box.x1;
    else if (mode === 'top') dy = board.y - box.y0;
    else if (mode === 'vcenter') dy = board.y + board.h / 2 - box.cy;
    else if (mode === 'bottom') dy = board.y + board.h - box.y1;
    else return;
    s.tx += dx;
    s.ty += dy;
    this._afterPrecisionChange();
  }

  /** @param {string} axis */
  _distributeSelection(axis) {
    if (axis !== 'h' && axis !== 'v') return;
    if (this.pending) this.confirm();
    const app = this.app;
    const board = app.boards.active;
    if (!board) return;
    const layers = app.layerMgr.selectedLayers
      .filter((layer) => layer.visible && layer.opacity > 0)
      .map((layer) => ({ layer, item: this._itemForLayer(layer) }))
      .filter((entry) => entry.item);
    if (layers.length < 3) return;
    const start = axis === 'h' ? (entry) => entry.item.bx : (entry) => entry.item.by;
    const size = axis === 'h' ? (entry) => entry.item.bw : (entry) => entry.item.bh;
    layers.sort((a, b) => start(a) - start(b));
    const first = layers[0], last = layers[layers.length - 1];
    const span = start(last) + size(last) - start(first);
    const total = layers.reduce((sum, entry) => sum + size(entry), 0);
    const gap = (span - total) / (layers.length - 1);
    let cursor = start(first) + size(first) + gap;
    const clip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => app.renderer.disposeChunkTex(c);
    for (let i = 1; i < layers.length - 1; i++) {
      const { layer, item } = layers[i];
      const delta = cursor - start(layers[i]);
      const dx = axis === 'h' ? delta : 0;
      const dy = axis === 'v' ? delta : 0;
      cursor += size(layers[i]) + gap;
      if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) continue;
      if (item.kind === 'raster' && layer.store) {
        const ix = Math.round(dx), iy = Math.round(dy);
        if (ix === 0 && iy === 0) continue;
        const wrap = !!app.patternMode;
        const lost = wrap
          ? translateStoreWrapped(layer.store, ix, iy, clip, dispose)
          : translateStore(layer.store, ix, iy, clip, dispose);
        app.undoMgr.pushMove(/** @type {any} */ (
          { layerId: item.layerId, dx: ix, dy: iy, boardId: board.id, chunks: lost, wrap }));
      } else if (item.kind === 'text' && layer.item) {
        const x0 = layer.item.x, y0 = layer.item.y, s0 = layer.item.size;
        layer.item.x += dx;
        layer.item.y += dy;
        touchText(layer);
        app.undoMgr.pushStruct(/** @type {any} */ ({
          op: 'textform', layerId: item.layerId, boardId: board.id,
          x0, y0, s0, x1: layer.item.x, y1: layer.item.y, s1: layer.item.size,
        }));
      } else if (item.kind === 'svg' && layer.kind === 'svg' && layer.svgItem) {
        const m0 = /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice());
        layer.svgItem.m = multiplyMatrix([1, 0, 0, 1, dx, dy], m0);
        touchSvg(layer);
        app.undoMgr.pushStruct(/** @type {any} */ ({
          op: 'svgform', layerId: item.layerId, boardId: board.id,
          tm0: m0, tm1: /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice()),
        }));
      }
      layer.thumbDirty = true;
    }
    this.rebind();
    app.ui.layersUI.scheduleThumbs();
    app.planes.invalidate();
    app.requestFrame();
  }

  /** @param {'move'|'rotate'} action */
  _setPupAction(action) {
    if (this._pupAction === action) return;
    this._pupAction = action;
    this._drag = null;
    this._syncPupAction();
  }

  _syncPupAction() {
    for (const [action, btn] of this._ppActionBtns) {
      const active = this._pupAction === action;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  _loadSmartGuides() {
    try { return localStorage.getItem(SMART_GUIDE_KEY) !== '0'; }
    catch { return true; }
  }

  /** @param {boolean} on */
  setSmartGuides(on) {
    this.smartGuides = !!on;
    try { localStorage.setItem(SMART_GUIDE_KEY, this.smartGuides ? '1' : '0'); }
    catch { /* storage non disponibile */ }
    if (!this.smartGuides) this._clearSmartGuides();
    this._syncSmartGuidesButton();
    this._sig = '';
    this.app.requestFrame();
  }

  _syncSmartGuidesButton() {
    if (!this._smartBtn) return;
    this._smartBtn.classList.toggle('active', this.smartGuides);
    this._smartBtn.setAttribute('aria-pressed', this.smartGuides ? 'true' : 'false');
  }

  _target() {
    const app = this.app;
    if (app.collab && app.collab.remoteTransformActive) return null;
    const board = app.boards.active;
    const mgr = app.layerMgr;
    const layers = mgr.selectedLayers.filter((layer) => layer.visible && layer.opacity > 0);
    if (!board || layers.length === 0) return null;
    if (app.renderer.contextLost) return null;
    return { board, layers, sig: layers.map((layer) => layer.id).join(',') };
  }

  // La sessione corrente non vale più (undo, struttura cambiata): si chiude
  // SENZA commit — da chiamare solo a trasformazione identità.
  rebind() {
    this._session = null;
    this._drag = null;
    this._smartRefs = null;
    this._emptyKey = '';
    this._endLive();
  }

  /** @param {Layer} layer @returns {TfItem|null} */
  _itemForLayer(layer) {
    /** @type {TfItem} */
    const item = {
      layerId: layer.id, kind: layer.kind,
      bx: 0, by: 0, bw: 0, bh: 0,
      texX: 0, texY: 0, texW: 0, texH: 0,
      ix0: 0, iy0: 0, s0: 0, m0: [1, 0, 0, 1, 0, 0],
    };
    if (layer.kind === 'raster') {
      if (!layer.store) return null;
      const bb = contentBBox(layer.store);
      if (!bb) return null;
      item.bx = bb.x0; item.by = bb.y0;
      item.bw = bb.x1 - bb.x0 + 1; item.bh = bb.y1 - bb.y0 + 1;
      item.texX = (bb.x0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      item.texY = (bb.y0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      item.texW = (((bb.x1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - item.texX;
      item.texH = (((bb.y1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - item.texY;
      return item;
    }
    if (layer.kind === 'text') {
      if (!layer.item.text) return null;
      const box = blockBox(layer.item, layer.style);
      item.bx = box.x; item.by = box.y; item.bw = box.w; item.bh = box.h;
      item.ix0 = layer.item.x; item.iy0 = layer.item.y; item.s0 = layer.item.size;
      return item;
    }
    if (!layer.svgItem) return null;
    const box = svgWorldBox(layer.svgItem);
    if (!box) return null;
    item.bx = box.x; item.by = box.y; item.bw = box.w; item.bh = box.h;
    item.m0 = /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice());
    return item;
  }

  /** @param {{board: import('./boards.js').Board, layers: Layer[], sig: string}} target */
  _beginTarget(target) {
    if (target.layers.length === 1) {
      this._begin(target.board, target.layers[0], target.sig);
      return;
    }
    if (target.layers.some((layer) => layer.kind === 'raster')) this.app._flushPendingStroke();
    /** @type {TfItem[]} */
    const items = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const layer of target.layers) {
      const item = this._itemForLayer(layer);
      if (!item) continue;
      items.push(item);
      x0 = Math.min(x0, item.bx);
      y0 = Math.min(y0, item.by);
      x1 = Math.max(x1, item.bx + item.bw);
      y1 = Math.max(y1, item.by + item.bh);
    }
    if (items.length === 1) {
      const layer = target.layers.find((l) => l.id === items[0].layerId);
      if (layer) this._begin(target.board, layer, target.sig);
      return;
    }
    if (items.length < 2) return;
    /** @type {TfSession} */
    const s = {
      layerId: this.app.layerMgr.activeId, boardId: target.board.id, kind: 'multi',
      targetSig: target.sig, items, hasText: items.some((item) => item.kind === 'text'),
      stamp: ++this._stamp,
      bx: x0, by: y0, bw: x1 - x0, bh: y1 - y0, cx: 0, cy: 0,
      tx: 0, ty: 0, theta: 0, sx: 1, sy: 1,
      texX: 0, texY: 0, texW: 0, texH: 0,
      ix0: 0, iy0: 0, s0: 0, m0: [1, 0, 0, 1, 0, 0],
      gridN: this._gridN, wpts: null, wver: 0, won: false,
      ppts: null, pver: 0, pon: false,
      pup: null,
    };
    s.cx = s.bx + s.bw / 2;
    s.cy = s.by + s.bh / 2;
    this._session = s;
    this._smartRefs = null;
    if (this.mode !== 'affine') {
      this.mode = 'affine';
      this._syncOpts();
      this._sig = '';
    }
    this._keepMode = false;
  }

  /** @param {import('./boards.js').Board} board @param {Layer} layer @param {string} [targetSig] */
  _begin(board, layer, targetSig = String(layer.id)) {
    /** @type {TfSession} */
    const s = {
      layerId: layer.id, boardId: board.id, kind: layer.kind,
      targetSig, items: [], hasText: layer.kind === 'text',
      stamp: ++this._stamp,
      bx: 0, by: 0, bw: 0, bh: 0, cx: 0, cy: 0,
      tx: 0, ty: 0, theta: 0, sx: 1, sy: 1,
      texX: 0, texY: 0, texW: 0, texH: 0,
      ix0: 0, iy0: 0, s0: 0, m0: [1, 0, 0, 1, 0, 0],
      gridN: this._gridN, wpts: null, wver: 0, won: false,
      ppts: null, pver: 0, pon: false,
      pup: null,
    };
    if (layer.kind === 'raster') {
      const k = layer.id + '|' + layer.store.ver;
      if (this._emptyKey === k) return;
      // un commit in volo scriverebbe pixel sotto la fotografia
      this.app._flushPendingStroke();
      const bb = contentBBox(layer.store);
      if (!bb) { this._emptyKey = k; return; }
      this._emptyKey = '';
      s.bx = bb.x0; s.by = bb.y0;
      s.bw = bb.x1 - bb.x0 + 1; s.bh = bb.y1 - bb.y0 + 1;
      // hull chunk-aligned: è la texture dell'anteprima e l'hull del commit
      s.texX = (bb.x0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      s.texY = (bb.y0 >> CHUNK_SHIFT) << CHUNK_SHIFT;
      s.texW = (((bb.x1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - s.texX;
      s.texH = (((bb.y1 >> CHUNK_SHIFT) + 1) << CHUNK_SHIFT) - s.texY;
    } else if (layer.kind === 'text') {
      if (!layer.item.text) return;
      const box = blockBox(layer.item, layer.style);
      s.bx = box.x; s.by = box.y; s.bw = box.w; s.bh = box.h;
      s.ix0 = layer.item.x; s.iy0 = layer.item.y; s.s0 = layer.item.size;
    } else {
      if (!layer.svgItem) return;
      const box = svgWorldBox(layer.svgItem);
      if (!box) return;
      s.bx = box.x; s.by = box.y; s.bw = box.w; s.bh = box.h;
      s.m0 = /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice());
    }
    s.items = [{
      layerId: layer.id, kind: layer.kind,
      bx: s.bx, by: s.by, bw: s.bw, bh: s.bh,
      texX: s.texX, texY: s.texY, texW: s.texW, texH: s.texH,
      ix0: s.ix0, iy0: s.iy0, s0: s.s0,
      m0: /** @type {[number, number, number, number, number, number]} */ (s.m0.slice()),
    }];
    s.cx = s.bx + s.bw / 2;
    s.cy = s.by + s.bh / 2;
    this._session = s;
    this._smartRefs = null;
    // ogni sessione nuova riparte dal tab Trasforma (come Photoshop) —
    // tranne dopo il salto warp↔prospettiva: lì il tab scelto resta
    if (this.mode !== 'affine' && !this._keepMode) {
      this.mode = 'affine';
      this._syncOpts();
      this._sig = '';
    }
    this._keepMode = false;
    this._emitLive(true);
  }

  // Frame per planes/renderer: il livello si presenta come quad trasformato
  // (o come mesh quando la griglia warp non è a riposo).
  /** @returns {TransformFrame|TransformFrame[]|null} */
  frame() {
    const s = this._session;
    if (!s) return null;
    const b = this.app.boards.byId(s.boardId);
    if (!b) return null;
    if (s.kind === 'multi') {
      const m = this._matrix(s);
      const frames = [];
      for (const item of s.items) {
        if (item.kind !== 'raster') continue;
        const layer = this.app.boards.layerById(item.layerId);
        if (!layer || !layer.store) continue;
        frames.push({
          id: `${s.stamp}:${item.layerId}`, layerId: item.layerId, store: layer.store,
          x: item.texX, y: item.texY, w: item.texW, h: item.texH,
          m, warp: null, persp: null, puppet: null,
          clip: { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 },
        });
      }
      return frames.length > 0 ? frames : null;
    }
    if (s.kind !== 'raster') return null;
    const layer = this.app.boards.layerById(s.layerId);
    if (!layer || !layer.store) return null;
    return {
      id: s.stamp, layerId: s.layerId, store: layer.store,
      x: s.texX, y: s.texY, w: s.texW, h: s.texH,
      m: this._matrix(s),
      warp: s.wpts && s.won
        ? { pts: s.wpts, n: s.gridN, ver: s.wver, bx: s.bx, by: s.by, bw: s.bw, bh: s.bh }
        : null,
      persp: s.ppts && s.pon
        ? { q: s.ppts, ver: s.pver, bx: s.bx, by: s.by, bw: s.bw, bh: s.bh }
        : null,
      puppet: this.mode === 'puppet' && s.pup && s.pup.mesh && s.pup.on
        ? {
          pos: s.pup.def, uv: s.pup.uv, idx: s.pup.idx,
          pos0: s.pup.mesh.pos0, tris: s.pup.mesh.tris, order: s.pup.order,
          ver: s.pup.ver, meshVer: s.pup.meshVer,
        }
        : null,
      clip: { x0: b.x, y0: b.y, x1: b.x + b.w - 1, y1: b.y + b.h - 1 },
    };
  }

  // ---- gesto sul canvas (via hook stroke): traslazione o, in modalità
  // warp DENTRO la superficie, spinta della superficie (alla Photoshop:
  // si afferra l'immagine ovunque e quel punto segue il dito) ----
  /** @param {number} x @param {number} y mondo */
  dragStart(x, y) {
    const s = this._session;
    if (!s) return;
    this._smartRefs = null;
    if (this.mode === 'puppet' && s.kind === 'raster' && s.pup) {
      // marionetta: il canvas pianta puntine, niente traslazione
      this._puppetDown(x, y);
      return;
    }
    if (this.mode === 'warp' && s.kind === 'raster' && s.wpts && this._overWarp(x, y)) {
      const uv = warpUvAt(s.wpts, s.gridN,
        { x: s.bx, y: s.by, w: s.bw, h: s.bh }, this._matrix(s), x, y);
      this._drag = {
        kind: 'push', gx: x, gy: y,
        tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy,
        pts0: s.wpts.slice(),
        w: warpPushWeights(s.gridN, uv.u, uv.v),
      };
      return;
    }
    this._drag = { kind: 'pan', gx: x, gy: y, tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy };
  }

  // Il punto è sopra la superficie warp? Basta la bbox mondo dei punti di
  // controllo: per la proprietà dell'inviluppo convesso la contiene sempre.
  /** @param {number} x @param {number} y */
  _overWarp(x, y) {
    const s = this._session, m = this._matrix(s);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < s.wpts.length; k += 2) {
      const lx = s.bx + s.wpts[k] * s.bw, ly = s.by + s.wpts[k + 1] * s.bh;
      const wx = m[0] * lx + m[2] * ly + m[4], wy = m[1] * lx + m[3] * ly + m[5];
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    }
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }

  /** @param {number} x @param {number} y mondo */
  dragMove(x, y) {
    const d = this._drag, s = this._session;
    if (!d || !s) return;
    if (d.kind === 'pin') {
      // tutte le puntine selezionate seguono il delta del gesto; il solver
      // gira nel tick di frame
      const pup = s.pup;
      if (!pup) return;
      const dx = x - d.gx, dy = y - d.gy;
      for (const p of pup.pins) {
        const t0 = d.pins0.get(p.id);
        if (!t0) continue;
        p.tx = t0.tx + dx;
        p.ty = t0.ty + dy;
      }
      pup.relax = 45;
      return;
    }
    if (d.kind === 'pinrot') {
      const pup = s.pup;
      if (!pup) return;
      this._rotatePinDrag(pup, d, x, y, null, null);
      return;
    }
    if (d.kind === 'push') {
      const loc = this._deltaLocal(s, x - d.gx, y - d.gy);
      if (!loc) return;
      const pts = s.wpts, w = d.w;
      pts.set(d.pts0);
      for (let k = 0; k < w.length; k++) {
        pts[k * 2] += loc.x * w[k];
        pts[k * 2 + 1] += loc.y * w[k];
      }
      s.wver++;
      s.won = !latticeIdentity(pts, s.gridN);
      return;
    }
    if (d.kind !== 'pan') return;
    // snap a pixel interi: la sola-traslazione resta bit-exact al commit
    const snapped = this._snapMove(Math.round(d.tx0 + (x - d.gx)), Math.round(d.ty0 + (y - d.gy)));
    s.tx = snapped.tx;
    s.ty = snapped.ty;
    if (s.kind === 'text') this._applyText();
    if (s.kind === 'svg') this._applySvg();
    if (s.kind === 'multi') this._applyMultiLive();
  }

  _smartThresholdWorld() {
    const z = Math.max(0.001, this.app.camera.zoom || 1);
    return Math.max(SMART_GUIDE_MIN_WORLD, Math.min(SMART_GUIDE_MAX_WORLD, SMART_GUIDE_SNAP_PX / z));
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
  _guideBox(x0, y0, x1, y1) {
    return {
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
    };
  }

  /** @param {{x0:number,y0:number,x1:number,y1:number,cx:number,cy:number}} ref @param {'x'|'y'} axis */
  _guideTargets(ref, axis) {
    return axis === 'x' ? [ref.x0, ref.cx, ref.x1] : [ref.y0, ref.cy, ref.y1];
  }

  /** @param {TfSession} s @param {import('./boards.js').Board} board */
  _smartReferenceBoxes(s, board) {
    if (this._smartRefs) return this._smartRefs;
    const refs = [this._guideBox(board.x, board.y, board.x + board.w, board.y + board.h)];
    const moving = new Set(s.items.length ? s.items.map((item) => item.layerId) : [s.layerId]);
    for (const layer of board.mgr.layers) {
      if (moving.has(layer.id) || !layer.visible || layer.opacity <= 0) continue;
      let box = null;
      if (layer.kind === 'raster' && layer.store) {
        const bb = contentBBox(layer.store);
        if (bb) box = { x0: bb.x0, y0: bb.y0, x1: bb.x1 + 1, y1: bb.y1 + 1 };
      } else if (layer.kind === 'text' && layer.item && layer.style && layer.item.text) {
        const bb = blockBox(layer.item, layer.style);
        box = { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h };
      } else if (layer.kind === 'svg' && layer.svgItem) {
        const bb = svgWorldBox(layer.svgItem);
        if (bb) box = { x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h };
      }
      if (!box || box.x1 <= box.x0 || box.y1 <= box.y0) continue;
      refs.push(this._guideBox(box.x0, box.y0, box.x1, box.y1));
    }
    this._smartRefs = refs;
    return refs;
  }

  /** @param {TfSession} s @param {number} tx @param {number} ty @param {number} sx @param {number} sy @param {number} theta */
  _matrixFrom(s, tx, ty, sx, sy, theta) {
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const a = sx * cos, b = sx * sin, c = -sy * sin, d = sy * cos;
    return [a, b, c, d,
      s.cx + tx - a * s.cx - c * s.cy,
      s.cy + ty - b * s.cx - d * s.cy];
  }

  /** @param {TfSession} s @param {number} [tx] @param {number} [ty] @param {number} [sx] @param {number} [sy] @param {number} [theta] */
  _boxFor(s, tx = s.tx, ty = s.ty, sx = s.sx, sy = s.sy, theta = s.theta) {
    const m = this._matrixFrom(s, tx, ty, sx, sy, theta);
    const x0 = s.bx, y0 = s.by, x1 = s.bx + s.bw, y1 = s.by + s.bh;
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      const wx = m[0] * x + m[2] * y + m[4];
      const wy = m[1] * x + m[3] * y + m[5];
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    }
    return {
      x0: minX, y0: minY, x1: maxX, y1: maxY,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    };
  }

  /** @param {import('./boards.js').Board} board @param {number[]} [v] @param {number[]} [h] */
  _setGuideState(board, v = [], h = []) {
    this._guideState = { board, v, h };
  }

  _clearSmartGuides() {
    this._guideState = null;
    if (this.guideEl) this.guideEl.setAttribute('d', '');
  }

  /** @param {number} tx @param {number} ty */
  _snapMove(tx, ty) {
    const s = this._session;
    const board = s ? this.app.boards.byId(s.boardId) : null;
    if (!s || !board || !this.smartGuides || this.mode !== 'affine') {
      this._clearSmartGuides();
      return { tx, ty };
    }
    const th = this._smartThresholdWorld();
    const refs = this._smartReferenceBoxes(s, board);
    let box = this._boxFor(s, tx, ty);
    let bestX = null, bestY = null;
    const anchorsX = [box.x0, box.cx, box.x1];
    const anchorsY = [box.y0, box.cy, box.y1];
    for (const a of anchorsX) {
      for (const ref of refs) {
        for (const t of this._guideTargets(ref, 'x')) {
          const delta = t - a, dist = Math.abs(delta);
          if (dist <= th && (!bestX || dist < bestX.dist)) bestX = { dist, delta, target: t };
        }
      }
    }
    for (const a of anchorsY) {
      for (const ref of refs) {
        for (const t of this._guideTargets(ref, 'y')) {
          const delta = t - a, dist = Math.abs(delta);
          if (dist <= th && (!bestY || dist < bestY.dist)) bestY = { dist, delta, target: t };
        }
      }
    }
    const integerMove = s.kind === 'raster' &&
      Math.abs(s.theta) < 1e-9 && Math.abs(s.sx - 1) < 1e-9 && Math.abs(s.sy - 1) < 1e-9;
    if (bestX) tx = integerMove ? Math.round(tx + bestX.delta) : tx + bestX.delta;
    if (bestY) ty = integerMove ? Math.round(ty + bestY.delta) : ty + bestY.delta;
    this._setGuideState(board, bestX ? [bestX.target] : [], bestY ? [bestY.target] : []);
    return { tx, ty };
  }

  /** @param {string} kind @param {TfSession} s */
  _snapResize(kind, s) {
    const board = this.app.boards.byId(s.boardId);
    if (!board || !this.smartGuides || this.mode !== 'affine' || kind === 'rot') {
      this._clearSmartGuides();
      return;
    }
    if (CORNER.has(kind)) {
      this._setGuideState(board);
      return;
    }
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const axisAligned = Math.abs(sin) < 1e-5 && Math.abs(cos) > 1e-5;
    if (!axisAligned) {
      this._setGuideState(board);
      return;
    }
    const refs = this._smartReferenceBoxes(s, board);
    const th = this._smartThresholdWorld();
    const pcx = s.cx + s.tx, pcy = s.cy + s.ty;
    const left = s.bx - s.cx, right = s.bx + s.bw - s.cx;
    const top = s.by - s.cy, bottom = s.by + s.bh - s.cy;
    /** @type {{dist:number, axis:'x'|'y', target:number, sx:number, sy:number}|null} */
    let best = null;
    const addCandidate = (axis, local, target) => {
      const denom = local * cos;
      if (Math.abs(denom) < 1e-9) return;
      const current = axis === 'x' ? pcx + s.sx * denom : pcy + s.sy * denom;
      const dist = Math.abs(target - current);
      if (dist > th) return;
      const snappedScale = axis === 'x' ? (target - pcx) / denom : (target - pcy) / denom;
      let sx = s.sx, sy = s.sy;
      if (axis === 'x') {
        if (Math.abs(snappedScale) < 0.0001) return;
        sx = snappedScale;
      } else {
        if (Math.abs(snappedScale) < 0.0001) return;
        sy = snappedScale;
      }
      if (!best || dist < best.dist) best = { dist, axis, target, sx, sy };
    };
    const wantsLeft = kind === 'lm' || kind === 'tl' || kind === 'bl';
    const wantsRight = kind === 'rm' || kind === 'tr' || kind === 'br';
    const wantsTop = kind === 'tm' || kind === 'tl' || kind === 'tr';
    const wantsBottom = kind === 'bm' || kind === 'bl' || kind === 'br';
    if (wantsLeft) for (const ref of refs) for (const t of this._guideTargets(ref, 'x')) addCandidate('x', left, t);
    if (wantsRight) for (const ref of refs) for (const t of this._guideTargets(ref, 'x')) addCandidate('x', right, t);
    if (wantsTop) for (const ref of refs) for (const t of this._guideTargets(ref, 'y')) addCandidate('y', top, t);
    if (wantsBottom) for (const ref of refs) for (const t of this._guideTargets(ref, 'y')) addCandidate('y', bottom, t);
    if (best) {
      s.sx = best.sx;
      s.sy = best.sy;
    }
    this._setGuideState(board,
      best && best.axis === 'x' ? [best.target] : [],
      best && best.axis === 'y' ? [best.target] : []);
  }

  // Delta MONDO → unità bbox pre-affine (inversa della parte lineare di T):
  // i gesti warp restano sotto il dito anche con sessione ruotata/scalata.
  /** @param {TfSession} s @param {number} dx @param {number} dy */
  _deltaLocal(s, dx, dy) {
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const a = s.sx * cos, b = s.sx * sin, c = -s.sy * sin, d = s.sy * cos;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;
    return {
      x: (d * dx - c * dy) / det / s.bw,
      y: (-b * dx + a * dy) / det / s.bh,
    };
  }

  dragEnd() {
    this._drag = null;
    this._smartRefs = null;
    this._clearSmartGuides();
    this._sig = '';
  }

  // Secondo dito (gesture camera): il GESTO si annulla, la sessione resta.
  dragCancel() {
    const d = this._drag, s = this._session;
    if (d && s && d.kind === 'pan') {
      s.tx = d.tx0;
      s.ty = d.ty0;
      if (s.kind === 'text') this._applyText();
      if (s.kind === 'svg') this._applySvg();
    }
    if (d && s && d.kind === 'push' && s.wpts) {
      s.wpts.set(d.pts0);
      s.wver++;
      s.won = !latticeIdentity(s.wpts, s.gridN);
    }
    if (d && s && d.kind === 'pin' && s.pup) {
      for (const p of s.pup.pins) {
        const t0 = d.pins0.get(p.id);
        if (!t0) continue;
        p.tx = t0.tx;
        p.ty = t0.ty;
      }
      s.pup.relax = 45;
    }
    if (d && s && d.kind === 'pinrot' && s.pup) {
      const pin = s.pup.pins.find((p) => p.id === d.pinId);
      if (pin) {
        pin.fixed = !!d.fixed0;
        if (d.fixed0) pin.rot = d.rot0;
        s.pup.solver.setPins(s.pup.pins);
        s.pup.relax = 45;
        s.pup.pinsVer++;
      }
    }
    this._drag = null;
    this._smartRefs = null;
    this._clearSmartGuides();
    this._sig = '';
  }

  /** @returns {any} frame serializzabile per la preview remota */
  _liveFrame() {
    const f = this.frame();
    if (!f) return null;
    return {
      id: f.id, layerId: f.layerId,
      x: f.x, y: f.y, w: f.w, h: f.h,
      m: f.m.slice(),
      clip: { ...f.clip },
      warp: f.warp ? {
        pts: f.warp.pts.slice(), n: f.warp.n, ver: f.warp.ver,
        bx: f.warp.bx, by: f.warp.by, bw: f.warp.bw, bh: f.warp.bh,
      } : null,
      persp: f.persp ? {
        q: f.persp.q.slice(), ver: f.persp.ver,
        bx: f.persp.bx, by: f.persp.by, bw: f.persp.bw, bh: f.persp.bh,
      } : null,
      puppet: f.puppet ? {
        pos: f.puppet.pos.slice(),
        uv: f.puppet.uv.slice(),
        idx: f.puppet.idx.slice(),
        pos0: f.puppet.pos0.slice(),
        tris: f.puppet.tris.slice(),
        order: f.puppet.order.slice(),
        ver: f.puppet.ver,
        meshVer: f.puppet.meshVer,
      } : null,
    };
  }

  _liveSignature() {
    const s = this._session;
    if (!s) return '';
    const pup = s.pup;
    return `${s.layerId}|${this.mode}|${s.tx}|${s.ty}|${s.theta}|${s.sx}|${s.sy}|` +
      `${s.gridN}|${s.wver}|${s.won ? 1 : 0}|${s.pver}|${s.pon ? 1 : 0}|` +
      (pup ? `${pup.ver}|${pup.pinsVer}|${pup.meshVer}|${pup.on ? 1 : 0}|${pup.pins.length}` : '');
  }

  /** @param {boolean} [force] */
  _emitLive(force = false) {
    const collab = this.app.collab;
    if (!collab || !collab.active || collab.remoteTransformActive) return;
    const s = this._session;
    if (!s || s.kind !== 'raster') return;
    const sig = this._liveSignature();
    const now = performance.now();
    if (!force && sig === this._liveSig) return;
    if (!force && now < this._liveNext) return;
    this._liveSig = sig;
    this._liveNext = now + 50;
    collab.transformLive(this._liveFrame());
  }

  _endLive() {
    const collab = this.app.collab;
    if (this._liveSig && collab && collab.active) collab.transformDone();
    this._liveSig = '';
    this._liveNext = 0;
  }

  _guideSignature() {
    const g = this._guideState;
    if (!g || !this.smartGuides || !this._drag) return '';
    const f = (n) => Math.round(n * 100) / 100;
    return `${g.board.id}|${g.v.map(f).join(',')}|${g.h.map(f).join(',')}`;
  }

  /** @param {import('./camera.js').Camera} cam */
  _drawSmartGuides(cam) {
    const g = this._guideState;
    if (!g || !this.smartGuides || !this._drag) {
      if (this.guideEl.getAttribute('d')) this.guideEl.setAttribute('d', '');
      return;
    }
    const b = g.board;
    const P = (x, y) => cam.worldToScreen(x, y, { x: 0, y: 0 });
    let d = '';
    for (const x of g.v) {
      const a = P(x, b.y), z = P(x, b.y + b.h);
      d += `M ${a.x} ${a.y} L ${z.x} ${z.y} `;
    }
    for (const y of g.h) {
      const a = P(b.x, y), z = P(b.x + b.w, y);
      d += `M ${a.x} ${a.y} L ${z.x} ${z.y} `;
    }
    this.guideEl.setAttribute('d', d);
  }

  // ---- gesti sulle maniglie (eventi DOM del gizmo) ----
  /** @param {PointerEvent} e @param {string} key */
  _handleDown(e, key) {
    const s = this._session;
    if (!s) return;
    if ((s.kind === 'text' || s.hasText) && !CORNER.has(key)) return; // testo: solo angoli
    this._smartRefs = null;
    const tgt = /** @type {SVGCircleElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    this._drag = {
      kind: key, gx: this._tmp.x, gy: this._tmp.y,
      tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy,
    };
  }

  /** @param {PointerEvent} e */
  _handleMove(e) {
    const d = this._drag, s = this._session;
    if (!d || !s || d.kind === 'pan') return;
    e.preventDefault();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    const px = this._tmp.x, py = this._tmp.y;
    // pivot corrente nel mondo: c + t (R·S non lo spostano)
    const pcx = s.cx + s.tx, pcy = s.cy + s.ty;
    if (d.kind === 'rot') {
      if (s.hasText) return;
      let th = d.th0 + Math.atan2(py - pcy, px - pcx) - Math.atan2(d.gy - pcy, d.gx - pcx);
      // aggancio ai multipli di 90°: a 0 si torna al commit senza perdita
      const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(th - q) < ROT_SNAP) th = q;
      s.theta = th;
      this._clearSmartGuides();
      if (s.kind === 'svg') this._applySvg();
      if (s.kind === 'multi') this._applyMultiLive();
      return;
    }
    if (CORNER.has(d.kind)) {
      // scala uniforme: rapporto delle distanze dal pivot
      const dn = Math.hypot(d.gx - pcx, d.gy - pcy);
      if (dn < 1e-6) return;
      let k = Math.hypot(px - pcx, py - pcy) / dn;
      if (s.kind === 'text') {
        k = Math.max(k, 2 / s.s0); // corpo minimo 2px
        s.sx = s.sy = d.sx0 * k;
        this._snapResize(d.kind, s);
        this._applyText();
        return;
      }
      s.sx = d.sx0 * k;
      s.sy = d.sy0 * k;
      this._snapResize(d.kind, s);
      if (s.kind === 'svg') this._applySvg();
      if (s.kind === 'multi') this._applyMultiLive();
      return;
    }
    // lati: stira lungo l'asse LOCALE della box (ruotato di θ); il segno
    // del rapporto può ribaltare il contenuto (flip), voluto
    const cos = Math.cos(s.theta), sin = Math.sin(s.theta);
    const ax = d.kind === 'lm' || d.kind === 'rm' ? cos : -sin;
    const ay = d.kind === 'lm' || d.kind === 'rm' ? sin : cos;
    const den = (d.gx - pcx) * ax + (d.gy - pcy) * ay;
    if (Math.abs(den) < 1e-6) return;
    const k = ((px - pcx) * ax + (py - pcy) * ay) / den;
    if (d.kind === 'lm' || d.kind === 'rm') s.sx = d.sx0 * k;
    else s.sy = d.sy0 * k;
    this._snapResize(d.kind, s);
    if (s.kind === 'svg') this._applySvg();
    if (s.kind === 'multi') this._applyMultiLive();
  }

  // ---- gesti sui punti di controllo warp (eventi DOM del gizmo) ----
  // Si ricreano quando la densità cambia. SOLO il bordo è visibile e
  // trascinabile (angoli + maniglie, alla Photoshop): i punti interni
  // esistono nel modello ma si muovono col drag-superficie.
  _rebuildWarpDots() {
    for (const d of this._warpDots) d.el.remove();
    this._warpDots.length = 0;
    const s = this._session;
    if (!s || !s.wpts) return;
    const np = s.gridN + 1;
    for (let i = 0; i < np; i++) {
      for (let j = 0; j < np; j++) {
        const outerR = i === 0 || i === np - 1, outerC = j === 0 || j === np - 1;
        if (!outerR && !outerC) continue;
        const kind = outerR && outerC ? 'corner' : 'edge';
        const k = i * np + j;
        const c = document.createElementNS(SVG_NS, 'circle');
        c.setAttribute('class', 'tg-warp tg-warp-' + kind);
        c.setAttribute('r', kind === 'corner' ? '7' : '5.5');
        c.addEventListener('pointerdown', (e) => this._warpDown(e, k));
        c.addEventListener('pointermove', (e) => this._warpMove(e));
        const up = () => { this._drag = null; };
        c.addEventListener('pointerup', up);
        c.addEventListener('pointercancel', up);
        this.svg.appendChild(c);
        this._warpDots.push({ el: c, k });
      }
    }
  }

  /** @param {PointerEvent} e @param {number} idx */
  _warpDown(e, idx) {
    const s = this._session;
    if (!s || !s.wpts) return;
    const tgt = /** @type {SVGCircleElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    this._drag = {
      kind: 'warp', idx, gx: this._tmp.x, gy: this._tmp.y,
      pts0: s.wpts.slice(),
      tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy,
    };
  }

  /** @param {PointerEvent} e */
  _warpMove(e) {
    const d = this._drag, s = this._session;
    if (!d || !s || d.kind !== 'warp' || !s.wpts) return;
    e.preventDefault();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    const loc = this._deltaLocal(s, this._tmp.x - d.gx, this._tmp.y - d.gy);
    if (!loc) return;
    // il punto si muove del delta totale dallo stato di partenza; un ANGOLO
    // porta con sé le sue due maniglie di bordo (alla Photoshop)
    const np = s.gridN + 1, n = s.gridN;
    const i = Math.floor(d.idx / np), j = d.idx % np;
    const move = [d.idx];
    if ((i === 0 || i === n) && (j === 0 || j === n)) {
      move.push(i * np + (j === 0 ? 1 : n - 1));
      move.push((i === 0 ? 1 : n - 1) * np + j);
    }
    s.wpts.set(d.pts0);
    for (const k of move) {
      s.wpts[k * 2] += loc.x;
      s.wpts[k * 2 + 1] += loc.y;
    }
    s.wver++;
    s.won = !latticeIdentity(s.wpts, s.gridN);
  }

  // ---- gesti sugli angoli della prospettiva (eventi DOM del gizmo) ----
  /** @param {PointerEvent} e @param {number} idx angolo 0..3 (TL,TR,BR,BL) */
  _perspDown(e, idx) {
    const s = this._session;
    if (!s || !s.ppts) return;
    const tgt = /** @type {SVGCircleElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    this._drag = {
      kind: 'persp', idx, gx: this._tmp.x, gy: this._tmp.y,
      pts0: s.ppts.slice(),
      tx0: s.tx, ty0: s.ty, th0: s.theta, sx0: s.sx, sy0: s.sy,
    };
  }

  /** @param {PointerEvent} e */
  _perspMove(e) {
    const d = this._drag, s = this._session;
    if (!d || !s || d.kind !== 'persp' || !s.ppts) return;
    e.preventDefault();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    const loc = this._deltaLocal(s, this._tmp.x - d.gx, this._tmp.y - d.gy);
    if (!loc) return;
    // l'angolo si muove del delta totale dalla partenza; il quad deve
    // restare CONVESSO (una prospettiva di rettangolo lo è sempre; oltre
    // l'omografia degenera) — il drag che lo romperebbe non si applica e
    // l'angolo resta all'ultima posizione valida
    const cand = d.pts0.slice();
    cand[d.idx * 2] += loc.x;
    cand[d.idx * 2 + 1] += loc.y;
    if (!perspConvex(cand)) return;
    s.ppts.set(cand);
    s.pver++;
    s.pon = !perspIdentity(s.ppts);
  }

  // ---- gesti sulle puntine (eventi DOM del gizmo, alla Photoshop) ----
  // Move = seleziona/sposta; Ruota = seleziona/ruota. Alt resta la scorciatoia
  // desktop storica: click elimina, drag ruota.
  /** @param {PointerEvent} e @param {number} pinId */
  _pinDown(e, pinId) {
    const s = this._session, pup = s ? s.pup : null;
    if (!pup || !pup.mesh) return;
    const pin = pup.pins.find((p) => p.id === pinId);
    if (!pin) return;
    const tgt = /** @type {SVGGElement} */ (e.currentTarget);
    try { tgt.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    const wx = this._tmp.x, wy = this._tmp.y;
    if (e.altKey) {
      // si decide al movimento: fermo = elimina (Alt+click), in moto = ruota
      for (const p of pup.pins) p.sel = p === pin;
      pup.pinsVer++;
      this._beginPinRotate(pup, pin, wx, wy, e.clientX, e.clientY, true);
      this._sig = '';
      return;
    }
    if (this._pupAction === 'rotate') {
      for (const p of pup.pins) p.sel = p === pin;
      pup.pinsVer++;
      this._beginPinRotate(pup, pin, wx, wy, e.clientX, e.clientY, false);
      this._sig = '';
      return;
    }
    if (e.shiftKey) pin.sel = !pin.sel;
    else if (!pin.sel) {
      for (const p of pup.pins) p.sel = p === pin;
    }
    pup.pinsVer++;
    this._beginPinDrag(pup, wx, wy);
    this._sig = '';
  }

  /** @param {PointerEvent} e */
  _pinMove(e) {
    const d = this._drag, s = this._session;
    if (!d || !s || !s.pup) return;
    e.preventDefault();
    this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmp);
    if (d.kind === 'pin') {
      this.dragMove(this._tmp.x, this._tmp.y);
      return;
    }
    if (d.kind !== 'pinrot') return;
    const pup = s.pup;
    this._rotatePinDrag(pup, d, this._tmp.x, this._tmp.y, e.clientX, e.clientY);
  }

  /** @param {PointerEvent} e */
  _pinUp(e) {
    const d = this._drag;
    this._drag = null;
    if (d && d.kind === 'pinrot' && d.deleteOnTap && !d.moved && e.type !== 'pointercancel') {
      this._deletePin(d.pinId); // Alt+click secco: via la puntina
    }
    this._sig = '';
  }

  // Testo: item derivato dallo stato della sessione (niente drift).
  _applyText() {
    const s = this._session;
    const layer = this.app.boards.layerById(s.layerId);
    if (!layer || !layer.item) return;
    layer.item.x = s.cx + s.tx + (s.ix0 - s.cx) * s.sx;
    layer.item.y = s.cy + s.ty + (s.iy0 - s.cy) * s.sx;
    layer.item.size = Math.max(2, s.s0 * s.sx);
    touchText(layer);
  }

  // SVG: la sessione affine si compone sopra la matrice iniziale del layer.
  _applySvg() {
    const s = this._session;
    const layer = this.app.boards.layerById(s.layerId);
    if (!layer || layer.kind !== 'svg' || !layer.svgItem) return;
    layer.svgItem.m = multiplyMatrix(
      /** @type {[number, number, number, number, number, number]} */ (this._matrix(s)),
      s.m0);
    touchSvg(layer);
    this.app.planes.invalidate();
  }

  /** @param {TfSession} s @param {TfItem} item @param {Layer} layer */
  _applyTextItem(s, item, layer) {
    if (!layer.item) return;
    const m = this._matrix(s);
    layer.item.x = m[0] * item.ix0 + m[2] * item.iy0 + m[4];
    layer.item.y = m[1] * item.ix0 + m[3] * item.iy0 + m[5];
    layer.item.size = Math.max(2, item.s0 * Math.abs(s.sx));
    touchText(layer);
  }

  /** @param {TfSession} s @param {TfItem} item @param {Layer} layer */
  _applySvgItem(s, item, layer) {
    if (layer.kind !== 'svg' || !layer.svgItem) return;
    layer.svgItem.m = multiplyMatrix(
      /** @type {[number, number, number, number, number, number]} */ (this._matrix(s)),
      item.m0);
    touchSvg(layer);
  }

  _applyMultiLive() {
    const s = this._session;
    if (!s || s.kind !== 'multi') return;
    let vectorChanged = false;
    for (const item of s.items) {
      if (item.kind === 'raster') continue;
      const layer = this.app.boards.layerById(item.layerId);
      if (!layer) continue;
      if (item.kind === 'text') this._applyTextItem(s, item, layer);
      else this._applySvgItem(s, item, layer);
      vectorChanged = true;
    }
    if (vectorChanged) this.app.planes.invalidate();
  }

  // ---- conferma / annullo ----
  /** @param {boolean} [switchToPan] */
  _finishConfirm(switchToPan = false) {
    this._endLive();
    if (switchToPan && brush.tool === 'move') this.app.ui.setTool('pan');
  }

  /** @param {TfSession} s @param {boolean} switchToPan */
  _confirmMulti(s, switchToPan) {
    const app = this.app;
    const board = app.boards.byId(s.boardId);
    if (!board) { this._finishConfirm(switchToPan); return; }
    app._flushPendingStroke();
    const clip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => app.renderer.disposeChunkTex(c);
    const patternWrap = !!app.patternMode;
    const bakeClip = patternWrap
      ? { x0: clip.x0 - board.w, y0: clip.y0 - board.h, x1: clip.x1 + board.w, y1: clip.y1 + board.h }
      : clip;
    const matrix = this._matrix(s);
    const pureMove = s.theta === 0 && s.sx === 1 && s.sy === 1;
    /** @param {Layer} layer */
    const makeCapture = (layer) => {
      if (!patternWrap) {
        /** @param {number} key @param {number} cx @param {number} cy @param {Uint8ClampedArray|null} before */
        return (key, cx, cy, before) =>
          app.undoMgr.captureChunk(key, cx, cy, /** @type {any} */ (before));
      }
      /** @type {Map<number, {cx:number, cy:number, data:Uint8ClampedArray}>} */
      const original = new Map();
      for (const c of layer.store.map.values()) {
        original.set(c.key, { cx: c.cx, cy: c.cy, data: c.data.slice() });
      }
      /** @type {Set<number>} */
      const seen = new Set();
      /** @param {number} key @param {number} cx @param {number} cy @param {Uint8ClampedArray|null} _before */
      return (key, cx, cy, _before) => {
        if (seen.has(key)) return;
        seen.add(key);
        const orig = original.get(key);
        app.undoMgr.captureChunk(key, cx, cy, orig ? /** @type {any} */ (orig.data) : null);
      };
    };

    for (const item of s.items) {
      const layer = app.boards.layerById(item.layerId);
      if (!layer) continue;
      if (item.kind === 'text' && layer.item) {
        app.undoMgr.pushStruct(/** @type {any} */ ({
          op: 'textform', layerId: item.layerId, boardId: s.boardId,
          x0: item.ix0, y0: item.iy0, s0: item.s0,
          x1: layer.item.x, y1: layer.item.y, s1: layer.item.size,
        }));
        layer.thumbDirty = true;
      } else if (item.kind === 'svg' && layer.kind === 'svg' && layer.svgItem) {
        app.undoMgr.pushStruct(/** @type {any} */ ({
          op: 'svgform', layerId: item.layerId, boardId: s.boardId,
          tm0: item.m0.slice(),
          tm1: /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice()),
        }));
        layer.thumbDirty = true;
      } else if (item.kind === 'raster' && layer.store) {
        if (pureMove) {
          const wrap = !!app.patternMode;
          const lost = wrap
            ? translateStoreWrapped(layer.store, s.tx, s.ty, clip, dispose)
            : translateStore(layer.store, s.tx, s.ty, clip, dispose);
          app.undoMgr.pushMove(/** @type {any} */ (
            { layerId: item.layerId, dx: s.tx, dy: s.ty, boardId: s.boardId, chunks: lost, wrap }));
        } else {
          const capture = makeCapture(layer);
          app.undoMgr.captureBegin(item.layerId);
          transformStore(layer.store, matrix,
            { x: item.texX, y: item.texY, w: item.texW, h: item.texH }, bakeClip,
            capture, dispose);
          if (patternWrap) wrapStoreIntoClip(layer.store, clip, capture, dispose);
          app.undoMgr.captureEnd();
        }
        layer.thumbDirty = true;
      }
    }
    app.ui.layersUI.scheduleThumbs();
    app.planes.invalidate();
    this._finishConfirm(switchToPan);
  }

  /** @param {boolean} [switchToPan] */
  confirm(switchToPan = false) {
    const s = this._session;
    if (!s) return;
    this._session = null;
    this._drag = null;
    const app = this.app;
    const won = !!(s.wpts && s.won);
    const pon = !!(s.ppts && s.pon);
    const pup = s.pup && s.pup.on && s.pup.mesh ? s.pup : null;
    const identity = !won && !pon && !pup && s.tx === 0 && s.ty === 0 && s.theta === 0 && s.sx === 1 && s.sy === 1;
    if (identity) { this._finishConfirm(switchToPan); return; }
    if (s.kind === 'multi') {
      this._confirmMulti(s, switchToPan);
      return;
    }
    const layer = app.boards.layerById(s.layerId);
    if (!layer) { this._finishConfirm(switchToPan); return; }
    if (s.kind === 'text') {
      app.undoMgr.pushStruct(/** @type {any} */ ({
        op: 'textform', layerId: s.layerId, boardId: s.boardId,
        x0: s.ix0, y0: s.iy0, s0: s.s0,
        x1: layer.item.x, y1: layer.item.y, s1: layer.item.size,
      }));
      layer.thumbDirty = true;
      app.ui.layersUI.scheduleThumbs();
      this._finishConfirm(switchToPan);
      return;
    }
    if (s.kind === 'svg') {
      const m1 = layer.svgItem && layer.svgItem.m
        ? /** @type {[number, number, number, number, number, number]} */ (layer.svgItem.m.slice())
        : s.m0;
      app.undoMgr.pushStruct(/** @type {any} */ ({
        op: 'svgform', layerId: s.layerId, boardId: s.boardId,
        tm0: s.m0.slice(), tm1: m1,
      }));
      layer.thumbDirty = true;
      app.ui.layersUI.scheduleThumbs();
      app.planes.invalidate();
      this._finishConfirm(switchToPan);
      return;
    }
    app._flushPendingStroke();
    const board = app.boards.byId(s.boardId);
    if (!board) { this._finishConfirm(switchToPan); return; }
    const clip = { x0: board.x, y0: board.y, x1: board.x + board.w - 1, y1: board.y + board.h - 1 };
    /** @type {(c: import('./store.js').Chunk) => void} */
    const dispose = (c) => app.renderer.disposeChunkTex(c);
    const patternWrap = !!app.patternMode;
    const bakeClip = patternWrap
      ? { x0: clip.x0 - board.w, y0: clip.y0 - board.h, x1: clip.x1 + board.w, y1: clip.y1 + board.h }
      : clip;
    const makeCapture = () => {
      if (!patternWrap) {
        /** @param {number} key @param {number} cx @param {number} cy @param {Uint8ClampedArray|null} before */
        return (key, cx, cy, before) =>
          app.undoMgr.captureChunk(key, cx, cy, /** @type {any} */ (before));
      }
      /** @type {Map<number, {cx:number, cy:number, data:Uint8ClampedArray}>} */
      const original = new Map();
      for (const c of layer.store.map.values()) {
        original.set(c.key, { cx: c.cx, cy: c.cy, data: c.data.slice() });
      }
      /** @type {Set<number>} */
      const seen = new Set();
      /** @param {number} key @param {number} cx @param {number} cy @param {Uint8ClampedArray|null} _before */
      return (key, cx, cy, _before) => {
        if (seen.has(key)) return;
        seen.add(key);
        const orig = original.get(key);
        app.undoMgr.captureChunk(key, cx, cy, orig ? /** @type {any} */ (orig.data) : null);
      };
    };
    /** @param {(key: number, cx: number, cy: number, before: Uint8ClampedArray|null) => void} capture */
    const finishTileDiff = (capture) => {
      if (patternWrap) wrapStoreIntoClip(layer.store, clip, capture, dispose);
      app.undoMgr.captureEnd();
    };
    if (pup) {
      // marionetta: ricampionamento one-shot sulla mesh deformata (l'affine
      // qui è identità per costruzione), stesso undo tile-diff
      const capture = makeCapture();
      app.undoMgr.captureBegin(s.layerId);
      puppetStore(layer.store, pup.mesh.pos0, pup.def, pup.mesh.tris, pup.order,
        { x: s.texX, y: s.texY, w: s.texW, h: s.texH }, bakeClip,
        capture, dispose);
      finishTileDiff(capture);
    } else if (!won && !pon && s.theta === 0 && s.sx === 1 && s.sy === 1) {
      // traslazione intera pura: zero ricampionamento, undo leggero
      const wrap = !!app.patternMode;
      const lost = wrap
        ? translateStoreWrapped(layer.store, s.tx, s.ty, clip, dispose)
        : translateStore(layer.store, s.tx, s.ty, clip, dispose);
      app.undoMgr.pushMove(/** @type {any} */ (
        { layerId: s.layerId, dx: s.tx, dy: s.ty, boardId: s.boardId, chunks: lost, wrap }));
    } else if (!won && !pon) {
      // ricampionamento one-shot; undo = tile-diff come una pennellata
      const capture = makeCapture();
      app.undoMgr.captureBegin(s.layerId);
      transformStore(layer.store, this._matrix(s),
        { x: s.texX, y: s.texY, w: s.texW, h: s.texH }, bakeClip,
        capture, dispose);
      finishTileDiff(capture);
    } else if (won) {
      // warp (con l'eventuale affine composta sopra): ricampionamento
      // one-shot dai pixel originali, stesso undo tile-diff
      const capture = makeCapture();
      app.undoMgr.captureBegin(s.layerId);
      warpStore(layer.store, s.wpts, s.gridN, this._matrix(s),
        { x: s.bx, y: s.by, w: s.bw, h: s.bh },
        { x: s.texX, y: s.texY, w: s.texW, h: s.texH }, bakeClip,
        capture, dispose);
      finishTileDiff(capture);
    } else {
      // prospettiva (con l'eventuale affine composta sopra): mapping
      // inverso esatto dai pixel originali, stesso undo tile-diff
      const capture = makeCapture();
      app.undoMgr.captureBegin(s.layerId);
      perspStore(layer.store, s.ppts, this._matrix(s),
        { x: s.bx, y: s.by, w: s.bw, h: s.bh },
        { x: s.texX, y: s.texY, w: s.texW, h: s.texH }, bakeClip,
        capture, dispose);
      finishTileDiff(capture);
    }
    layer.thumbDirty = true;
    app.ui.layersUI.scheduleThumbs();
    app.planes.invalidate();
    this._finishConfirm(switchToPan);
  }

  cancel() {
    const s = this._session;
    if (!s) return;
    this._session = null;
    this._drag = null;
    if (s.kind === 'multi') {
      for (const item of s.items) {
        const layer = this.app.boards.layerById(item.layerId);
        if (!layer) continue;
        if (item.kind === 'text' && layer.item) {
          layer.item.x = item.ix0;
          layer.item.y = item.iy0;
          layer.item.size = item.s0;
          touchText(layer);
        } else if (item.kind === 'svg' && layer.kind === 'svg' && layer.svgItem) {
          layer.svgItem.m = /** @type {[number, number, number, number, number, number]} */ (item.m0.slice());
          touchSvg(layer);
        }
      }
    } else if (s.kind === 'text') {
      const layer = this.app.boards.layerById(s.layerId);
      if (layer && layer.item) {
        layer.item.x = s.ix0;
        layer.item.y = s.iy0;
        layer.item.size = s.s0;
        touchText(layer);
      }
    } else if (s.kind === 'svg') {
      const layer = this.app.boards.layerById(s.layerId);
      if (layer && layer.kind === 'svg' && layer.svgItem) {
        layer.svgItem.m = /** @type {[number, number, number, number, number, number]} */ (s.m0.slice());
        touchSvg(layer);
      }
    }
    this.app.planes.invalidate();
    this._endLive();
  }

  // ---- gizmo a schermo (ogni frame) ----
  /** @param {import('./camera.js').Camera} cam */
  _syncGizmo(cam) {
    const s = this._session;
    if (!s) {
      if (this._visible) {
        this._visible = false;
        this.svg.style.display = 'none';
        this.okBtn.style.display = 'none';
        this.noBtn.style.display = 'none';
        this.meshCnv.style.display = 'none';
        this._clearSmartGuides();
        this._sig = '';
      }
      return;
    }
    const warpMode = this.mode === 'warp' && s.kind === 'raster' && !!s.wpts;
    const perspMode = this.mode === 'persp' && s.kind === 'raster' && !!s.ppts;
    const pupMode = this.mode === 'puppet' && s.kind === 'raster' && !!s.pup;
    const pup = s.pup;
    const sig = `${cam.x}|${cam.y}|${cam.zoom}|${cam.w}|${cam.h}|${s.stamp}|` +
      `${s.tx}|${s.ty}|${s.theta}|${s.sx}|${s.sy}|${this.mode}|${s.wver}|${s.gridN}|${s.pver}|` +
      (pup ? `${pup.ver}:${pup.pinsVer}:${pup.meshVer}:${this._pupShowMesh ? 1 : 0}` : '') +
      `|${this._guideSignature()}`;
    if (sig === this._sig && this._visible) return;
    this._sig = sig;
    if (!this._visible) {
      this._visible = true;
      this.svg.style.display = 'block';
      this.okBtn.style.display = '';
      this.noBtn.style.display = '';
    }
    // punti warp di bordo: numero giusto per la densità corrente
    const nb = s.gridN * 4; // (np² − (np−2)²) = 4·N punti sul bordo
    if (warpMode && this._warpDots.length !== nb) this._rebuildWarpDots();
    // visibilità per modalità (testo: niente rotazione né stira)
    const text = s.kind === 'text' || s.hasText;
    for (const [k, dot] of this._dots) {
      dot.style.display = warpMode || perspMode || pupMode || (text && !CORNER.has(k)) ? 'none' : '';
    }
    for (const d of this._warpDots) d.el.style.display = warpMode ? '' : 'none';
    for (const c of this._perspDots) c.style.display = perspMode ? '' : 'none';
    this.gridEl.style.display = warpMode ? '' : 'none';
    this.handleEl.style.display = warpMode ? '' : 'none';
    this.edgeEl.style.display = pupMode ? 'none' : '';
    if (this.mode !== 'affine' || !this._drag) this._guideState = null;
    this._drawSmartGuides(cam);
    if (!pupMode) {
      if (this.meshCnv.style.display !== 'none') this.meshCnv.style.display = 'none';
      if (this._pinEls.size > 0) this._syncPinDom(null);
      this._rotCirc.style.display = 'none';
    }
    if (pupMode) {
      this._syncPuppetGizmo(cam, s);
      return;
    }
    if (warpMode) {
      this._syncWarpGizmo(cam, s);
      return;
    }
    if (perspMode) {
      this._syncPerspGizmo(cam, s);
      return;
    }
    const m = this._matrix(s);
    /** @type {(u: number, v: number) => {x: number, y: number}} */
    const P = (u, v) => {
      const lx = s.bx + u * s.bw, ly = s.by + v * s.bh;
      return cam.worldToScreen(
        m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5], { x: 0, y: 0 });
    };
    const tl = P(0, 0), tr = P(1, 0), br = P(1, 1), bl = P(0, 1);
    this.edgeEl.setAttribute('d',
      `M ${tl.x} ${tl.y} L ${tr.x} ${tr.y} L ${br.x} ${br.y} L ${bl.x} ${bl.y} Z`);
    const ctrX = (tl.x + tr.x + br.x + bl.x) / 4, ctrY = (tl.y + tr.y + br.y + bl.y) / 4;
    /** @type {Record<string, {x: number, y: number}>} */
    const pts = { tl, tr, br, bl };
    for (const [k, u, v] of DOTS) if (!pts[k]) pts[k] = P(u, v);
    // maniglia di rotazione: 28px schermo fuori dal lato alto
    const tm = pts.tm;
    const dlen = Math.hypot(tm.x - ctrX, tm.y - ctrY) || 1;
    pts.rot = {
      x: tm.x + (tm.x - ctrX) / dlen * 28,
      y: tm.y + (tm.y - ctrY) / dlen * 28,
    };
    this.spokeEl.setAttribute('d', `M ${tm.x} ${tm.y} L ${pts.rot.x} ${pts.rot.y}`);
    this.spokeEl.style.display = text ? 'none' : '';
    for (const [k, dot] of this._dots) {
      dot.setAttribute('cx', String(pts[k].x));
      dot.setAttribute('cy', String(pts[k].y));
    }
    // ✓/✗ sotto il punto più basso della box
    const byMax = Math.max(tl.y, tr.y, br.y, bl.y);
    this.okBtn.style.left = (ctrX - 40) + 'px';
    this.okBtn.style.top = (byMax + 14) + 'px';
    this.noBtn.style.left = (ctrX + 4) + 'px';
    this.noBtn.style.top = (byMax + 14) + 'px';
  }

  // Gizmo della modalità Prospettiva: l'omografia manda rette in rette,
  // quindi il bordo è il quad DRITTO per i 4 angoli — che a differenza dei
  // punti warp SONO superficie: a schermo vanno con l'affine della loro
  // posizione in unità bbox.
  /** @param {import('./camera.js').Camera} cam @param {TfSession} s */
  _syncPerspGizmo(cam, s) {
    const m = this._matrix(s), pt = this._tmp;
    const PX = new Float64Array(4), PY = new Float64Array(4);
    for (let k = 0; k < 4; k++) {
      const lx = s.bx + s.ppts[k * 2] * s.bw, ly = s.by + s.ppts[k * 2 + 1] * s.bh;
      cam.worldToScreen(m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5], pt);
      PX[k] = pt.x;
      PY[k] = pt.y;
      this._perspDots[k].setAttribute('cx', String(pt.x));
      this._perspDots[k].setAttribute('cy', String(pt.y));
    }
    this.edgeEl.setAttribute('d',
      `M ${PX[0]} ${PY[0]} L ${PX[1]} ${PY[1]} L ${PX[2]} ${PY[2]} L ${PX[3]} ${PY[3]} Z`);
    this.spokeEl.style.display = 'none';
    // ✓/✗ sotto l'angolo più basso
    const ctrX = (PX[0] + PX[1] + PX[2] + PX[3]) / 4;
    const maxY = Math.max(PY[0], PY[1], PY[2], PY[3]);
    this.okBtn.style.left = (ctrX - 40) + 'px';
    this.okBtn.style.top = (maxY + 14) + 'px';
    this.noBtn.style.left = (ctrX + 4) + 'px';
    this.noBtn.style.top = (maxY + 14) + 'px';
  }

  // Gizmo della modalità Warp: la griglia CURVA campionata sulla superficie
  // (8 punti per cella), i punti di controllo trascinabili e i raggi
  // angolo→maniglia di bordo (alla Photoshop). I punti di controllo NON
  // stanno sulla superficie (tranne gli angoli): a schermo vanno con la
  // semplice affine della loro posizione nel reticolo.
  /** @param {import('./camera.js').Camera} cam @param {TfSession} s */
  _syncWarpGizmo(cam, s) {
    const n = s.gridN, SAMP = 8, gs = n * SAMP, cols = gs + 1;
    const m = this._matrix(s);
    const G = this._gizGrid = warpGridWorld(s.wpts, n,
      { x: s.bx, y: s.by, w: s.bw, h: s.bh }, m, 0, 1, 0, 1, gs, gs, this._gizGrid);
    // mondo → schermo una volta sola per nodo
    const pt = this._tmp;
    const SX = new Float64Array(cols * cols), SY = new Float64Array(cols * cols);
    for (let i = 0, k = 0; i < cols * cols; i++, k += 2) {
      cam.worldToScreen(G[k], G[k + 1], pt);
      SX[i] = pt.x;
      SY[i] = pt.y;
    }
    // bordo (edge) = prime/ultime linee, interno (grid) = le altre
    let edge = '', grid = '';
    for (let li = 0; li <= n; li++) {
      const r = li * SAMP;
      let dh = '', dv = '';
      for (let j = 0; j < cols; j++) {
        dh += (j === 0 ? 'M ' : 'L ') + SX[r * cols + j] + ' ' + SY[r * cols + j] + ' ';
        dv += (j === 0 ? 'M ' : 'L ') + SX[j * cols + r] + ' ' + SY[j * cols + r] + ' ';
      }
      if (li === 0 || li === n) edge += dh + dv;
      else grid += dh + dv;
    }
    this.edgeEl.setAttribute('d', edge);
    this.gridEl.setAttribute('d', grid);
    this.spokeEl.style.display = 'none';
    const np = n + 1;
    const PX = new Float64Array(np * np), PY = new Float64Array(np * np);
    for (let k = 0; k < np * np; k++) {
      const lx = s.bx + s.wpts[k * 2] * s.bw, ly = s.by + s.wpts[k * 2 + 1] * s.bh;
      cam.worldToScreen(m[0] * lx + m[2] * ly + m[4], m[1] * lx + m[3] * ly + m[5], pt);
      PX[k] = pt.x;
      PY[k] = pt.y;
    }
    for (const d of this._warpDots) {
      d.el.setAttribute('cx', String(PX[d.k]));
      d.el.setAttribute('cy', String(PY[d.k]));
    }
    // raggi angolo→maniglie di bordo adiacenti
    let hl = '';
    for (const [ci, cj] of [[0, 0], [0, n], [n, 0], [n, n]]) {
      const a = ci * np + cj;
      const h1 = ci * np + (cj === 0 ? 1 : n - 1);
      const h2 = (ci === 0 ? 1 : n - 1) * np + cj;
      hl += `M ${PX[a]} ${PY[a]} L ${PX[h1]} ${PY[h1]} ` +
        `M ${PX[a]} ${PY[a]} L ${PX[h2]} ${PY[h2]} `;
    }
    this.handleEl.setAttribute('d', hl);
    // ✓/✗ sotto il punto più basso di griglia e punti di controllo
    let maxY = -Infinity;
    for (let i = 0; i < cols * cols; i++) if (SY[i] > maxY) maxY = SY[i];
    for (let k = 0; k < np * np; k++) if (PY[k] > maxY) maxY = PY[k];
    const ctrX = (SX[0] + SX[gs] + SX[gs * cols] + SX[cols * cols - 1]) / 4;
    this.okBtn.style.left = (ctrX - 40) + 'px';
    this.okBtn.style.top = (maxY + 14) + 'px';
    this.noBtn.style.left = (ctrX + 4) + 'px';
    this.noBtn.style.top = (maxY + 14) + 'px';
  }

  // Gizmo della modalità Marionetta: la rete deformata sul canvas overlay
  // (migliaia di spigoli: linee 2D, non path SVG) e le puntine come gruppi
  // SVG — cerchietto giallo, punto nero al centro se selezionata, cerchio
  // tratteggiato durante il drag di rotazione (tutto alla Photoshop).
  /** @param {import('./camera.js').Camera} cam @param {TfSession} s */
  _syncPuppetGizmo(cam, s) {
    const pup = s.pup;
    this.spokeEl.style.display = 'none';
    this._drawPuppetMesh(cam, pup);
    this._syncPinDom(pup);
    const pt = this._tmp;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (pup.mesh) {
      const def = pup.def;
      for (let k = 0; k < def.length; k += 2) {
        if (def[k] < minX) minX = def[k];
        if (def[k] > maxX) maxX = def[k];
        if (def[k + 1] < minY) minY = def[k + 1];
        if (def[k + 1] > maxY) maxY = def[k + 1];
      }
    } else {
      minX = s.bx; minY = s.by; maxX = s.bx + s.bw; maxY = s.by + s.bh;
    }
    for (const pin of pup.pins) {
      const el = this._pinEls.get(pin.id);
      if (!el) continue;
      cam.worldToScreen(pup.def[pin.v * 2], pup.def[pin.v * 2 + 1], pt);
      el.g.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
      el.g.classList.toggle('sel', pin.sel);
    }
    // cerchio di rotazione attorno alla puntina durante il drag Ruota
    const d = this._drag;
    if (d && d.kind === 'pinrot' && d.moved) {
      const pin = pup.pins.find((p) => p.id === d.pinId);
      if (pin) {
        cam.worldToScreen(pup.def[pin.v * 2], pup.def[pin.v * 2 + 1], pt);
        this._rotCirc.setAttribute('cx', String(pt.x));
        this._rotCirc.setAttribute('cy', String(pt.y));
        this._rotCirc.style.display = '';
      }
    } else if (this._rotCirc.style.display !== 'none') {
      this._rotCirc.style.display = 'none';
    }
    this._pupReflectRot(pup);
    // ✓/✗ sotto il punto più basso della mesh
    const a = cam.worldToScreen(minX, minY, { x: 0, y: 0 });
    const b = cam.worldToScreen(maxX, maxY, { x: 0, y: 0 });
    const ctrX = (a.x + b.x) / 2;
    const byMax = Math.max(a.y, b.y);
    this.okBtn.style.left = (ctrX - 40) + 'px';
    this.okBtn.style.top = (byMax + 14) + 'px';
    this.noBtn.style.left = (ctrX + 4) + 'px';
    this.noBtn.style.top = (byMax + 14) + 'px';
  }

  // DOM delle puntine allineato alla lista (null = via tutte).
  /** @param {PupState|null} pup */
  _syncPinDom(pup) {
    /** @type {Set<number>} */
    const seen = new Set();
    if (pup) {
      for (const pin of pup.pins) {
        seen.add(pin.id);
        if (this._pinEls.has(pin.id)) continue;
        const g = /** @type {SVGGElement} */ (document.createElementNS(SVG_NS, 'g'));
        g.setAttribute('class', 'tg-pin');
        const ring = document.createElementNS(SVG_NS, 'circle');
        ring.setAttribute('class', 'tg-pin-ring');
        ring.setAttribute('r', '6');
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'tg-pin-dot');
        dot.setAttribute('r', '2.4');
        g.append(ring, dot);
        g.addEventListener('pointerdown', (e) => this._pinDown(e, pin.id));
        g.addEventListener('pointermove', (e) => this._pinMove(e));
        g.addEventListener('pointerup', (e) => this._pinUp(e));
        g.addEventListener('pointercancel', (e) => this._pinUp(e));
        this.svg.appendChild(g);
        this._pinEls.set(pin.id, { g, ring, dot });
      }
    }
    for (const [id, el] of this._pinEls) {
      if (seen.has(id)) continue;
      el.g.remove();
      this._pinEls.delete(id);
    }
  }

  // Rete triangolare sul canvas overlay: grigia e sottile come Photoshop.
  // Ridisegnata solo quando la firma del gizmo cambia (camera o solve).
  /** @param {import('./camera.js').Camera} cam @param {PupState} pup */
  _drawPuppetMesh(cam, pup) {
    const cnv = this.meshCnv;
    if (!pup.mesh || !this._pupShowMesh) {
      if (cnv.style.display !== 'none') cnv.style.display = 'none';
      return;
    }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    if (cnv.width !== Math.round(w * dpr) || cnv.height !== Math.round(h * dpr)) {
      cnv.width = Math.round(w * dpr);
      cnv.height = Math.round(h * dpr);
    }
    if (cnv.style.display !== 'block') cnv.style.display = 'block';
    const ctx = cnv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { edges } = pup.mesh;
    const def = pup.def, pt = this._tmp;
    // proiezione una volta per vertice, poi le linee
    const n = def.length >> 1;
    const SX = new Float32Array(n), SY = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cam.worldToScreen(def[i * 2], def[i * 2 + 1], pt);
      SX[i] = pt.x;
      SY[i] = pt.y;
    }
    ctx.beginPath();
    const m = 40; // margine: le linee a cavallo del bordo si vedono
    for (let k = 0; k < edges.length; k += 2) {
      const a = edges[k], b = edges[k + 1];
      const ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b];
      if ((ax < -m && bx < -m) || (ax > w + m && bx > w + m) ||
        (ay < -m && by < -m) || (ay > h + m && by > h + m)) continue;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120, 128, 138, 0.65)';
    ctx.stroke();
  }
}
