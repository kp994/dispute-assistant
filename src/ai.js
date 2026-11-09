// Picks the AI provider. AI_PROVIDER=gemini|claude; when unset, uses whichever
// key is present, preferring Gemini because it has a free tier.

const providers = { claude: require("./claude"), gemini: require("./gemini") };

function pick() {
  const wanted = (process.env.AI_PROVIDER || "").toLowerCase();
  if (providers[wanted]) return providers[wanted];
  if (providers.gemini.configured()) return providers.gemini;
  if (providers.claude.configured()) return providers.claude;
  return providers.gemini;
}

module.exports = pick();
