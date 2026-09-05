// Cheap HTML -> plain-text extraction for search indexing, deliberately not a full HTML parser.
// page.html is Puppeteer-rendered markup we produced ourselves (not arbitrary hostile input),
// so a regex strip is a reasonable trade-off against pulling in a parser dependency just for this.
// Inlined images/fonts live inside attribute values (src="data:..."), so stripping tags removes
// that bulk along with them - the result stays dominated by actual visible text.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

module.exports = { htmlToText };
