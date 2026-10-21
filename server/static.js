import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

// Each app instance serves one release. Cache promises too, so simultaneous
// requests share disk reads and compression instead of repeating the work.
export function staticFiles(directory) {
  const files = new Map();
  let manifest;
  function load(file) {
    if (!files.has(file)) {
      const pending = readFile(resolve(directory, `.${file}`)).catch((error) => {
        files.delete(file);
        throw error;
      });
      files.set(file, pending);
    }
    return files.get(file);
  }
  async function versionHtml(content) {
    manifest ??= readFile(resolve(directory, '../build-manifest.json'), 'utf8').then(JSON.parse).catch((error) => {
      manifest = undefined;
      throw error;
    });
    const { files: hashes } = await manifest;
    return content.toString().replace(/\b(src|href)="(\/[^"]*)"/g, (match, attribute, reference) => {
      const url = new URL(reference, 'http://assets.local');
      const hash = hashes[url.pathname];
      if (url.origin !== 'http://assets.local' || !hash || url.pathname.endsWith('.html')) {
        return match;
      }
      url.searchParams.set('v', hash);
      return `${attribute}="${url.pathname}${url.search}${url.hash}"`;
    });
  }
  return { load, versionHtml };
}

export async function representation(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = createHash('sha256').update(body).digest('hex');
  const variants = { identity: body };
  if (body.length >= 1024) {
    const [compressed, zipped] = await Promise.all([
      brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
      gz(body)
    ]);
    if (compressed.length < body.length) {
      variants.br = compressed;
    }
    if (zipped.length < body.length) {
      variants.gzip = zipped;
    }
  }
  return { variants, digest };
}

function encoding(header = '', variants) {
  const weights = new Map(header.toLowerCase().split(',').map((entry) => {
    const [name, ...parameters] = entry.trim().split(';');
    const value = parameters.find((part) => /^\s*q=/i.test(part))?.split('=')[1];
    const weight = value === undefined ? 1 : Number(value);
    return [name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0];
  }));
  return Object.keys(variants).map((name) => ({
    name, weight: weights.get(name) ?? (name === 'identity' ? (weights.get('*') === 0 ? 0 : 1) : weights.get('*') ?? 0)
  })).filter(({ weight }) => weight > 0).sort((a, b) => b.weight - a.weight
    || ['br', 'gzip', 'identity'].indexOf(a.name) - ['br', 'gzip', 'identity'].indexOf(b.name))[0]?.name;
}

export function sendRepresentation(req, res, value, { cache = false, version } = {}) {
  const vary = [res.getHeader('Vary'), 'Accept-Encoding'].filter(Boolean).join(', ');
  res.setHeader('Vary', vary);
  const selected = encoding(req.headers['accept-encoding'], value.variants);
  if (!selected) {
    res.writeHead(406).end();
    return;
  }
  const body = value.variants[selected];
  if (selected !== 'identity') {
    res.setHeader('Content-Encoding', selected);
  }
  if (cache) {
    // Unversioned module imports must revalidate after a deployment. Only an
    // exact content hash earns immutable caching; arbitrary ?v= values do not.
    res.setHeader('Cache-Control', version === value.digest ? 'public, max-age=31536000, immutable' : 'public, no-cache');
    const etag = `"${value.digest}-${selected}"`;
    res.setHeader('ETag', etag);
    const matches = req.headers['if-none-match']?.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
    if (matches) {
      res.writeHead(304).end();
      return;
    }
  }
  res.setHeader('Content-Length', body.length);
  res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
}
