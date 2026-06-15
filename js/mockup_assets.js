const MOCKUP_ROOT = 'assets/mockups';

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
  hood: {
    folder: 'hoods',
    labels: {
      hood: 'Hood',
      'jacket-hood': 'Jacket hood',
    },
    files: [
      ...pairedFiles('hood', 1, 38),
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
};

export const MOCKUP_ASSETS = Object.fromEntries(
  Object.entries(SOURCE_SETS).map(([kind, source]) => [
    kind,
    source.files.map((fileName) => makeAssetItem(kind, source, fileName)),
  ]),
);

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
    variant: number - 1,
    view,
    name: `${label}${number ? ` ${number}` : ''}${view === 'back' ? ' back' : ''}`,
    size: '',
    src: `${MOCKUP_ROOT}/${source.folder}/${fileName}`,
    fileName,
  };
}

function pairedFiles(prefix, from, to, width = 2) {
  return viewFiles(prefix, range(from, to), ['back', 'front'], width);
}

function viewFiles(prefix, numbers, views, width = 2) {
  return numbers.flatMap((n) => views.map((view) => `${prefix}-${pad(n, width)}-${view}.png`));
}

function numberedFiles(prefix, numbers, width = 2) {
  return numbers.map((n) => `${prefix}-${pad(n, width)}.png`);
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}
