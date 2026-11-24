const { diffLines } = require('diff');

// Summarize the line changes between two versions of a captured page.
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
