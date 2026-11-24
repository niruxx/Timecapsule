const fs = require('fs');
const path = require('path');
const { brotliDecompressSync, gunzipSync, inflateSync } = require('zlib');
const { WARCParser } = require('warcio');
const { canonicalizeUrl } = require('./canonicalize');
const { htmlToText } = require('./text-extract');
const decoders = new Map([['gzip', gunzipSync], ['deflate', inflateSync], ['br', brotliDecompressSync]]);

const formats = {
  screenshot: 'screenshot.png', html: 'page.html', pdf: 'page.pdf',
  reader: 'article.txt', warc: 'page.warc.gz', thumbnail: 'thumbnail.jpg',
};

async function snapshotDirectory(root, dir) {
  if (typeof dir !== 'string' || !dir || dir.split('/').some((segment) =>
    !segment || segment === '.' || segment === '..' || /[\\:\0]/.test(segment))) return null;
  const absolute = path.join(root, dir);
  const resolvedRoot = await fs.promises.realpath(root).catch(() => null);
  const resolved = await fs.promises.realpath(absolute).catch(() => null);
  if (!resolvedRoot || resolved !== path.join(resolvedRoot, dir)) return null;
  const meta = await fs.promises.readFile(path.join(absolute, 'metadata.json'), 'utf8').then(JSON.parse).catch(() => null);
  return meta && typeof meta.url === 'string' ? { absolute, meta } : null;
}

function sameUrl(a, b) {
  try { return canonicalizeUrl(a) === canonicalizeUrl(b); } catch { return a === b; }
}

async function snapshotFormats({ absolute }) {
  const files = await Promise.all(Object.entries(formats).map(async ([name, filename]) => {
    const info = await fs.promises.lstat(path.join(absolute, filename)).catch(() => null);
    return [name, info?.isFile() && info.size > 0 ? filename : null];
  }));
  return Object.fromEntries(files);
}

async function readSnapshotText(absolute, name = 'article.txt') {
  const file = path.join(absolute, name);
  const info = await fs.promises.lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const data = await fs.promises.readFile(file, 'utf8').catch(() => null);
  if (!data) return null;
  return (name.endsWith('.html') ? htmlToText(data) : data).slice(0, 250_000);
}

async function replayBody(record, encoding) {
  const body = Buffer.from(await record.readFully());
  const decode = decoders.get(encoding?.trim().toLowerCase());
  if (!decode || !body.length) return body;
  try { return decode(body, { maxOutputLength: 4 * 1024 * 1024 }); }
  catch { return body; } // Chromium may have already decompressed a captured payload.
}

async function comparisonText(left, right) {
  const articles = await Promise.all([readSnapshotText(left), readSnapshotText(right)]);
  if (articles.every(Boolean)) return articles;
  return Promise.all([readSnapshotText(left, 'page.html'), readSnapshotText(right, 'page.html')]);
}

async function readWarc(snapshot) {
  const filename = path.join(snapshot.absolute, formats.warc);
  const source = fs.createReadStream(filename);
  const resources = Object.create(null);
  let document;
  let fallback;
  let size = 0;
  let records = 0;
  const maxBytes = 16 * 1024 * 1024;
  try {
    for await (const record of new WARCParser(source)) {
      if (++records > 4000) break;
      if (record.warcType !== 'response' || record.warcContentLength > 4 * 1024 * 1024) continue;
      const url = record.warcTargetURI;
      const response = record.getResponseInfo();
      if (!url || !response || Number(response.status) < 200 || Number(response.status) >= 300) continue;
      const contentType = response.headers.get('content-type') || '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      if (mime === 'text/html' || mime === 'application/xhtml+xml') {
        const body = await replayBody(record, response.headers.get('content-encoding'));
        if (!body.length) continue;
        let decoder;
        try { decoder = new TextDecoder(contentType.match(/charset=([\w-]+)/i)?.[1] || 'utf-8'); }
        catch { decoder = new TextDecoder(); }
        const page = { html: decoder.decode(body), url };
        if (sameUrl(url, snapshot.meta.url)) document ||= page;
        else fallback ||= page;
      } else if (/^(text\/css|image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/[\w-]+)$/.test(mime) && size < maxBytes) {
        const body = await replayBody(record, response.headers.get('content-encoding'));
        if (!body.length || size + body.length > maxBytes) continue;
        size += body.length;
        resources[url] = 'data:' + mime + ';base64,' + body.toString('base64');
      }
    }
  } finally {
    source.destroy();
  }
  const page = document || fallback;
  return page ? { ...page, resources } : null;
}

module.exports = { snapshotDirectory, snapshotFormats, formats, sameUrl, readWarc, comparisonText };
