import crypto from 'node:crypto';
import { insertLlmResult, logRun } from '../db/repositories.js';
import { makeResult, safeJson } from '../checks/helpers.js';
import { getPrompt, listPrompts } from './promptRegistry.js';

const PROVIDER_KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY'
};

export async function runLlmChecks(context) {
  const { db, run } = context;
  if (!run.enableLlmChecks) return [];
  const provider = normalizeProvider(run.llmProvider);
  const warnings = llmConfigurationWarnings(run, provider);
  if (warnings.length) {
    logRun(db, run.id, 'warning', 'LLM checks configuration warning', { warnings });
  }

  if (provider === 'none' || (warnings.some((warning) => /API_KEY/.test(warning)) && !run.llmDryRun)) {
    return [llmUnavailableResult(run, warnings)];
  }

  const prompts = listPrompts().slice(0, Math.max(1, Number(run.llmMaxChecks || 2)));
  const pages = samplePages(db, run.id, Math.max(1, Number(run.llmMaxSampleUrls || 5)));
  if (!pages.length) {
    return [llmUnavailableResult(run, ['No URL facts available for LLM sampling.'])];
  }

  const results = [];
  for (const prompt of prompts) {
    const promptResults = [];
    for (const page of pages) {
      const input = promptInput(prompt.id, page);
      const inputText = JSON.stringify(input).slice(0, prompt.maxInputLength);
      const inputHash = crypto.createHash('sha256').update(inputText).digest('hex');
      let llmResult;
      try {
        llmResult = await evaluateWithProvider({ run, provider, prompt, input, inputText, inputHash });
      } catch (error) {
        llmResult = {
          verdict: 'error',
          score: null,
          rationale: error.message,
          evidenceExcerpt: '',
          error: error.message
        };
      }
      insertLlmResult(db, {
        runId: run.id,
        checkId: prompt.id,
        sampledUrl: page.url,
        promptId: prompt.id,
        promptVersion: prompt.version,
        provider,
        model: run.llmModel || defaultModel(provider),
        inputHash,
        dryRun: Boolean(run.llmDryRun || provider === 'mock'),
        ...llmResult
      });
      promptResults.push({ url: page.url, ...llmResult });
    }
    results.push(resultForPrompt(prompt, run, promptResults, warnings));
  }
  return results;
}

export function llmConfigurationWarnings(run, provider = normalizeProvider(run.llmProvider)) {
  const warnings = [];
  if (!run.enableLlmChecks) return warnings;
  if (provider === 'none') warnings.push('LLM provider is none.');
  const envKey = PROVIDER_KEY_ENV[provider];
  if (envKey && !process.env[envKey]) warnings.push(`${envKey} is not configured.`);
  if (!run.llmDryRun && provider !== 'mock') warnings.push('Page facts/content excerpts may be sent to an external LLM provider.');
  if (Number(run.llmMaxSampleUrls || 0) > 25) warnings.push('LLM max sample URLs is high; sample-only evaluation is recommended.');
  return warnings;
}

async function evaluateWithProvider({ run, provider, prompt, input, inputText, inputHash }) {
  if (run.llmDryRun || provider === 'mock') {
    return mockVerdict({ prompt, input, inputHash, dryRun: Boolean(run.llmDryRun) });
  }
  if (provider === 'openai') return callOpenAi({ run, prompt, inputText });
  if (provider === 'anthropic') return callAnthropic({ run, prompt, inputText });
  return {
    verdict: 'not evaluated',
    score: null,
    rationale: 'LLM provider disabled.',
    evidenceExcerpt: '',
    error: 'provider_disabled'
  };
}

async function callOpenAi({ run, prompt, inputText }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: run.llmModel || defaultModel('openai'),
      temperature: prompt.temperature,
      max_tokens: Math.min(1200, Number(run.llmMaxTokens || 8000)),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return strict JSON with verdict, score, rationale and evidenceExcerpt. Do not include secrets or full copied content.' },
        { role: 'user', content: inputText }
      ]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed with ${response.status}`);
  return parseLlmJson(payload.choices?.[0]?.message?.content);
}

async function callAnthropic({ run, prompt, inputText }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: run.llmModel || defaultModel('anthropic'),
      temperature: prompt.temperature,
      max_tokens: Math.min(1200, Number(run.llmMaxTokens || 8000)),
      system: 'Return strict JSON with verdict, score, rationale and evidenceExcerpt. Do not include secrets or full copied content.',
      messages: [{ role: 'user', content: inputText }]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Anthropic request failed with ${response.status}`);
  return parseLlmJson(payload.content?.[0]?.text);
}

function resultForPrompt(prompt, run, promptResults, warnings) {
  const errors = promptResults.filter((item) => item.error);
  const scored = promptResults.map((item) => Number(item.score)).filter((score) => Number.isFinite(score));
  const low = scored.filter((score) => score < 6);
  const status = errors.length === promptResults.length ? 'NA' : low.length ? 'Warning' : 'OK';
  return makeResult({
    id: prompt.id,
    category: 'LLM Assisted Review',
    name: prompt.title,
    auditType: 'geo',
    priority: 'Low',
    effort: 'M'
  }, status, {
    affectedCount: low.length,
    sampleUrls: promptResults.map((item) => item.url),
    finding: status === 'Warning'
      ? `${low.length}/${promptResults.length} sampled URL(s) need human review for ${prompt.title}.`
      : status === 'NA'
        ? `${prompt.title} was not evaluated.`
        : `${prompt.title} did not flag the sampled URL facts.`,
    recommendation: 'Treat LLM output as qualitative review support only; confirm before turning it into a hard technical action.',
    details: 'LLM-assisted sample evaluation. It does not replace deterministic technical checks.',
    evidence: {
      llm_assisted: true,
      provider: normalizeProvider(run.llmProvider),
      model: run.llmModel || defaultModel(normalizeProvider(run.llmProvider)),
      promptId: prompt.id,
      promptVersion: prompt.version,
      dryRun: Boolean(run.llmDryRun),
      warnings,
      samples: promptResults.map((item) => ({
        url: item.url,
        verdict: item.verdict,
        score: item.score,
        rationale: item.rationale,
        error: item.error || null
      }))
    },
    findingType: 'llm_assisted',
    confidence: status === 'OK' ? 'medium' : 'medium',
    reviewRecommended: true,
    reportGroupingKey: 'llm.assisted'
  });
}

function samplePages(db, runId, limit) {
  return db.prepare(`
    SELECT url, title, metaDescription, h1Json, pageType, schemaTypesJson,
      wordCountRaw, hasAuthorPattern, hasVisibleDate, externalSourceLinksCount
    FROM pages
    WHERE runId = ?
    ORDER BY
      CASE WHEN COALESCE(indexable, 1) = 1 THEN 0 ELSE 1 END,
      CASE COALESCE(pageType, 'other')
        WHEN 'homepage' THEN 0
        WHEN 'article' THEN 1
        WHEN 'product' THEN 2
        ELSE 3
      END,
      id ASC
    LIMIT ?
  `).all(runId, limit).map((row) => ({
    ...row,
    h1: safeJson(row.h1Json, []),
    schemaTypes: safeJson(row.schemaTypesJson, [])
  }));
}

function promptInput(promptId, page) {
  const prompt = getPrompt(promptId);
  return {
    promptId: prompt?.id,
    promptVersion: prompt?.version,
    safety: prompt?.safety,
    page: {
      url: page.url,
      title: page.title || null,
      metaDescription: page.metaDescription || null,
      h1: page.h1 || [],
      pageType: page.pageType || null,
      schemaTypes: page.schemaTypes || [],
      wordCount: page.wordCountRaw ?? null,
      hasAuthorPattern: Boolean(page.hasAuthorPattern),
      hasVisibleDate: Boolean(page.hasVisibleDate),
      externalSourceLinksCount: Number(page.externalSourceLinksCount || 0)
    }
  };
}

function mockVerdict({ prompt, input, dryRun }) {
  const page = input.page || {};
  const score = page.title && (page.h1 || []).length ? 7 : 4;
  return {
    verdict: dryRun ? 'dry_run_not_sent' : score >= 6 ? 'acceptable sample' : 'needs review',
    score,
    rationale: dryRun
      ? 'Dry run only: prompt input was built and hashed but no external request was sent.'
      : 'Mock provider result for deterministic local tests.',
    evidenceExcerpt: `${prompt.title}: ${page.title || page.url || ''}`.slice(0, 500),
    costEstimate: { estimatedTokens: Math.ceil(JSON.stringify(input).length / 4), currency: 'USD', amount: 0 }
  };
}

function parseLlmJson(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return {
      verdict: String(parsed.verdict || '').slice(0, 500),
      score: parsed.score === null || parsed.score === undefined ? null : Number(parsed.score),
      rationale: String(parsed.rationale || '').slice(0, 4000),
      evidenceExcerpt: String(parsed.evidenceExcerpt || '').slice(0, 1000)
    };
  } catch (error) {
    return {
      verdict: 'invalid_json',
      score: null,
      rationale: 'LLM response was not valid JSON.',
      evidenceExcerpt: '',
      error: error.message
    };
  }
}

function llmUnavailableResult(run, warnings) {
  return makeResult({
    id: 'llm.configuration',
    category: 'LLM Assisted Review',
    name: 'LLM configuration',
    auditType: 'geo',
    priority: 'Low',
    effort: 'S'
  }, 'NA', {
    affectedCount: 0,
    finding: 'LLM checks were requested but not executed.',
    recommendation: 'Set provider, API key and dry-run/cost guard settings before enabling external LLM checks.',
    evidence: {
      llm_assisted: true,
      provider: normalizeProvider(run.llmProvider),
      dryRun: Boolean(run.llmDryRun),
      warnings
    },
    findingType: 'llm_assisted',
    confidence: 'medium',
    reviewRecommended: true
  });
}

function normalizeProvider(value) {
  return ['none', 'openai', 'anthropic', 'mock'].includes(value) ? value : 'none';
}

function defaultModel(provider) {
  if (provider === 'openai') return 'gpt-4.1-mini';
  if (provider === 'anthropic') return 'claude-3-5-haiku-latest';
  if (provider === 'mock') return 'mock-local';
  return null;
}
