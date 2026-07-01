export const LLM_PROMPTS = Object.freeze({
  'llm.geo_answerability_sample': Object.freeze({
    id: 'llm.geo_answerability_sample',
    version: '2026-07-01',
    title: 'GEO answerability sample',
    inputSchema: {
      url: 'string',
      title: 'string|null',
      metaDescription: 'string|null',
      h1: 'string[]',
      pageType: 'string|null',
      schemaTypes: 'string[]',
      wordCount: 'number|null'
    },
    outputSchema: {
      verdict: 'short string',
      score: '0-10 number',
      rationale: 'short string',
      evidenceExcerpt: 'short string'
    },
    safety: {
      sendFullHtml: false,
      sendRawCustomerData: false,
      inputMinimization: 'Only compact URL facts, headings, title/meta and short text signals are sent.'
    },
    maxInputLength: 6000,
    temperature: 0.1
  }),
  'llm.trust_clarity_sample': Object.freeze({
    id: 'llm.trust_clarity_sample',
    version: '2026-07-01',
    title: 'Trust and entity clarity sample',
    inputSchema: {
      url: 'string',
      title: 'string|null',
      h1: 'string[]',
      pageType: 'string|null',
      hasAuthorPattern: 'boolean',
      hasVisibleDate: 'boolean',
      externalSourceLinksCount: 'number'
    },
    outputSchema: {
      verdict: 'short string',
      score: '0-10 number',
      rationale: 'short string',
      evidenceExcerpt: 'short string'
    },
    safety: {
      sendFullHtml: false,
      sendRawCustomerData: false,
      inputMinimization: 'Only compact trust/entity facts are sent.'
    },
    maxInputLength: 5000,
    temperature: 0.1
  })
});

export function getPrompt(promptId) {
  return LLM_PROMPTS[promptId] || null;
}

export function listPrompts() {
  return Object.values(LLM_PROMPTS);
}
