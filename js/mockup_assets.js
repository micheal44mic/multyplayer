const MOCKUP_ROOT = 'assets/mockups';

/**
 * @typedef {Object} MockupSource
 * @property {string} folder
 * @property {Record<string, string>} labels
 * @property {string[]} files
 */

/** @type {Record<string, MockupSource>} */
const SOURCE_SETS = {
  bodyTee: {
    folder: 'tees',
    labels: { tee: 'Tee' },
    files: [
      ...pairedFiles('tee', 1, 15),
      ...viewFiles('tee', [16], ['front']),
    ],
  },
  bodyHoodie: {
    folder: 'body-hoodies',
    labels: {
      sweatshirt: 'Sweatshirt',
      'sweatshirt-or-bomber': 'Sweatshirt or bomber',
      'sweatshirt-bomber-jacket': 'Sweatshirt bomber jacket',
      'bomber-jacket': 'Bomber jacket',
    },
    files: [
      ...pairedFiles('sweatshirt', 1, 9),
      ...pairedFiles('sweatshirt-or-bomber', 1, 1),
      ...pairedFiles('sweatshirt-bomber-jacket', 2, 2),
      ...pairedFiles('bomber-jacket', 3, 3),
    ],
  },
  pufferJacket: {
    folder: 'puffer-jackets',
    labels: { 'puffer-jacket': 'Puffer jacket' },
    files: pairedFiles('puffer-jacket', 1, 4),
  },
  hood: {
    folder: 'hoods',
    labels: { hood: 'Hood' },
    files: pairedFiles('hood', 1, 38),
  },
  jacketHood: {
    folder: 'jacket-hoods',
    labels: { 'jacket-hood': 'Jacket hood' },
    files: [
      ...pairedFiles('jacket-hood', 1, 18),
      ...viewFiles('jacket-hood', range(19, 28), ['front']),
    ],
  },
  collar: {
    folder: 'collars',
    labels: { collar: 'Collar' },
    files: pairedFiles('collar', 1, 33),
  },
  pocket: {
    folder: 'pockets',
    labels: {
      pocket: 'Pocket',
      'headpocket-close': 'Head pocket close',
      'headpocket-open': 'Head pocket open',
      'pocket-zip': 'Pocket zip',
    },
    files: [
      ...numberedFiles('pocket', [...range(1, 138), ...range(140, 157)], 3),
      ...numberedFiles('headpocket-close', range(1, 28)),
      ...numberedFiles('headpocket-open', [1, ...range(16, 39)]),
      ...numberedFiles('pocket-zip', range(5, 8)),
    ],
  },
  accessory: {
    folder: 'accessories',
    labels: {
      button: 'Button',
      'button-seam': 'Button seam',
      cord: 'Cord',
      'cord-lock': 'Cord lock',
      hangtag: 'Hangtag',
      label: 'Label',
    },
    files: [
      ...numberedFiles('button', range(1, 32)),
      'button-seam.png',
      ...numberedFiles('cord', range(1, 6)),
      ...numberedFiles('cord-lock', range(1, 31)),
      ...numberedFiles('hangtag', range(1, 10)),
      ...numberedFiles('label', range(1, 6)),
    ],
  },
};

export const MOCKUP_ASSETS = Object.fromEntries(
  Object.entries(SOURCE_SETS).map(([kind, source]) => [
    kind,
    source.files.map((fileName) => makeAssetItem(kind, source, fileName)),
  ]),
);

/** @param {string} kind @param {MockupSource} source @param {string} fileName */
function makeAssetItem(kind, source, fileName) {
  const stem = fileName.replace(/\.png$/i, '');
  const match = stem.match(/^(.+)-(\d+)(?:-(front|back))?$/);
  const series = match ? match[1] : stem;
  const number = match ? Number(match[2]) : 0;
  const view = match && match[3] ? match[3] : 'front';
  const label = source.labels[series] || series.replace(/-/g, ' ');
  return {
    id: `${kind}-${series}-${String(number).padStart(3, '0')}-${view}`,
    kind,
    variant: number ? number - 1 : 0,
    view,
    name: `${label}${number ? ` ${number}` : ''}${view === 'back' ? ' back' : ''}`,
    size: '',
    src: `${MOCKUP_ROOT}/${source.folder}/${fileName}`,
    fileName,
  };
}

/** @param {string} prefix @param {number} from @param {number} to @param {number} [width] */
function pairedFiles(prefix, from, to, width = 2) {
  return viewFiles(prefix, range(from, to), ['back', 'front'], width);
}

/** @param {string} prefix @param {number[]} numbers @param {string[]} views @param {number} [width] */
function viewFiles(prefix, numbers, views, width = 2) {
  return numbers.flatMap((n) => views.map((view) => `${prefix}-${pad(n, width)}-${view}.png`));
}

/** @param {string} prefix @param {number[]} numbers @param {number} [width] */
function numberedFiles(prefix, numbers, width = 2) {
  return numbers.map((n) => `${prefix}-${pad(n, width)}.png`);
}

/** @param {number} from @param {number} to */
function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** @param {number} value @param {number} width */
function pad(value, width) {
  return String(value).padStart(width, '0');
}
