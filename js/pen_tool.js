// PENNA — tracciati Bézier editabili in stile Illustrator, come livelli SVG.
// Il tracciato è un normale layer kind 'svg': la GEOMETRIA vive strutturata
// in svgItem.pen come SUBPATH MULTIPLI (pen.paths[], ancore in coordinate
// viewBox — tenute sempre 1:1 col rect mondo pre-matrice — e maniglie
// RELATIVE all'ancora) e a ogni modifica si riscrivono SOLO gli attributi d
// dentro content (elementi marcati data-fp-pen-d). Lo STILE
// (fill/stroke/spessore) vive SOLO nel markup, mai duplicato: il pannello
// SVG riscrive content (colori + marker dei paint group) e la rigenerazione
// della geometria non deve toccarlo. Undo ('svgitem'), salvataggio, collab
// (watcher 'sset') e Sposta ('svgform' sulla matrice m) arrivano gratis
// dall'infrastruttura svgItem esistente.
//
// UN SOLO LAYER per flusso di lavoro: se il layer attivo è già un tracciato
// penna i nuovi subpath si SOMMANO lì; altrimenti il primo tracciato vero
// crea UN layer che diventa attivo e accoglie tutto il resto. La prima
// ancora è PENDING (solo stato di sessione, disegnata dal gizmo): il layer
// o il subpath si materializzano alla SECONDA ancora — un click vagante non
// lascia mai layer o subpath invisibili in giro.
//
// Allineamento traccia (pen.align: center/inside/outside, alla Illustrator):
// SVG non ha stroke-alignment, quindi interno = spessore ×2 + clipPath sul
// path stesso; esterno = spessore ×2 + clipPath evenodd (rect − path) con
// fill su un path separato. Niente maschere luminance: un rect bianco/nero
// comparirebbe come colore editabile nel pannello SVG. L'allineamento vale
// solo quando esiste almeno un subpath CHIUSO (come Illustrator: i path
// aperti restano al centro); la struttura del markup si auto-ripara in
// _refresh confrontando il marker data-fp-pen-align con l'align effettivo.
//
// La sessione non tiene MAI geometria duplicata né riferimenti cachati a
// punti/array: il layer si risolve per id e svgItem.pen si rilegge a ogni
// gesto — il collab sostituisce l'oggetto svgItem intero (last-write-wins) e
// l'undo di un 'attach' fa morire la sessione da solo (lookup fallito).
// Interazione: la CREAZIONE passa dal ring buffer (canvasDown/Move/Up in
// coordinate mondo, agganciati in App.startStroke e negli hook); l'EDITING
// passa dai pallini del gizmo, che catturano i propri pointer come la gabbia
// di distorsione (distort_ui.js) e leggono e.altKey per spezzare la
// simmetria. Durante la creazione i pallini sono passivi (pointer-events
// none via .pg-creating): il click sul primo punto deve arrivare al canvas
// per chiudere il tracciato.

import { brush } from './brush.js';
import { makeSvgLayer } from './layers.js';
import { touchSvg } from './svg_layer.js';

/** @typedef {import('./main.js').App} App */
/** @typedef {import('./layers.js').Layer} Layer */
/** @typedef {import('./svg_layer.js').SvgItem} SvgItem */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./boards.js').Board} Board */

const SVG_NS = 'http://www.w3.org/2000/svg';
const CLOSE_PX = 10;      // raggio schermo: click sul primo punto = chiusura
const EDIT_HIT_PX = 10;   // raggio schermo dei click di Penna+ / Penna−
const DRAG_SLOP_PX = 3;   // sotto: click secco, niente maniglie
const ANCHOR_R = 5;
const HANDLE_R = 3.5;
const FIRST_HOT_R = 7;    // primo punto evidenziato quando chiudibile
const MIN_SIDE = 1;

let pathSeq = 0;
let sessSeq = 0; // tag delle sessioni di creazione (coalescenza undo alla chiusura)

/**
 * Punto ancora. Coordinate nello spazio viewBox dell'item; le maniglie sono
 * VETTORI relativi all'ancora, così spostare il punto le trascina gratis.
 * @typedef {Object} PenPoint
 * @property {number} x
 * @property {number} y
 * @property {{x: number, y: number}|null} hi maniglia in ingresso
 * @property {{x: number, y: number}|null} ho maniglia in uscita
 * @property {'corner'|'smooth'} t
 */

/**
 * @typedef {Object} PenSubpath
 * @property {PenPoint[]} points
 * @property {boolean} closed
 */

/**
 * Geometria strutturata del tracciato dentro svgItem. SOLO geometria (+
 * allineamento, che decide la STRUTTURA del markup): lo stile resta negli
 * attributi dei path in content.
 * @typedef {Object} PenData
 * @property {PenSubpath[]} [paths]
 * @property {'center'|'inside'|'outside'} [align]
 * @property {PenPoint[]} [points] legacy v1: un solo tracciato
 * @property {boolean} [closed] legacy v1
 */

/** dash 0 = linea continua; le unità di dash/gap sono px logici (viewBox), come lo spessore */
/** @typedef {{stroke: string, width: number, fill: string, align: 'center'|'inside'|'outside', corners: 'round'|'sharp', dash: number, gap: number}} PenStyle */

/** primi due numeri di uno stroke-dasharray ("d g"; "d" solo = gap uguale) @param {string|null} v */
function parseDash(v) {
  if (!v || v === 'none') return { dash: 0, gap: 0 };
  const n = String(v).split(/[\s,]+/).map(parseFloat).filter((x) => Number.isFinite(x) && x >= 0);
  if (!n.length || n[0] <= 0) return { dash: 0, gap: 0 };
  return { dash: n[0], gap: n.length > 1 ? n[1] : n[0] };
}

/** lettura non distruttiva (anche formato v1) @param {PenData} pen @returns {PenSubpath[]} */
function pathsOf(pen) {
  if (pen.paths) return pen.paths;
  return pen.points ? [{ points: pen.points, closed: !!pen.closed }] : [];
}

/** porta il formato v1 a paths[] prima di una mutazione @param {PenData} pen */
function migratePen(pen) {
  if (!pen.paths) {
    pen.paths = pen.points ? [{ points: pen.points, closed: !!pen.closed }] : [];
    delete pen.points;
    delete pen.closed;
  }
  return pen.paths;
}

/** @param {PenData} pen @returns {'center'|'inside'|'outside'} */
function alignOf(pen) {
  return pen.align === 'inside' || pen.align === 'outside' ? pen.align : 'center';
}

// L'allineamento ha senso solo con una regione chiusa (come Illustrator):
// finché tutti i subpath sono aperti la struttura resta quella centrale.
/** @param {PenData} pen */
function effAlignOf(pen) {
  const a = alignOf(pen);
  return a !== 'center' && pathsOf(pen).some((p) => p.closed) ? a : 'center';
}

/** @param {number} n */
const fmt = (n) => Math.round(n * 100) / 100;

// Shift alla Illustrator: vincola un vettore al multiplo di 45° più vicino,
// lunghezza intatta (la maniglia/ancora resta alla distanza del mouse).
/** @param {number} dx @param {number} dy */
function snap45(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (!len) return { x: 0, y: 0 };
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: Math.cos(a) * len, y: Math.sin(a) * len };
}

/** @param {PenSubpath} sp */
function subD(sp) {
  const pts = sp.points;
  if (!pts.length) return '';
  /** @param {PenPoint} a @param {PenPoint} b */
  const seg = (a, b) => (a.ho || b.hi)
    ? `C ${fmt(a.x + (a.ho ? a.ho.x : 0))} ${fmt(a.y + (a.ho ? a.ho.y : 0))} ` +
      `${fmt(b.x + (b.hi ? b.hi.x : 0))} ${fmt(b.y + (b.hi ? b.hi.y : 0))} ${fmt(b.x)} ${fmt(b.y)}`
    : `L ${fmt(b.x)} ${fmt(b.y)}`;
  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += ' ' + seg(pts[i - 1], pts[i]);
  if (sp.closed && pts.length > 1) d += ' ' + seg(pts[pts.length - 1], pts[0]) + ' Z';
  return d;
}

/** d composto di tutti i subpath @param {PenData} pen */
function penD(pen) {
  return pathsOf(pen).map(subD).filter(Boolean).join(' ');
}

/** @param {string|number} v */
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** rettangolo del rect dell'item come path (per il clip "esterno") @param {SvgItem} item */
function rectDOf(item) {
  const x0 = fmt(item.x), y0 = fmt(item.y);
  const x1 = fmt(item.x + item.w), y1 = fmt(item.y + item.h);
  return `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;
}

// Rect e viewBox stretti su ancore+maniglie (l'hull dei punti di controllo
// contiene la curva) col margine che dipende dall'allineamento: interno non
// sborda mai, centrale sborda di w/2, esterno di w (spessore reso 2w clippato
// a metà). Con gli angoli AGUZZI (linejoin miter) lo spike del join arriva
// fino a miterlimit (default 4) × metà spessore oltre l'ancora: il margine
// scala di conseguenza. svgItemBounds legge SOLO il rect: è qui che si
// evitano sia il clipping del tratto sia i bake giganti in SvgQuadCache.
// La viewBox resta == rect: i punti sono coordinate assolute nel piano della
// viewBox e non si muovono quando la finestra si allarga.
/** @param {SvgItem} item @param {number} width logica @param {'center'|'inside'|'outside'} effAlign @param {'round'|'sharp'} corners */
function recomputeBounds(item, width, effAlign, corners) {
  const paths = pathsOf(item.pen);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  /** @param {number} x @param {number} y */
  const add = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const sp of paths) {
    for (const p of sp.points) {
      add(p.x, p.y);
      if (p.hi) add(p.x + p.hi.x, p.y + p.hi.y);
      if (p.ho) add(p.x + p.ho.x, p.y + p.ho.y);
    }
  }
  if (!Number.isFinite(x0)) return;
  const spike = corners === 'sharp' ? 4 : 1; // stroke-miterlimit di default
  const pad = effAlign === 'inside' ? 1
    : effAlign === 'outside' ? width * spike + 1
    : (width / 2) * spike + 1;
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  item.x = item.viewX = x0;
  item.y = item.viewY = y0;
  item.w = item.viewW = Math.max(MIN_SIDE, x1 - x0);
  item.h = item.viewH = Math.max(MIN_SIDE, y1 - y0);
}

// mondo → coordinate tracciato: inverte la matrice dell'item (il tool Sposta
// muta SOLO m, mai i punti) e poi la finestra viewBox. Per gli item della
// penna viewBox == rect, ma la forma generale tiene anche import esterni.
/** @param {SvgItem} item @param {number} wx @param {number} wy @param {{x:number,y:number}} out */
function penPosFromWorld(item, wx, wy, out) {
  const m = item.m || [1, 0, 0, 1, 0, 0];
  const det = (m[0] * m[3] - m[1] * m[2]) || 1;
  const dx = wx - m[4], dy = wy - m[5];
  const ux = (m[3] * dx - m[2] * dy) / det;
  const uy = (m[0] * dy - m[1] * dx) / det;
  out.x = item.viewX + (ux - item.x) * (item.viewW / item.w);
  out.y = item.viewY + (uy - item.y) * (item.viewH / item.h);
  return out;
}

/** @param {SvgItem} item @param {number} px @param {number} py @param {{x:number,y:number}} out */
function worldFromPenPos(item, px, py, out) {
  const ux = item.x + (px - item.viewX) * (item.w / item.viewW);
  const uy = item.y + (py - item.viewY) * (item.h / item.viewH);
  const m = item.m || [1, 0, 0, 1, 0, 0];
  out.x = m[0] * ux + m[2] * uy + m[4];
  out.y = m[1] * ux + m[3] * uy + m[5];
  return out;
}

/** @param {string} content @returns {SVGSVGElement} */
function parseContent(content) {
  const host = /** @type {SVGSVGElement} */ (document.createElementNS(SVG_NS, 'svg'));
  host.innerHTML = content;
  return host;
}

/** path visibile che porta lo stroke @param {SVGSVGElement} host */
function strokeEl(host) {
  return host.querySelector('[data-fp-pen="s"], [data-fp-pen="fs"]') || host.querySelector('path');
}

/** path visibile che porta il fill @param {SVGSVGElement} host */
function fillEl(host) {
  return host.querySelector('[data-fp-pen="f"], [data-fp-pen="fs"]') || host.querySelector('path');
}

/**
 * Stile corrente del tracciato, letto dal markup. width è quella LOGICA
 * (l'attributo reso è ×2 quando la struttura è interna/esterna).
 * @param {SvgItem} item
 * @returns {{stroke: string, strokeOpacity: string|null, fill: string, fillOpacity: string|null, width: number, align: 'center'|'inside'|'outside', corners: 'round'|'sharp', dash: number, gap: number, builtAlign: string}|null}
 */
function readPenStyle(item) {
  const host = parseContent(item.content);
  const s = strokeEl(host);
  if (!s) return null;
  const f = fillEl(host) || s;
  const builtAlign = s.getAttribute('data-fp-pen-align') || f.getAttribute('data-fp-pen-align') || 'center';
  const wAttr = parseFloat(s.getAttribute('stroke-width') || '1');
  const w = Number.isFinite(wAttr) && wAttr > 0 ? wAttr : 1;
  const dashes = parseDash(s.getAttribute('stroke-dasharray'));
  return {
    stroke: s.getAttribute('stroke') || '#000000',
    strokeOpacity: s.getAttribute('stroke-opacity'),
    fill: f.getAttribute('fill') || 'none',
    fillOpacity: f.getAttribute('fill-opacity'),
    width: builtAlign === 'center' ? w : w / 2,
    align: alignOf(item.pen || {}),
    corners: (s.getAttribute('stroke-linejoin') || 'round') === 'round' ? 'round' : 'sharp',
    dash: dashes.dash,
    gap: dashes.gap,
    builtAlign,
  };
}

// Costruisce da zero la struttura del markup per l'allineamento richiesto,
// riapplicando lo stile letto (i marker dei paint group del pannello si
// perdono nel rebuild — raro, solo al cambio di allineamento — e il pannello
// li reinietta alla prossima apertura; i COLORI sopravvivono qui).
/**
 * @param {string} D @param {string} rectD
 * @param {{stroke: string, strokeOpacity: string|null, fill: string, fillOpacity: string|null, width: number, corners: 'round'|'sharp', dash: number, gap: number}} st
 * @param {'center'|'inside'|'outside'} effAlign @param {number} uid
 */
function buildStructure(D, rectD, st, effAlign, uid) {
  const fillA = `fill="${esc(st.fill)}"` + (st.fillOpacity ? ` fill-opacity="${esc(st.fillOpacity)}"` : '');
  const strokeA = `stroke="${esc(st.stroke)}"` + (st.strokeOpacity ? ` stroke-opacity="${esc(st.strokeOpacity)}"` : '');
  const caps = st.corners === 'sharp'
    ? 'stroke-linejoin="miter" stroke-linecap="butt"'
    : 'stroke-linejoin="round" stroke-linecap="round"';
  // il pattern corre LUNGO il path: non scala col ×2 dello spessore clippato
  const dashA = st.dash > 0 ? ` stroke-dasharray="${fmt(st.dash)} ${fmt(st.gap)}"` : '';
  if (effAlign === 'center') {
    return `<path data-fp-pen="fs" data-fp-pen-align="center" data-fp-pen-d="1" d="${D}" ` +
      `${fillA} ${strokeA} stroke-width="${st.width}"${dashA} ${caps}/>`;
  }
  const clipId = `fp-pen-clip-${uid}`;
  if (effAlign === 'inside') {
    // clip = il path stesso: dello spessore 2w resta visibile la metà interna
    return `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">` +
      `<path data-fp-pen-d="1" d="${D}"/></clipPath></defs>` +
      `<path data-fp-pen="fs" data-fp-pen-align="inside" data-fp-pen-d="1" d="${D}" ` +
      `${fillA} ${strokeA} stroke-width="${st.width * 2}"${dashA} clip-path="url(#${clipId})" ${caps}/>`;
  }
  // esterno: clip evenodd (rect − path) sul solo tratto; il fill vive su un
  // path separato non clippato
  return `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">` +
    `<path data-fp-pen-d="rect" clip-rule="evenodd" d="${rectD} ${D}"/></clipPath></defs>` +
    `<path data-fp-pen="f" data-fp-pen-align="outside" data-fp-pen-d="1" d="${D}" ${fillA} stroke="none"/>` +
    `<path data-fp-pen="s" data-fp-pen-align="outside" data-fp-pen-d="1" d="${D}" ` +
    `fill="none" ${strokeA} stroke-width="${st.width * 2}"${dashA} clip-path="url(#${clipId})" ${caps}/>`;
}

/** normalizza un colore CSS a #rrggbb per gli input color @param {string} v @param {string} fb */
export function cssColorToHex(v, fb) {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  const m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (m) {
    /** @param {string} n */
    const h = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }
  return fb;
}

export class PenTool {
  /** @param {App} app */
  constructor(app) {
    this.app = app;
    /** stile dei NUOVI tracciati; popup/pannello lo aggiornano e lo applicano anche al layer bersaglio @type {PenStyle} */
    this.style = { stroke: '#1a1a1f', width: 4, fill: 'none', align: 'center', corners: 'round', dash: 0, gap: 6 };
    /**
     * Sotto-strumento del rail Penna (lo setta UI._setPenSubTool):
     * 'draw' = penna normale, 'add' = inserisci ancora sul segmento,
     * 'remove' = elimina ancora, 'nodes' = selezione diretta (per ora la
     * fanno già i dot del gizmo).
     * @type {'draw'|'add'|'remove'|'nodes'}
     */
    this.subTool = 'draw';
    /** sessione di creazione: subpath aperto in coda @type {{layerId: number, path: number}|null} */
    this._creating = null;
    /**
     * Prima ancora PENDING (coordinate MONDO, maniglie relative in mondo):
     * vive solo nella sessione finché il secondo click non materializza il
     * subpath (o il layer). layerId = tracciato bersaglio, 0 = nuovo layer.
     * @type {{boardId: number, layerId: number, x: number, y: number, hi: {x:number,y:number}|null, ho: {x:number,y:number}|null, t: 'corner'|'smooth'}|null}
     */
    this._pending = null;
    /**
     * Gesto in corso: 'pend' (drag della prima ancora pending), 'create'
     * (nuova ancora dal canvas), 'close' (click di chiusura sul primo punto),
     * 'a'/'i'/'o' (drag di ancora/maniglia dal gizmo). Nessun riferimento a
     * punti: solo indici (p = subpath, i = punto).
     * t0 = tipo del punto all'inizio del gesto: Alt spezza SOLO finché è
     * premuto — al rilascio un punto nato liscio torna liscio (ricollineato).
     * @type {{kind: 'pend'|'create'|'close'|'a'|'i'|'o', layerId: number, p: number, i: number, first: boolean, moved: boolean, sx: number, sy: number, t0?: 'corner'|'smooth'}|null}
     */
    this._drag = null;
    /** @type {SvgItem|null} snapshot per l'entry undo del gesto in corso */
    this._before = null;
    /**
     * Tag della sessione di creazione corrente: finisce sulle entry undo
     * per-ancora (una per gesto, granulari mentre tracci) e alla CHIUSURA
     * della forma coalescePen le collassa in un'unità — undo/redo da lì in
     * poi trattano la forma intera, alla Illustrator.
     * @type {string}
     */
    this._sessTag = '';
    /** @type {SvgItem|null} snapshot per l'edit di stile dal popup */
    this._styleBefore = null;
    this._styleLayerId = 0;
    this._alt = false;
    this._shift = false;

    this._tmpW = { x: 0, y: 0 };
    this._tmpP = { x: 0, y: 0 };
    this._tmpS = { x: 0, y: 0 };
    this._tmpS2 = { x: 0, y: 0 };

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'pengizmo');
    svg.setAttribute('aria-hidden', 'true');
    this.svg = svg;
    // Scheletro del tracciato alla Illustrator: il d VERO del path (stesso
    // penD del markup, zero drift) portato a schermo con la matrice composta
    // viewBox→mondo→schermo — le affini trasformano le Bézier esattamente.
    // Spessore costante in px schermo via vector-effect; alone chiaro sotto
    // per la leggibilità sui fondi scuri (stesso pattern dei fili Spaces).
    this.skelG = document.createElementNS(SVG_NS, 'g');
    this.skelHaloEl = document.createElementNS(SVG_NS, 'path');
    this.skelHaloEl.setAttribute('class', 'pg-skel-halo');
    this.skelHaloEl.setAttribute('vector-effect', 'non-scaling-stroke');
    this.skelEl = document.createElementNS(SVG_NS, 'path');
    this.skelEl.setAttribute('class', 'pg-skel');
    this.skelEl.setAttribute('vector-effect', 'non-scaling-stroke');
    this.skelG.append(this.skelHaloEl, this.skelEl);
    this._skelD = '';
    this.spokesEl = document.createElementNS(SVG_NS, 'path');
    this.spokesEl.setAttribute('class', 'pg-spoke');
    this.rubberEl = document.createElementNS(SVG_NS, 'path');
    this.rubberEl.setAttribute('class', 'pg-rubber');
    svg.append(this.skelG, this.spokesEl, this.rubberEl);
    /** @type {SVGCircleElement[]} */
    this._dots = [];
    document.body.appendChild(svg);
    this._visible = false;
    this._sig = '';

    // Alt/Shift per la creazione passano da qui (il ring buffer non porta
    // modifier); i pallini del gizmo leggono e.altKey/e.shiftKey dai loro
    // eventi. Il preventDefault serve su ENTRAMBI i versi di Alt: su Windows
    // il menu del browser si attiva al KEYUP e mangerebbe il rilascio,
    // lasciando _alt appiccicato (curve che nascono spezzate "a caso").
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Alt') {
        this._alt = true;
        if (brush.tool === 'pen') e.preventDefault();
      }
      if (e.key === 'Shift') this._shift = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') {
        this._alt = false;
        if (brush.tool === 'pen') e.preventDefault();
      }
      if (e.key === 'Shift') this._shift = false;
    });
    window.addEventListener('blur', () => { this._alt = false; this._shift = false; });
  }

  // Risolve SEMPRE per id: il collab può sostituire l'oggetto svgItem e
  // l'undo può staccare il layer — un riferimento cachato scriverebbe su un
  // oggetto morto.
  /** @param {number} id @returns {Layer|null} */
  _layerOf(id) {
    const l = this.app.boards.layerById(id);
    return l && l.kind === 'svg' && l.svgItem && l.svgItem.pen ? l : null;
  }

  /** bersaglio del gizmo: il layer attivo se è un tracciato penna @returns {Layer|null} */
  get layer() {
    if (brush.tool !== 'pen' || this.app.ui?.spacesMode) return null;
    const l = this.app.layerMgr.active;
    return l && l.kind === 'svg' && l.visible && l.svgItem && l.svgItem.pen ? l : null;
  }

  get creating() {
    return !!this._pending || !!(this._creating && this._layerOf(this._creating.layerId));
  }

  /** il gesto corrente arriva dal ring del canvas (creazione/chiusura)? */
  get canvasDragging() {
    const k = this._drag ? this._drag.kind : '';
    return k === 'pend' || k === 'create' || k === 'close';
  }

  // Geometria cambiata: si riscrivono SOLO gli attributi d (elementi marcati
  // data-fp-pen-d), si stringono i bounds e si sveglia la pipeline. Se la
  // struttura non corrisponde più all'allineamento effettivo (chiusura del
  // primo subpath, cambio align, clip id di un layer duplicato) si
  // ricostruisce preservando lo stile letto dal markup.
  /** @param {Layer} layer */
  _refresh(layer) {
    const item = layer.svgItem;
    migratePen(item.pen);
    const st = readPenStyle(item) || {
      stroke: this.style.stroke, strokeOpacity: null,
      fill: this.style.fill, fillOpacity: null,
      width: this.style.width, align: alignOf(item.pen),
      corners: this.style.corners, builtAlign: 'center',
      dash: this.style.dash, gap: this.style.gap,
    };
    const effA = effAlignOf(item.pen);
    recomputeBounds(item, st.width, effA, st.corners);
    const D = penD(item.pen);
    const rectD = rectDOf(item);
    const clipOk = effA === 'center' || item.content.includes(`fp-pen-clip-${layer.id}"`);
    const host = parseContent(item.content);
    const s = strokeEl(host);
    const builtAlign = s ? (s.getAttribute('data-fp-pen-align') || 'center') : '';
    if (!s || builtAlign !== effA || !clipOk) {
      item.content = buildStructure(D, rectD, st, effA, layer.id);
    } else {
      const marked = host.querySelectorAll('[data-fp-pen-d]');
      if (marked.length) {
        for (const el of marked) {
          el.setAttribute('d', el.getAttribute('data-fp-pen-d') === 'rect' ? rectD + ' ' + D : D);
        }
      } else {
        s.setAttribute('d', D); // legacy v1: path singolo senza marker
      }
      item.content = host.innerHTML;
    }
    touchSvg(layer);
    this.app.planes.invalidate();
  }

  // Entry undo singola per gesto: snapshot prima/dopo dell'item intero,
  // stesso pattern di SvgUI (op 'svgitem', swap perfetto anche fuori ordine).
  // tag: solo per i gesti di CREAZIONE — marca l'entry come parte della
  // sessione, così la chiusura della forma può coalizzarle.
  /** @param {Layer} layer @param {SvgItem} before @param {string} [tag] */
  _commit(layer, before, tag) {
    if (!before || !layer.svgItem) return;
    if (JSON.stringify(before) === JSON.stringify(layer.svgItem)) return;
    const board = this.app.boards.boardOfLayer(layer.id);
    this.app.undoMgr.pushStruct(/** @type {any} */ ({
      op: 'svgitem', layerId: layer.id,
      boardId: board ? board.id : this.app.boards.activeId,
      si0: before, si1: structuredClone(layer.svgItem),
      penTag: tag || undefined,
    }));
    this.app.ui.layersUI.scheduleThumbs();
  }

  /**
   * converte una posa pending (mondo) nelle coordinate tracciato del layer
   * @param {SvgItem} item
   * @param {{x: number, y: number, hi: {x:number,y:number}|null, ho: {x:number,y:number}|null, t: 'corner'|'smooth'}} pend
   */
  _pendingToPoint(item, pend) {
    const a = penPosFromWorld(item, pend.x, pend.y, { x: 0, y: 0 });
    /** @param {{x:number,y:number}|null} h */
    const conv = (h) => {
      if (!h) return null;
      const q = penPosFromWorld(item, pend.x + h.x, pend.y + h.y, { x: 0, y: 0 });
      return { x: q.x - a.x, y: q.y - a.y };
    };
    return /** @type {PenPoint} */ ({ x: a.x, y: a.y, hi: conv(pend.hi), ho: conv(pend.ho), t: pend.t });
  }

  // ---- creazione (dal ring buffer, coordinate mondo) ----

  /** @param {Board} board @param {number} x @param {number} y */
  canvasDown(board, x, y) {
    if (this._drag) return;
    // Penna+ / Penna−: solo ritocco del tracciato attivo, mai pending o
    // nuove sessioni (il cambio di subtool ha già congedato la creazione)
    if (this.subTool === 'add') { this.addAnchorAt(x, y); return; }
    if (this.subTool === 'remove') { this.removeAnchorAt(x, y); return; }
    const cam = this.app.camera;

    // sessione di creazione viva?
    let cur = null;
    if (this._creating) {
      const l = this._layerOf(this._creating.layerId);
      const sp = l ? pathsOf(l.svgItem.pen)[this._creating.path] : null;
      if (l && sp && !sp.closed) cur = { layer: l, pi: this._creating.path, sp };
      else this._creating = null;
    }

    if (cur) {
      const item = cur.layer.svgItem;
      // click sul primo punto del subpath in corso = chiusura
      if (cur.sp.points.length >= 2) {
        const p0 = worldFromPenPos(item, cur.sp.points[0].x, cur.sp.points[0].y, this._tmpW);
        const s0 = cam.worldToScreen(p0.x, p0.y, this._tmpS);
        const sp = cam.worldToScreen(x, y, this._tmpS2);
        if (Math.hypot(s0.x - sp.x, s0.y - sp.y) <= CLOSE_PX) {
          this._before = structuredClone(item);
          migratePen(item.pen)[cur.pi].closed = true;
          this._refresh(cur.layer);
          this._drag = { kind: 'close', layerId: cur.layer.id, p: cur.pi, i: 0, first: false, moved: false, sx: x, sy: y };
          return;
        }
      }
      // nuova ancora; il drag fino al pointer-up tira le maniglie.
      // Shift: posizione vincolata a 45° rispetto all'ultima ancora (il
      // check di chiusura sopra resta sul punto RAW, il click è lì davvero)
      this._before = structuredClone(item);
      if (this._shift && cur.sp.points.length) {
        const last = cur.sp.points[cur.sp.points.length - 1];
        const lw = worldFromPenPos(item, last.x, last.y, this._tmpW);
        const s = snap45(x - lw.x, y - lw.y);
        x = lw.x + s.x;
        y = lw.y + s.y;
      }
      const p = penPosFromWorld(item, x, y, this._tmpP);
      const pts = migratePen(item.pen)[cur.pi].points;
      pts.push({ x: p.x, y: p.y, hi: null, ho: null, t: 'corner' });
      this._refresh(cur.layer);
      this._drag = { kind: 'create', layerId: cur.layer.id, p: cur.pi, i: pts.length - 1, first: false, moved: false, sx: x, sy: y };
      return;
    }

    if (this._pending) {
      // secondo click: materializza il subpath (o il layer)
      const pend = this._pending;
      // doppio click sullo stesso punto: resta pending, niente segmento nullo
      const a = cam.worldToScreen(pend.x, pend.y, this._tmpS);
      const b = cam.worldToScreen(x, y, this._tmpS2);
      if (Math.hypot(a.x - b.x, a.y - b.y) < DRAG_SLOP_PX) return;
      // Shift: la seconda ancora si vincola a 45° rispetto alla prima
      if (this._shift) {
        const s = snap45(x - pend.x, y - pend.y);
        x = pend.x + s.x;
        y = pend.y + s.y;
      }
      this._pending = null;

      const target = pend.layerId ? this._layerOf(pend.layerId) : null;
      const act = this.app.layerMgr.active;
      if (target && act && act.id === target.id && pend.boardId === board.id) {
        // si SOMMA nel tracciato attivo: nuovo subpath di due ancore
        const item = target.svgItem;
        this._before = structuredClone(item);
        const paths = migratePen(item.pen);
        const p0 = this._pendingToPoint(item, pend);
        const p1 = penPosFromWorld(item, x, y, this._tmpP);
        paths.push({ points: [p0, { x: p1.x, y: p1.y, hi: null, ho: null, t: 'corner' }], closed: false });
        this._refresh(target);
        this._creating = { layerId: target.id, path: paths.length - 1 };
        this._sessTag = 'ps' + (++sessSeq);
        this._drag = { kind: 'create', layerId: target.id, p: paths.length - 1, i: 1, first: false, moved: false, sx: x, sy: y };
        return;
      }

      // bootstrap: UN nuovo layer col primo tracciato vero (2 ancore, mondo
      // 1:1); da qui in poi tutto si accumula in questo layer
      if (!board.mgr.canAdd) return;
      /** @type {PenData} */
      const pen = {
        paths: [{
          points: [
            { x: pend.x, y: pend.y, hi: pend.hi, ho: pend.ho, t: pend.t },
            { x, y, hi: null, ho: null, t: 'corner' },
          ],
          closed: false,
        }],
        align: this.style.align,
      };
      /** @type {SvgItem} */
      const item = {
        content: '', // struttura e bounds veri li scrive _refresh (serve layer.id)
        viewX: pend.x, viewY: pend.y, viewW: 1, viewH: 1,
        x: pend.x, y: pend.y, w: 1, h: 1,
        m: [1, 0, 0, 1, 0, 0],
        pen,
      };
      const layer = makeSvgLayer(`Path ${++pathSeq}`, item);
      if (!this.app.addLayer(layer, board)) return; // MAX_LAYERS: fallisce in silenzio
      this._refresh(layer);
      this._creating = { layerId: layer.id, path: 0 };
      this._sessTag = 'ps' + (++sessSeq);
      this.app.undoMgr.tagPenTop(this._sessTag); // l'entry 'attach' fa parte della sessione
      this._drag = { kind: 'create', layerId: layer.id, p: 0, i: 1, first: true, moved: false, sx: x, sy: y };
      return;
    }

    // primo click: ancora PENDING, niente layer/subpath finché non ce n'è una seconda
    const act = this.app.layerMgr.active;
    const targetId = act && act.kind === 'svg' && act.visible && act.svgItem && act.svgItem.pen ? act.id : 0;
    this._pending = { boardId: board.id, layerId: targetId, x, y, hi: null, ho: null, t: 'corner' };
    this._drag = { kind: 'pend', layerId: targetId, p: 0, i: 0, first: false, moved: false, sx: x, sy: y };
    this.app.requestFrame();
  }

  /** @param {number} x @param {number} y */
  canvasMove(x, y) {
    const d = this._drag;
    if (!d) return;
    const cam = this.app.camera;

    if (d.kind === 'pend') {
      const pend = this._pending;
      if (!pend) { this._drag = null; return; }
      if (!d.moved) {
        const a = cam.worldToScreen(d.sx, d.sy, this._tmpS);
        const b = cam.worldToScreen(x, y, this._tmpS2);
        if (Math.hypot(a.x - b.x, a.y - b.y) < DRAG_SLOP_PX) return;
        d.moved = true;
      }
      let hx = x - pend.x, hy = y - pend.y;
      if (this._shift) {
        const s = snap45(hx, hy);
        hx = s.x;
        hy = s.y;
      }
      pend.ho = { x: hx, y: hy };
      if (this._alt) {
        pend.t = 'corner';
      } else {
        pend.t = 'smooth';
        pend.hi = { x: -hx, y: -hy };
      }
      this.app.requestFrame();
      return;
    }

    if (d.kind !== 'create') return; // la chiusura non trascina niente
    const layer = this._layerOf(d.layerId);
    if (!layer) { this._drag = null; this._before = null; return; }
    const item = layer.svgItem;
    const sp = pathsOf(item.pen)[d.p];
    const p = sp ? sp.points[d.i] : null;
    if (!p) return;
    if (!d.moved) {
      // slop in px schermo: sotto resta un click secco (corner senza maniglie)
      const a = cam.worldToScreen(d.sx, d.sy, this._tmpS);
      const b = cam.worldToScreen(x, y, this._tmpS2);
      if (Math.hypot(a.x - b.x, a.y - b.y) < DRAG_SLOP_PX) return;
      d.moved = true;
    }
    // Shift: la maniglia si vincola a 45° VISIVI (snap in mondo attorno
    // all'ancora, poi si riconverte — con m non identità l'angolo tracciato
    // non sarebbe quello che vedi)
    if (this._shift) {
      const aw = worldFromPenPos(item, p.x, p.y, this._tmpW);
      const s = snap45(x - aw.x, y - aw.y);
      x = aw.x + s.x;
      y = aw.y + s.y;
    }
    const w = penPosFromWorld(item, x, y, this._tmpP);
    const hx = w.x - p.x, hy = w.y - p.y;
    p.ho = { x: hx, y: hy };
    if (this._alt) {
      p.t = 'corner';                 // Alt (tenuto): solo la maniglia in uscita
    } else {
      p.t = 'smooth';
      p.hi = { x: -hx, y: -hy };      // creazione: specchio pieno, alla Illustrator
    }
    this._refresh(layer);
  }

  canvasUp() {
    const d = this._drag;
    if (!d || !this.canvasDragging) return;
    this._drag = null;
    if (d.kind === 'pend') return; // il pending resta in attesa del secondo click
    const before = this._before;
    this._before = null;
    const layer = this._layerOf(d.layerId);
    if (!layer) return;
    if (d.kind === 'close') {
      // forma CHIUSA = unità: le entry per-ancora della sessione collassano
      // (mentre tracci l'undo resta granulare, un'ancora alla volta)
      const tag = this._sessTag;
      this._creating = null;
      this._commit(layer, before, tag);
      this.app.undoMgr.coalescePen(tag);
      return;
    }
    if (d.first) return; // primo tracciato del layer: basta l'entry 'attach'
    this._commit(layer, before, this._sessTag);
  }

  canvasCancel() {
    const d = this._drag;
    if (!d || !this.canvasDragging) return;
    this._drag = null;
    if (d.kind === 'pend') { this._pending = null; return; }
    const before = this._before;
    this._before = null;
    const layer = this._layerOf(d.layerId);
    if (!layer || !before) return;
    // ripristina lo stato fotografato al pen-down (stessa via di setSvgItem)
    layer.svgItem = structuredClone(before);
    layer.svgDirty = true;
    layer.ver = (layer.ver || 0) + 1;
    layer.thumbDirty = true;
    this.app.planes.invalidate();
  }

  /** chiude la sessione di creazione lasciando il tracciato APERTO (Esc/Enter/cambio tool) */
  finishPath() {
    const had = !!this._pending || !!this._creating;
    this._pending = null;
    this._creating = null;
    return had;
  }

  /**
   * Undo con la prima ancora PENDING: si toglie quella (è solo stato di
   * sessione, non ha entry) invece di annullare l'azione precedente sotto.
   * @returns {boolean} true = consumato
   */
  dropPending() {
    if (!this._pending || this._drag) return false;
    this._pending = null;
    this.app.requestFrame();
    return true;
  }

  // ---- Penna+ / Penna− (subTool 'add'/'remove' dal rail Penna) ----

  /**
   * Punto più vicino sul tracciato in px schermo: segmento (p, i→i+1) e
   * parametro t. Le rette usano la proiezione esatta; le curve un
   * campionamento con raffinamento locale — il t trovato a schermo vale
   * anche in coordinate tracciato (le affini preservano il parametro).
   * @param {Layer} layer @param {number} sx @param {number} sy @param {number} maxPx
   * @returns {{p: number, i: number, t: number, d2: number, line: boolean}|null}
   */
  _hitSegment(layer, sx, sy, maxPx) {
    const item = layer.svgItem;
    const cam = this.app.camera;
    /** @param {number} px @param {number} py */
    const scr = (px, py) => {
      const w = worldFromPenPos(item, px, py, this._tmpW);
      return cam.worldToScreen(w.x, w.y, { x: 0, y: 0 });
    };
    const paths = pathsOf(item.pen);
    /** @type {{p: number, i: number, t: number, d2: number, line: boolean}|null} */
    let best = null;
    for (let pi = 0; pi < paths.length; pi++) {
      const sp = paths[pi];
      const n = sp.points.length;
      const segs = sp.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = sp.points[i], b = sp.points[(i + 1) % n];
        const A = scr(a.x, a.y);
        const B = scr(b.x, b.y);
        // t lontano dagli estremi: uno split a ridosso dell'ancora
        // produrrebbe maniglie degeneri
        if (!a.ho && !b.hi) {
          const dx = B.x - A.x, dy = B.y - A.y;
          const len2 = dx * dx + dy * dy || 1;
          const t = Math.max(0.02, Math.min(0.98, ((sx - A.x) * dx + (sy - A.y) * dy) / len2));
          const d2 = (A.x + dx * t - sx) ** 2 + (A.y + dy * t - sy) ** 2;
          if (!best || d2 < best.d2) best = { p: pi, i, t, d2, line: true };
          continue;
        }
        const C1 = scr(a.x + (a.ho ? a.ho.x : 0), a.y + (a.ho ? a.ho.y : 0));
        const C2 = scr(b.x + (b.hi ? b.hi.x : 0), b.y + (b.hi ? b.hi.y : 0));
        /** @param {number} t */
        const d2At = (t) => {
          const u = 1 - t;
          const bx = u * u * u * A.x + 3 * u * u * t * C1.x + 3 * u * t * t * C2.x + t * t * t * B.x;
          const by = u * u * u * A.y + 3 * u * u * t * C1.y + 3 * u * t * t * C2.y + t * t * t * B.y;
          return (bx - sx) ** 2 + (by - sy) ** 2;
        };
        let bt = 0, bd = Infinity;
        for (let k = 0; k <= 32; k++) {
          const t = k / 32;
          const d2 = d2At(t);
          if (d2 < bd) { bd = d2; bt = t; }
        }
        for (let span = 1 / 32; span > 1e-3; span /= 4) {
          for (let k = -3; k <= 3; k++) {
            const t = Math.min(1, Math.max(0, bt + span * k / 3));
            const d2 = d2At(t);
            if (d2 < bd) { bd = d2; bt = t; }
          }
        }
        const t = Math.max(0.02, Math.min(0.98, bt));
        const d2 = d2At(t);
        if (!best || d2 < best.d2) best = { p: pi, i, t, d2, line: false };
      }
    }
    return best && best.d2 <= maxPx * maxPx ? best : null;
  }

  /**
   * Penna+: inserisce un'ancora nel punto cliccato SENZA cambiare la forma
   * (split De Casteljau al parametro del click; sulla retta il punto nasce
   * senza maniglie). @param {number} x @param {number} y mondo
   */
  addAnchorAt(x, y) {
    const layer = this.layer;
    if (!layer) return false;
    const s = this.app.camera.worldToScreen(x, y, this._tmpS);
    const hit = this._hitSegment(layer, s.x, s.y, EDIT_HIT_PX);
    if (!hit) return false;
    const item = layer.svgItem;
    const before = structuredClone(item);
    const sp = migratePen(item.pen)[hit.p];
    const pts = sp.points;
    const a = pts[hit.i], b = pts[(hit.i + 1) % pts.length];
    const t = hit.t;
    /** @type {PenPoint} */
    let np;
    if (hit.line) {
      np = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, hi: null, ho: null, t: 'corner' };
    } else {
      const p1x = a.x + (a.ho ? a.ho.x : 0), p1y = a.y + (a.ho ? a.ho.y : 0);
      const p2x = b.x + (b.hi ? b.hi.x : 0), p2y = b.y + (b.hi ? b.hi.y : 0);
      /** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
      const L = (ax, ay, bx, by) => [ax + (bx - ax) * t, ay + (by - ay) * t];
      const [q0x, q0y] = L(a.x, a.y, p1x, p1y);
      const [q1x, q1y] = L(p1x, p1y, p2x, p2y);
      const [q2x, q2y] = L(p2x, p2y, b.x, b.y);
      const [r0x, r0y] = L(q0x, q0y, q1x, q1y);
      const [r1x, r1y] = L(q1x, q1y, q2x, q2y);
      const [nx, ny] = L(r0x, r0y, r1x, r1y);
      // maniglie ~0 → null (niente C degeneri nel markup)
      /** @param {number} vx @param {number} vy */
      const vec = (vx, vy) => (Math.hypot(vx, vy) < 1e-6 ? null : { x: vx, y: vy });
      a.ho = vec(q0x - a.x, q0y - a.y);
      b.hi = vec(q2x - b.x, q2y - b.y);
      const hi = vec(r0x - nx, r0y - ny);
      const ho = vec(r1x - nx, r1y - ny);
      // r0-S-r1 sono collineari per costruzione: il punto nasce liscio
      np = { x: nx, y: ny, hi, ho, t: hi && ho ? 'smooth' : 'corner' };
    }
    pts.splice(hit.i + 1, 0, np);
    this._refresh(layer);
    this._commit(layer, before);
    return true;
  }

  /** Penna−: rimuove l'ancora più vicina al click @param {number} x @param {number} y mondo */
  removeAnchorAt(x, y) {
    const layer = this.layer;
    if (!layer) return false;
    const cam = this.app.camera;
    const s = cam.worldToScreen(x, y, this._tmpS);
    const item = layer.svgItem;
    const paths = pathsOf(item.pen);
    /** @type {{p: number, i: number, d2: number}|null} */
    let best = null;
    for (let pi = 0; pi < paths.length; pi++) {
      const pts = paths[pi].points;
      for (let i = 0; i < pts.length; i++) {
        const w = worldFromPenPos(item, pts[i].x, pts[i].y, this._tmpW);
        const q = cam.worldToScreen(w.x, w.y, this._tmpS2);
        const d2 = (q.x - s.x) ** 2 + (q.y - s.y) ** 2;
        if (!best || d2 < best.d2) best = { p: pi, i, d2 };
      }
    }
    if (!best || best.d2 > EDIT_HIT_PX * EDIT_HIT_PX) return false;
    this._removeAnchor(layer, best.p, best.i);
    return true;
  }

  /** @param {Layer} layer @param {number} pi @param {number} i */
  _removeAnchor(layer, pi, i) {
    const item = layer.svgItem;
    const before = structuredClone(item);
    const paths = migratePen(item.pen);
    const sp = paths[pi];
    if (!sp || !sp.points[i]) return;
    sp.points.splice(i, 1);
    // un'ancora sola non disegna niente: via il subpath intero
    if (sp.points.length < 2) paths.splice(pi, 1);
    this._refresh(layer);
    this._commit(layer, before);
  }

  // ---- editing dal gizmo (pointer capture sui pallini, mai dal ring) ----

  _makeDot() {
    const c = /** @type {SVGCircleElement} */ (document.createElementNS(SVG_NS, 'circle'));
    c.addEventListener('pointerdown', (e) => this._dotDown(e, c));
    c.addEventListener('pointermove', (e) => this._dotMove(e));
    const up = () => this._dotUp();
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', () => this._dotCancel());
    this.svg.appendChild(c);
    return c;
  }

  /** @param {PointerEvent} e @param {SVGCircleElement} c */
  _dotDown(e, c) {
    if (this._drag) return;
    const layer = this.layer;
    if (!layer || layer.id !== Number(c.dataset.l)) return;
    // Penna−: il click sul pallino dell'ancora la elimina (niente drag)
    if (this.subTool === 'remove' && c.dataset.k === 'a') {
      e.preventDefault();
      e.stopPropagation();
      this._removeAnchor(layer, Number(c.dataset.p), Number(c.dataset.i));
      return;
    }
    try { c.setPointerCapture(e.pointerId); } catch { /* pointer già morto */ }
    e.preventDefault();
    e.stopPropagation();
    this._before = structuredClone(layer.svgItem);
    const p = Number(c.dataset.p), i = Number(c.dataset.i);
    const pt = pathsOf(layer.svgItem.pen)[p]?.points[i];
    this._drag = {
      kind: /** @type {'a'|'i'|'o'} */ (c.dataset.k), layerId: layer.id,
      p, i, first: false, moved: false, sx: 0, sy: 0,
      t0: pt ? pt.t : 'corner',
    };
  }

  /** @param {PointerEvent} e */
  _dotMove(e) {
    const d = this._drag;
    if (!d || (d.kind !== 'a' && d.kind !== 'i' && d.kind !== 'o')) return;
    const layer = this._layerOf(d.layerId);
    if (!layer) return;
    e.preventDefault();
    const item = layer.svgItem;
    const sp = pathsOf(item.pen)[d.p];
    const p = sp ? sp.points[d.i] : null;
    if (!p) return;
    const w = this.app.camera.screenToWorld(e.clientX, e.clientY, this._tmpW);
    if (e.shiftKey) {
      // Shift: 45° visivi — riferimento = l'ancora per le maniglie, la
      // posizione d'inizio gesto (snapshot _before) per l'ancora stessa
      const p0 = d.kind === 'a'
        ? (this._before ? pathsOf(this._before.pen)[d.p]?.points[d.i] : null)
        : p;
      if (p0) {
        const rw = worldFromPenPos(item, p0.x, p0.y, this._tmpS2);
        const s = snap45(w.x - rw.x, w.y - rw.y);
        w.x = rw.x + s.x;
        w.y = rw.y + s.y;
      }
    }
    const pos = penPosFromWorld(item, w.x, w.y, this._tmpP);
    if (d.kind === 'a') {
      p.x = pos.x;
      p.y = pos.y;  // maniglie relative: seguono gratis
    } else {
      const hx = pos.x - p.x, hy = pos.y - p.y;
      if (d.kind === 'o') p.ho = { x: hx, y: hy };
      else p.hi = { x: hx, y: hy };
      if (e.altKey) {
        p.t = 'corner';               // Alt TENUTO: spezza la simmetria
      } else {
        // Alt rilasciato: un punto nato liscio torna liscio; da liscio la
        // maniglia opposta si ricollinea (direzione specchiata, lunghezza sua)
        if (d.t0 === 'smooth') p.t = 'smooth';
        if (p.t === 'smooth') {
          const other = d.kind === 'o' ? p.hi : p.ho;
          if (other) {
            const len = Math.hypot(other.x, other.y);
            const cur = Math.hypot(hx, hy) || 1;
            other.x = -hx / cur * len;
            other.y = -hy / cur * len;
          }
        }
      }
    }
    this._refresh(layer);
  }

  _dotUp() {
    const d = this._drag;
    if (!d || (d.kind !== 'a' && d.kind !== 'i' && d.kind !== 'o')) return;
    this._drag = null;
    const before = this._before;
    this._before = null;
    const layer = this._layerOf(d.layerId);
    if (layer && before) this._commit(layer, before);
  }

  _dotCancel() {
    const d = this._drag;
    if (!d || (d.kind !== 'a' && d.kind !== 'i' && d.kind !== 'o')) return;
    this._drag = null;
    const before = this._before;
    this._before = null;
    const layer = this._layerOf(d.layerId);
    if (!layer || !before) return;
    layer.svgItem = structuredClone(before);
    layer.svgDirty = true;
    layer.ver = (layer.ver || 0) + 1;
    layer.thumbDirty = true;
    this.app.planes.invalidate();
  }

  // ---- stile (popup della toolbar E pannello SVG; stesso begin/commit) ----
  // Il pannello passa il layer esplicito: deve funzionare anche quando il
  // tool attivo NON è la penna (this.layer sarebbe null).

  /** un edit di stile è in corso (slider/color in drag): i sync esterni non devono sovrascrivere */
  get styleEditing() {
    return !!this._styleBefore;
  }

  /** @param {Layer|null|undefined} layer @returns {Layer|null} */
  _styleTarget(layer) {
    const l = layer !== undefined ? layer : this.layer;
    return l && l.kind === 'svg' && l.svgItem && l.svgItem.pen ? l : null;
  }

  /** stile del tracciato bersaglio (dal markup) o null @param {Layer|null} [layer] @returns {PenStyle|null} */
  readActiveStyle(layer) {
    const l = this._styleTarget(layer);
    if (!l) return null;
    const st = readPenStyle(l.svgItem);
    return st ? { stroke: st.stroke, width: st.width, fill: st.fill, align: st.align, corners: st.corners, dash: st.dash, gap: st.gap } : null;
  }

  /** @param {Layer|null} [layer] */
  beginStyleEdit(layer) {
    const l = this._styleTarget(layer);
    if (!l || this._styleBefore) return;
    this._styleBefore = structuredClone(l.svgItem);
    this._styleLayerId = l.id;
  }

  /**
   * Aggiorna i default dei nuovi tracciati e, se c'è, il layer bersaglio.
   * @param {{stroke?: string, width?: number, fill?: string, align?: 'center'|'inside'|'outside', corners?: 'round'|'sharp', dash?: number, gap?: number}} patch
   * @param {Layer|null} [layer]
   */
  applyStyle(patch, layer) {
    if (patch.stroke !== undefined) this.style.stroke = patch.stroke;
    if (patch.width !== undefined) this.style.width = patch.width;
    if (patch.fill !== undefined) this.style.fill = patch.fill;
    if (patch.align !== undefined) this.style.align = patch.align;
    if (patch.corners !== undefined) this.style.corners = patch.corners;
    if (patch.dash !== undefined) this.style.dash = patch.dash;
    if (patch.gap !== undefined) this.style.gap = patch.gap;
    const l = this._styleTarget(layer);
    if (!l) return;
    const item = l.svgItem;
    migratePen(item.pen);
    if (patch.align !== undefined) item.pen.align = patch.align;
    const host = parseContent(item.content);
    const s = strokeEl(host);
    const f = fillEl(host);
    if (s && patch.stroke !== undefined) s.setAttribute('stroke', patch.stroke);
    if (f && patch.fill !== undefined) f.setAttribute('fill', patch.fill);
    if (s && patch.width !== undefined) {
      const builtAlign = s.getAttribute('data-fp-pen-align') || 'center';
      s.setAttribute('stroke-width', String(patch.width * (builtAlign === 'center' ? 1 : 2)));
    }
    if (s && patch.corners !== undefined) {
      s.setAttribute('stroke-linejoin', patch.corners === 'sharp' ? 'miter' : 'round');
      s.setAttribute('stroke-linecap', patch.corners === 'sharp' ? 'butt' : 'round');
    }
    if (s && (patch.dash !== undefined || patch.gap !== undefined)) {
      // il valore non patchato si legge dal markup (fallback: default del tool)
      const cur = parseDash(s.getAttribute('stroke-dasharray'));
      const dash = patch.dash !== undefined ? patch.dash : (cur.dash || this.style.dash);
      const gap = patch.gap !== undefined ? patch.gap : (cur.gap || this.style.gap);
      if (dash > 0) s.setAttribute('stroke-dasharray', `${fmt(dash)} ${fmt(Math.max(0, gap))}`);
      else s.removeAttribute('stroke-dasharray');
    }
    item.content = host.innerHTML;
    this._refresh(l); // bounds/rect del clip/struttura (align) si sistemano qui
  }

  commitStyleEdit() {
    const before = this._styleBefore;
    const id = this._styleLayerId;
    this._styleBefore = null;
    this._styleLayerId = 0;
    if (!before || !id) return;
    const l = this._layerOf(id);
    if (!l) return;
    this._commit(l, before);
  }

  // ---- overlay (una volta per frame dal frame loop, uscita a firma) ----

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.svg.style.display = 'none';
    this._sig = '';
  }

  /** @param {Camera} cam */
  sync(cam) {
    // le sessioni muoiono se il bersaglio sparisce (undo/collab) o cambia
    // (pannello livelli, altro board, altro tool)
    const act = this.app.layerMgr.active;
    if (this._creating) {
      const l = this._layerOf(this._creating.layerId);
      const sp = l ? pathsOf(l.svgItem.pen)[this._creating.path] : null;
      if (!l || !sp || sp.closed || !act || act.id !== l.id || brush.tool !== 'pen') this._creating = null;
    }
    if (this._pending && !(this._drag && this._drag.kind === 'pend')) {
      const pend = this._pending;
      if (brush.tool !== 'pen' || this.app.ui?.spacesMode ||
        this.app.boards.activeId !== pend.boardId ||
        (pend.layerId !== 0 && (!act || act.id !== pend.layerId))) {
        this._pending = null;
      }
    }
    const layer = this.layer;
    const pend = this._pending;
    if (!layer && !pend) {
      this.hide();
      return;
    }
    const item = layer ? layer.svgItem : null;
    const pen = item ? item.pen : null;
    const paths = pen ? pathsOf(pen) : [];
    const creating = !!(this._creating && layer && this._creating.layerId === layer.id);
    const curPi = creating ? this._creating.path : -1;
    const hover = this.app.input.hover;
    const rubber = hover.visible && !this._drag && (creating || !!pend);
    const pathsSig = paths.map((sp) => sp.points.length + (sp.closed ? 'c' : 'o')).join('.');
    const sig = `${cam.x}|${cam.y}|${cam.zoom}|${cam.w}|${cam.h}|` +
      `${layer ? `${layer.id}|${layer.ver || 0}|${pathsSig}` : 'L0'}|${creating ? curPi : -1}|` +
      (pend ? `P${fmt(pend.x)},${fmt(pend.y)},${pend.ho ? fmt(pend.ho.x) + ',' + fmt(pend.ho.y) : 'n'}` : '') + '|' +
      (rubber ? `${Math.round(hover.x)}|${Math.round(hover.y)}|${this._shift ? 1 : 0}` : '');
    if (sig === this._sig && this._visible) return;
    this._sig = sig;
    if (!this._visible) {
      this._visible = true;
      this.svg.style.display = 'block';
    }
    this.svg.classList.toggle('pg-creating', creating || !!pend);

    // scheletro: d riscritto solo quando la geometria cambia davvero (il ver
    // scatta anche per soli cambi di stile), la matrice segue la camera
    if (item) {
      const D = penD(pen);
      if (D !== this._skelD) {
        this._skelD = D;
        this.skelHaloEl.setAttribute('d', D || 'M 0 0');
        this.skelEl.setAttribute('d', D || 'M 0 0');
      }
      // T1: viewBox → rect dell'item; m: rect → mondo; T3: mondo → schermo
      const kx = item.w / item.viewW, ky = item.h / item.viewH;
      const m = item.m || [1, 0, 0, 1, 0, 0];
      const a1 = m[0] * kx, b1 = m[1] * kx, c1 = m[2] * ky, d1 = m[3] * ky;
      const tx = m[0] * (item.x - item.viewX * kx) + m[2] * (item.y - item.viewY * ky) + m[4];
      const ty = m[1] * (item.x - item.viewX * kx) + m[3] * (item.y - item.viewY * ky) + m[5];
      const z = cam.zoom;
      const ox = cam.w * 0.5 + cam.ox - cam.x * z;
      const oy = cam.h * 0.5 + cam.oy - cam.y * z;
      this.skelG.setAttribute('transform',
        `matrix(${z * a1} ${z * b1} ${z * c1} ${z * d1} ${z * tx + ox} ${z * ty + oy})`);
      if (this.skelG.style.display) this.skelG.style.display = '';
    } else if (this.skelG.style.display !== 'none') {
      this.skelG.style.display = 'none';
      this._skelD = '';
    }

    // primo punto del subpath in corso "caldo" quando il click chiuderebbe
    let closeHot = false;
    if (creating && hover.visible) {
      const sp = paths[curPi];
      if (sp && sp.points.length >= 2) {
        const p0 = worldFromPenPos(item, sp.points[0].x, sp.points[0].y, this._tmpW);
        const s0 = cam.worldToScreen(p0.x, p0.y, this._tmpS);
        closeHot = Math.hypot(s0.x - hover.x, s0.y - hover.y) <= CLOSE_PX;
      }
    }

    let spokes = '';
    let di = 0;
    /** @param {number} pi @param {number} i @param {'a'|'i'|'o'} k @param {number} cx @param {number} cy @param {number} r @param {number} lid */
    const place = (pi, i, k, cx, cy, r, lid) => {
      while (this._dots.length <= di) this._dots.push(this._makeDot());
      const c = this._dots[di++];
      c.setAttribute('class', k === 'a' ? 'pg-a' : 'pg-h');
      c.setAttribute('r', String(r));
      c.setAttribute('cx', String(Math.round(cx * 10) / 10));
      c.setAttribute('cy', String(Math.round(cy * 10) / 10));
      c.dataset.p = String(pi);
      c.dataset.i = String(i);
      c.dataset.k = k;
      c.dataset.l = String(lid);
      if (c.style.display) c.style.display = '';
    };
    for (let pi = 0; pi < paths.length; pi++) {
      const pts = paths[pi].points;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const aw = worldFromPenPos(item, p.x, p.y, this._tmpW);
        const ax = (aw.x - cam.x) * cam.zoom + cam.w * 0.5 + cam.ox;
        const ay = (aw.y - cam.y) * cam.zoom + cam.h * 0.5 + cam.oy;
        for (const [k, h] of /** @type {['i'|'o', {x:number,y:number}|null][]} */ ([['i', p.hi], ['o', p.ho]])) {
          if (!h) continue;
          const hw = worldFromPenPos(item, p.x + h.x, p.y + h.y, this._tmpW);
          const hs = cam.worldToScreen(hw.x, hw.y, this._tmpS);
          spokes += `M ${ax} ${ay} L ${hs.x} ${hs.y} `;
          place(pi, i, k, hs.x, hs.y, HANDLE_R, layer.id);
        }
        const hot = pi === curPi && i === 0 && closeHot;
        place(pi, i, 'a', ax, ay, hot ? FIRST_HOT_R : ANCHOR_R, layer.id);
      }
    }
    // ancora pending: solo visuale (dataset.l = 0 non passa la guardia dei dot)
    if (pend) {
      const ps = cam.worldToScreen(pend.x, pend.y, this._tmpS);
      const px = ps.x, py = ps.y;
      for (const [k, h] of /** @type {['i'|'o', {x:number,y:number}|null][]} */ ([['i', pend.hi], ['o', pend.ho]])) {
        if (!h) continue;
        const hs = cam.worldToScreen(pend.x + h.x, pend.y + h.y, this._tmpS2);
        spokes += `M ${px} ${py} L ${hs.x} ${hs.y} `;
        place(0, 0, k, hs.x, hs.y, HANDLE_R, 0);
      }
      place(0, 0, 'a', px, py, ANCHOR_R, 0);
    }
    for (let j = di; j < this._dots.length; j++) {
      if (this._dots[j].style.display !== 'none') this._dots[j].style.display = 'none';
    }
    this.spokesEl.setAttribute('d', spokes || 'M 0 0');

    // elastico: dall'ultima ancora (o dalla pending) al cursore
    let dAttr = '';
    if (rubber) {
      /** @type {{x:number,y:number}|null} */
      let ls = null;
      /** @type {{x:number,y:number}|null} */
      let cs = null;
      if (creating) {
        const sp = paths[curPi];
        const last = sp ? sp.points[sp.points.length - 1] : null;
        if (last) {
          const lw = worldFromPenPos(item, last.x, last.y, this._tmpW);
          ls = { x: 0, y: 0 };
          cam.worldToScreen(lw.x, lw.y, ls);
          if (last.ho) {
            const cw = worldFromPenPos(item, last.x + last.ho.x, last.y + last.ho.y, this._tmpW);
            cs = { x: 0, y: 0 };
            cam.worldToScreen(cw.x, cw.y, cs);
          }
        }
      } else if (pend) {
        ls = { x: 0, y: 0 };
        cam.worldToScreen(pend.x, pend.y, ls);
        if (pend.ho) {
          cs = { x: 0, y: 0 };
          cam.worldToScreen(pend.x + pend.ho.x, pend.y + pend.ho.y, cs);
        }
      }
      if (ls) {
        // Shift: l'anteprima si vincola come farà il click (angoli conformi:
        // lo snap in px schermo equivale a quello in mondo, lo zoom è uniforme)
        let ex = hover.x, ey = hover.y;
        if (this._shift) {
          const s = snap45(hover.x - ls.x, hover.y - ls.y);
          ex = ls.x + s.x;
          ey = ls.y + s.y;
        }
        dAttr = cs
          ? `M ${ls.x} ${ls.y} C ${cs.x} ${cs.y} ${ex} ${ey} ${ex} ${ey}`
          : `M ${ls.x} ${ls.y} L ${ex} ${ey}`;
      }
    }
    if (dAttr) this.rubberEl.setAttribute('d', dAttr);
    else if (this.rubberEl.getAttribute('d')) this.rubberEl.setAttribute('d', '');
  }
}
