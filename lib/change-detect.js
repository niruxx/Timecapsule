const { diffLines } = require('diff');

// Compares this capture's article text against the most recent previous capture of the same
// URL, producing a lightweight change summary. Scoped to text (not a pixel/visual diff, which
// is a separate, still-unbuilt roadmap item - the "side-by-side visual diff viewer").
function summarizeChange(previousText, currentText) {
  if (previousText == null) return null; // no earlier snapshot to compare against
  if (previousText.trim() === currentText.trim()) return { changed: false, added: 0, removed: 0 };

  const parts = diffLines(previousText, currentText);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lineCount = part.value.split('\n').filter(Boolean).length;
    if (part.added) added += lineCount;
    else if (part.removed) removed += lineCount;
  }
  return { changed: true, added, removed };
}

module.exports = { summarizeChange };
