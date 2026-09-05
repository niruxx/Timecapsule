const { WARCRecord, WARCSerializer } = require('warcio');

// Builds a gzipped WARC/1.1 file (warcinfo + a request/response record pair per HTTP
// transaction Puppeteer observed while loading the page). This is a genuine, spec-valid WARC -
// parseable by warcio/pywb/ReplayWeb.page - but a simpler capture than a dedicated crawler like
// Browsertrix: it only records transactions Chromium's network layer surfaced to us, capped at
// MAX_TRANSACTION_BYTES each (the same ceiling the HTML-inlining pipeline uses), so very large
// resources (videos, big downloads) are represented by their headers but not full replayable
// bodies. That's a real limitation worth knowing, not a hidden one.
async function buildWarc(targetUrl, transactions, capturedAt) {
  const parts = [];

  const infoRecord = WARCRecord.createWARCInfo(
    { filename: 'page.warc.gz', warcVersion: 'WARC/1.1' },
    {
      software: 'TimeCapsule',
      format: 'WARC File Format 1.1',
      description: `Captured by TimeCapsule from ${targetUrl}`,
    }
  );
  parts.push(await WARCSerializer.serialize(infoRecord, { gzip: true }));

  for (const tx of transactions) {
    const responseRecord = WARCRecord.create(
      {
        url: tx.url,
        date: capturedAt,
        type: 'response',
        warcVersion: 'WARC/1.1',
        statusline: `HTTP/1.1 ${tx.status} ${tx.statusText || ''}`.trim(),
        httpHeaders: tx.responseHeaders,
      },
      [tx.body]
    );
    parts.push(await WARCSerializer.serialize(responseRecord, { gzip: true }));

    let requestTarget = tx.url;
    try {
      const u = new URL(tx.url);
      requestTarget = `${u.pathname}${u.search}` || '/';
    } catch {
      // keep the full url as a fallback
    }

    const requestRecord = WARCRecord.create(
      {
        url: tx.url,
        date: capturedAt,
        type: 'request',
        warcVersion: 'WARC/1.1',
        statusline: `${tx.method} ${requestTarget} HTTP/1.1`,
        httpHeaders: tx.requestHeaders,
        warcHeaders: { 'WARC-Concurrent-To': responseRecord.warcHeader('WARC-Record-ID') },
      },
      []
    );
    parts.push(await WARCSerializer.serialize(requestRecord, { gzip: true }));
  }

  return Buffer.concat(parts);
}

module.exports = { buildWarc };
