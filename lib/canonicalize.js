// Strips common tracking params and normalizes a URL, so the same article reached through
// different tracking links (an ad campaign vs. a social share vs. a newsletter, say) is
// recognized as the same page rather than archived as an unrelated-looking duplicate every time.
const TRACKING_PARAM_PATTERNS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^gclsrc$/i, /^dclid$/i, /^msclkid$/i,
  /^mc_(cid|eid)$/i, /^ref$/i, /^ref_src$/i, /^ref_url$/i, /^igshid$/i,
  /^si$/i, /^spm$/i, /^_hs(enc|mi)$/i, /^vero_(id|conv)$/i, /^yclid$/i, /^icid$/i,
];

function canonicalizeUrl(rawUrl) {
  const u = new URL(rawUrl);

  const params = new URLSearchParams(u.search);
  for (const key of Array.from(params.keys())) {
    if (TRACKING_PARAM_PATTERNS.some((re) => re.test(key))) params.delete(key);
  }
  params.sort();
  u.search = params.toString();

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

module.exports = { canonicalizeUrl };
