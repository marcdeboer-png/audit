import robotsParser from 'robots-parser';
import { extractValidSitemapUrls } from './discoverySemantics.js';

export const AI_ROBOTS_POLICY_VERSION = 'ai-robots-policy-v2';

export const SUPPORTED_AI_BOTS = Object.freeze([
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
  'Applebot',
  'Bytespider'
]);

export function parseRobots(url, content) {
  try {
    return robotsParser(url, content || '');
  } catch {
    return null;
  }
}

export function extractSitemapUrls(content, robotsUrl = null) {
  return extractValidSitemapUrls(content, robotsUrl);
}

export function robotsMentions(content, botName) {
  const parsed = parseRobotsPolicy(content);
  const normalized = normalizeUserAgent(botName);
  return parsed.groups.some((group) => group.userAgents.some((agent) => normalizeUserAgent(agent.value) === normalized));
}

export function parseRobotsPolicy(content = '') {
  const groups = [];
  const globalDirectives = [];
  const unknownDirectives = [];
  const errors = [];
  let current = null;

  const finalize = () => {
    if (!current) return;
    if (current.userAgents.length) {
      current.id = `group-${groups.length + 1}`;
      groups.push(current);
    }
    current = null;
  };

  for (const [index, rawLine] of String(content).replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) {
      errors.push({ line: lineNumber, type: 'malformed_directive', fatal: false });
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'user-agent') {
      if (!value) {
        errors.push({ line: lineNumber, type: 'empty_user_agent', fatal: true });
        continue;
      }
      if (!current || current.rules.length || current.otherDirectives.length) {
        finalize();
        current = { id: null, userAgents: [], rules: [], otherDirectives: [] };
      }
      current.userAgents.push({ value, line: lineNumber });
      continue;
    }
    if (name === 'allow' || name === 'disallow') {
      if (!current?.userAgents.length) {
        errors.push({ line: lineNumber, type: 'rule_without_user_agent', fatal: true, directive: name });
        continue;
      }
      current.rules.push({
        type: name,
        pattern: value,
        line: lineNumber,
        operative: Boolean(value),
        specificity: ruleSpecificity(value)
      });
      continue;
    }
    const directive = { name, value, line: lineNumber };
    if (name === 'sitemap' || name === 'host' || name === 'crawl-delay') {
      globalDirectives.push(directive);
    } else {
      unknownDirectives.push(directive);
    }
    if (current) current.otherDirectives.push(directive);
  }
  finalize();

  const fatalErrors = errors.filter((error) => error.fatal);
  return {
    version: AI_ROBOTS_POLICY_VERSION,
    valid: fatalErrors.length === 0,
    groups,
    globalDirectives,
    unknownDirectives,
    errors: [...errors, ...fatalErrors.filter((error) => !errors.includes(error))],
    lineCount: String(content).split(/\r?\n/).length
  };
}

export function evaluateAiBotPolicy({
  robotsUrl,
  content = '',
  botName,
  testedPaths = ['/']
} = {}) {
  const parsed = parseRobotsPolicy(content);
  const explicitGroups = matchingGroups(parsed.groups, botName);
  const wildcardGroups = matchingGroups(parsed.groups, '*');
  const selectedGroups = explicitGroups.length ? explicitGroups : wildcardGroups;
  const policySource = explicitGroups.length ? 'explicit' : wildcardGroups.length ? 'wildcard' : 'default';
  const normalizedPaths = normalizeTestedPaths(testedPaths);
  const pathResults = normalizedPaths.map((path) => evaluatePath({
    robotsUrl,
    path,
    groups: selectedGroups,
    policySource
  }));
  const blockedPathResults = pathResults.filter((result) => result.allowed === false);
  // A named group with no operative blocking rule explicitly publishes full
  // access under robots semantics even without a literal `Allow: /`.
  const explicitAllowComplete = Boolean(explicitGroups.length) &&
    pathResults.length > 0 &&
    pathResults.every((result) => result.allowed === true && result.policySource === 'explicit');
  const mentioned = explicitGroups.length > 0;
  const status = !parsed.valid
    ? 'unclear'
    : blockedPathResults.length
      ? 'blocked'
      : explicitAllowComplete
        ? 'explicitly_allowed'
        : policySource === 'wildcard'
          ? 'implicitly_allowed'
          : mentioned
            ? 'explicit_group_without_complete_allow'
            : 'implicitly_allowed';
  const policyStatus = status === 'blocked'
    ? (mentioned ? 'blocked_explicitly' : 'blocked_by_wildcard')
    : status === 'explicitly_allowed'
      ? 'allowed_explicitly'
      : status === 'explicit_group_without_complete_allow'
        ? 'explicit_group_without_complete_allow'
        : policySource === 'wildcard'
          ? 'inherited_wildcard_allowed'
          : 'not_mentioned_default_allowed';

  return {
    version: AI_ROBOTS_POLICY_VERSION,
    bot: botName,
    mentioned,
    status,
    policyStatus,
    policySource,
    inheritedWildcard: policySource === 'wildcard',
    parserValid: parsed.valid,
    parserErrors: parsed.errors,
    matchingGroups: selectedGroups.map(compactGroup),
    explicitGroups: explicitGroups.map(compactGroup),
    pathResults,
    testedPathCount: pathResults.length,
    blockedPathCount: blockedPathResults.length,
    explicitAllowComplete
  };
}

export function summarizeAiBotRules(robotsUrl, content, options = {}) {
  const testedPaths = options.testedPaths || ['/'];
  return SUPPORTED_AI_BOTS.map((botName) => evaluateAiBotPolicy({
    robotsUrl,
    content,
    botName,
    testedPaths
  }));
}

export function blocksTxtFiles(content, options = {}) {
  const robotsUrl = options.robotsUrl || 'https://audit.invalid/robots.txt';
  const botNames = options.botNames || SUPPORTED_AI_BOTS;
  return botNames.some((botName) => evaluateAiBotPolicy({
    robotsUrl,
    content,
    botName,
    testedPaths: ['/llms.txt']
  }).status === 'blocked');
}

function matchingGroups(groups, botName) {
  const target = normalizeUserAgent(botName);
  return groups.filter((group) => group.userAgents.some((agent) => normalizeUserAgent(agent.value) === target));
}

function normalizeUserAgent(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTestedPaths(paths) {
  const seen = new Set();
  const output = [];
  for (const item of paths || []) {
    const path = typeof item === 'string' ? item : item?.path;
    if (!path) continue;
    let normalized;
    try {
      const parsed = new URL(path, 'https://audit.invalid');
      normalized = `${parsed.pathname || '/'}${parsed.search || ''}`;
    } catch {
      normalized = String(path).startsWith('/') ? String(path) : `/${path}`;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({
      path: normalized,
      role: typeof item === 'object' ? item.role || 'representative_public_path' : 'representative_public_path',
      pageType: typeof item === 'object' ? item.pageType || null : null,
      sourceUrl: typeof item === 'object' ? item.sourceUrl || null : null
    });
  }
  return output;
}

function evaluatePath({ robotsUrl, path, groups, policySource }) {
  const candidates = [];
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!rule.operative || !ruleMatchesPath(rule.pattern, path.path)) continue;
      candidates.push({
        ...rule,
        groupId: group.id,
        userAgents: group.userAgents.map((agent) => agent.value)
      });
    }
  }
  candidates.sort((left, right) =>
    right.specificity - left.specificity ||
    (left.type === right.type ? left.line - right.line : left.type === 'allow' ? -1 : 1)
  );
  const winningRule = candidates[0] || null;
  const allowed = winningRule ? winningRule.type === 'allow' : true;
  return {
    ...path,
    url: safePolicyUrl(robotsUrl, path.path),
    allowed,
    policySource,
    winningRule: winningRule ? compactRule(winningRule) : null,
    matchedRules: candidates.slice(0, 10).map(compactRule)
  };
}

function ruleMatchesPath(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const source = anchored ? pattern.slice(0, -1) : pattern;
  const regex = source
    .split('*')
    .map(escapeRegex)
    .join('.*');
  try {
    return new RegExp(`^${regex}${anchored ? '$' : ''}`).test(path);
  } catch {
    return false;
  }
}

function ruleSpecificity(pattern) {
  return Buffer.byteLength(String(pattern || '').replace(/\*/g, '').replace(/\$$/, ''), 'utf8');
}

function compactGroup(group) {
  return {
    id: group.id,
    userAgents: group.userAgents.map((agent) => ({ value: agent.value, line: agent.line })),
    rules: group.rules.map(compactRule)
  };
}

function compactRule(rule) {
  return {
    type: rule.type,
    pattern: rule.pattern,
    line: rule.line,
    specificity: rule.specificity,
    groupId: rule.groupId || null,
    userAgents: rule.userAgents || []
  };
}

function safePolicyUrl(robotsUrl, path) {
  try {
    return new URL(path, robotsUrl).toString();
  } catch {
    return path;
  }
}

function stripComment(line) {
  const index = String(line).indexOf('#');
  return index >= 0 ? String(line).slice(0, index) : String(line);
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
