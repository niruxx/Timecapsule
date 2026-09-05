// Accepts either a Netscape/Mozilla "cookies.txt" export (the format yt-dlp, curl, and most
// browser cookie-export extensions produce) or a JSON array of Puppeteer/CDP-style cookie
// objects, and normalizes both into the shape Puppeteer's page.setCookie() expects.
function parseCookies(raw) {
  const text = raw.trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    return parseJsonCookies(text);
  }
  return parseNetscapeCookies(text);
}

function parseJsonCookies(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Cookies file is not valid JSON: ${err.message}`);
  }

  const list = Array.isArray(data) ? data : [data];
  return list.map((c, i) => {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') {
      throw new Error(`Cookie at index ${i} is missing a name/value.`);
    }
    const cookie = { name: c.name, value: c.value };
    if (c.domain) cookie.domain = c.domain;
    if (c.path) cookie.path = c.path;
    if (typeof c.expires === 'number') cookie.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') cookie.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') cookie.secure = c.secure;
    if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) cookie.sameSite = c.sameSite;
    return cookie;
  });
}

// Each non-comment, non-blank line is 7 tab-separated fields:
// domain, includeSubdomains, path, secure, expiry, name, value
function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const fields = line.split('\t');
    if (fields.length < 7) continue;

    const [domain, , path, secure, expiry, name, ...valueParts] = fields;
    cookies.push({
      domain,
      path: path || '/',
      secure: secure === 'TRUE',
      expires: Number(expiry) || undefined,
      name,
      value: valueParts.join('\t'),
    });
  }

  if (!cookies.length) {
    throw new Error('No cookies found - expected a Netscape cookies.txt export or a JSON array of cookie objects.');
  }
  return cookies;
}

module.exports = { parseCookies };
