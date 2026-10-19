import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import { formatResponse } from '../src/response.js';
import { responseFixtures } from '../test/fixtures/responses.js';

// Ranks are bundled in the pinned devDependency; no network or model/API calls.
const tokenizer = new Tiktoken(o200k);
function measure(value: unknown) {
  const json = JSON.stringify(value);
  return { bytes: Buffer.byteLength(json), tokens: tokenizer.encode(json, [], []).length };
}
const reduction = (full: number, compact: number): number => Number(((full - compact) / full * 100).toFixed(2));
const scenarios = responseFixtures.map(({ name, action, response, jid }) => {
  const full = measure(formatResponse(action, response, 'full', jid));
  const compact = measure(formatResponse(action, response, 'compact', jid));
  return { scenario: name, full, compact, reductionPercent: {
    bytes: reduction(full.bytes, compact.bytes), tokens: reduction(full.tokens, compact.tokens),
  } };
});
process.stdout.write(JSON.stringify({ tokenizer: { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base' },
  serialization: 'JSON.stringify; minified; excludes final newline', truncation: 'none',
  limits: 'Fictional fixtures; payload tokens only, not model-specific billing or chat/tool framing. No claim of exact GPT-6.1 token counts.',
  scenarios }, null, 2) + '\n');
