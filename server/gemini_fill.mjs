import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_BODY_BYTES = 18 * 1024 * 1024;
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
]);

function loadEnvFile(name) {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (process.env[key] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

function getApiKey() {
  return process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    '';
}

function getModel() {
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
  return ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanBase64(value) {
  return String(value || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').trim();
}

function validatePayload(input) {
  const prompt = String(input.prompt || '').trim();
  const imageBase64 = cleanBase64(input.imageBase64);
  const maskBase64 = cleanBase64(input.maskBase64);
  const width = Number(input.width) || 0;
  const height = Number(input.height) || 0;
  const model = String(input.model || '').trim();

  if (prompt.length < 2) throw Object.assign(new Error('Scrivi cosa vuoi aggiungere nella selezione.'), { status: 400 });
  if (prompt.length > 1200) throw Object.assign(new Error('Prompt troppo lungo.'), { status: 400 });
  if (!imageBase64 || !maskBase64) throw Object.assign(new Error('Manca immagine o maschera.'), { status: 400 });
  if (model && !ALLOWED_MODELS.has(model)) throw Object.assign(new Error('Modello AI non supportato.'), { status: 400 });
  if (width < 8 || height < 8 || width > 1400 || height > 1400) {
    throw Object.assign(new Error('Dimensione selezione non valida.'), { status: 400 });
  }

  return { prompt, imageBase64, maskBase64, width, height, model };
}

function buildGeminiRequest({ prompt, imageBase64, maskBase64 }) {
  const instruction = [
    'You are editing an image crop from a drawing app.',
    'The first image is the crop to edit.',
    'The second image is a mask: white pixels are the selected area to change, black pixels are locked context.',
    'Generate the requested addition only inside the white selected area.',
    'Preserve the surrounding style, colors, lighting, perspective, edges, and texture.',
    'Return only the edited image crop with the same framing. Do not add text unless the user explicitly asks for text.',
    '',
    `User request: ${prompt}`,
  ].join('\n');

  return {
    contents: [{
      role: 'user',
      parts: [
        { text: instruction },
        { inline_data: { mime_type: 'image/png', data: imageBase64 } },
        { inline_data: { mime_type: 'image/png', data: maskBase64 } },
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };
}

function firstImagePart(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        return {
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
        };
      }
    }
  }
  return null;
}

function textParts(data) {
  const out = [];
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) if (part.text) out.push(part.text);
  }
  return out.join('\n').trim();
}

const ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
const IMAGE_SIZES = new Set(['1K', '2K', '4K']);
const SIZE_MODELS = new Set(['gemini-3-pro-image']); // solo il Pro supporta imageSize
const REF_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_REFS = 14;

function validateGeneratePayload(input) {
  const prompt = String(input.prompt || '').trim();
  const model = String(input.model || '').trim();
  const aspectRatio = String(input.aspectRatio || '1:1').trim();
  const imageSize = String(input.imageSize || '').trim();
  const enhance = !!input.enhance;

  if (prompt.length < 2) throw Object.assign(new Error('Scrivi cosa vuoi generare.'), { status: 400 });
  if (prompt.length > 1200) throw Object.assign(new Error('Prompt troppo lungo.'), { status: 400 });
  if (model && !ALLOWED_MODELS.has(model)) throw Object.assign(new Error('Modello AI non supportato.'), { status: 400 });
  if (!ASPECT_RATIOS.has(aspectRatio)) throw Object.assign(new Error('Formato non supportato.'), { status: 400 });
  if (imageSize && !IMAGE_SIZES.has(imageSize)) throw Object.assign(new Error('Qualità non supportata.'), { status: 400 });

  const refs = [];
  if (Array.isArray(input.refs)) {
    for (const r of input.refs.slice(0, MAX_REFS)) {
      const data = cleanBase64(typeof r === 'string' ? r : r?.data);
      if (!data || data.length > 6_000_000) continue;
      const mime = REF_MIMES.has(r?.mimeType) ? r.mimeType : 'image/jpeg';
      refs.push({ data, mimeType: mime });
    }
  }

  return { prompt, model, aspectRatio, imageSize, enhance, refs };
}

function buildGenerateRequest(payload, model) {
  const lines = [
    'Generate exactly one high-quality image that matches the user prompt below as faithfully as possible.',
    'Follow the requested subject, colors, style and composition literally. The prompt may be written in any language.',
    'Do not add text or watermarks unless the prompt explicitly asks for them.',
  ];
  if (payload.refs.length) {
    lines.push('Use the attached reference images: keep their subject, product and identity faithful, and combine them as the prompt describes.');
  }
  lines.push('', `User prompt: ${payload.prompt}`);

  const imageConfig = { aspectRatio: payload.aspectRatio };
  if (payload.imageSize && SIZE_MODELS.has(model)) imageConfig.imageSize = payload.imageSize;

  return {
    contents: [{
      role: 'user',
      parts: [
        { text: lines.join('\n') },
        ...payload.refs.map((r) => ({ inline_data: { mime_type: r.mimeType, data: r.data } })),
      ],
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig,
    },
  };
}

// Riscrive il prompt in inglese dettagliato con un modello testo economico.
// Qualunque fallimento restituisce il prompt originale: mai bloccare la generazione.
async function enhancePrompt(prompt) {
  const apiKey = getApiKey();
  if (!apiKey) return prompt;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: 'Rewrite the following image-generation prompt as one detailed English prompt of at most 80 words. ' +
              'Keep the subject, colors, style and intent exactly faithful. Output only the rewritten prompt, no quotes.\n\n' +
              `Prompt: ${prompt}`,
          }],
        }],
      }),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) return prompt;
    const text = textParts(data);
    return text ? text.slice(0, 1200) : prompt;
  } catch {
    return prompt;
  }
}

async function runGeminiImageCall(res, model, requestBody, extra = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    json(res, 500, { error: 'GEMINI_API_KEY non configurata sul server.' });
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const data = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    const message = data?.error?.message || `Gemini request failed (${upstream.status}).`;
    json(res, upstream.status, { error: message, model });
    return;
  }

  const image = firstImagePart(data);
  if (!image) {
    json(res, 502, { error: textParts(data) || 'Gemini non ha restituito una immagine.', model });
    return;
  }

  json(res, 200, {
    imageBase64: image.data,
    mimeType: image.mimeType,
    model,
    note: textParts(data),
    ...extra,
  });
}

export async function handleGeminiFillRequest(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  try {
    const payload = validatePayload(await readJson(req));
    const model = payload.model || getModel();
    await runGeminiImageCall(res, model, buildGeminiRequest(payload));
    return true;
  } catch (err) {
    const status = Number(err?.status) || 500;
    json(res, status, { error: err instanceof Error ? err.message : 'AI generation failed.' });
    return true;
  }
}

// Generazione pura testo→immagine (nodi Image degli Spaces).
export async function handleGeminiGenerateRequest(req, res) {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  try {
    const payload = validateGeneratePayload(await readJson(req));
    const model = payload.model || getModel();
    const original = payload.prompt;
    if (payload.enhance) payload.prompt = await enhancePrompt(payload.prompt);
    const extra = payload.prompt !== original ? { enhancedPrompt: payload.prompt } : {};
    await runGeminiImageCall(res, model, buildGenerateRequest(payload, model), extra);
    return true;
  } catch (err) {
    const status = Number(err?.status) || 500;
    json(res, status, { error: err instanceof Error ? err.message : 'AI generation failed.' });
    return true;
  }
}
