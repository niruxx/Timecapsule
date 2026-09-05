const { z } = require('zod');

// Genuinely optional: only active when ANTHROPIC_API_KEY is set. Unlike the other bonus
// captures in this project, this one adds real per-archive latency (an API round trip), so it
// stays opt-in rather than on-by-default - setting the env var is the opt-in.
let Anthropic;
let zodOutputFormat;
try {
  Anthropic = require('@anthropic-ai/sdk');
  ({ zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod'));
} catch {
  Anthropic = null;
}

const MODEL = 'claude-opus-5';
const MAX_CONTENT_CHARS = 12000; // a summary doesn't need the whole page - keeps requests small and cheap

const EnrichmentSchema = z.object({
  summary: z.string().describe('A 2-3 sentence summary of the page content.'),
  tags: z.array(z.string()).describe('3 to 8 short, lowercase topical tags/keywords.'),
  entities: z.array(z.string()).describe('Notable named people, organizations, or places mentioned - empty array if none.'),
});

let client;
function getClient() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

// Best-effort: summarizes and tags the page's extracted text. Returns null (never throws) when
// the feature isn't configured, there's no real content, or the API call fails for any reason -
// a rate limit or network hiccup here should never break an otherwise-successful archive.
async function enrichContent(text, title) {
  const anthropic = getClient();
  if (!anthropic || !text || !text.trim()) return null;

  try {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: 'You summarize and tag archived web pages for a personal search index. Be concise and factual - only describe what the page actually says.',
      messages: [{
        role: 'user',
        content: `Title: ${title || '(untitled)'}\n\nContent:\n${text.slice(0, MAX_CONTENT_CHARS)}`,
      }],
      output_config: { format: zodOutputFormat(EnrichmentSchema) },
    });
    return response.parsed_output;
  } catch {
    return null;
  }
}

module.exports = { enrichContent };
