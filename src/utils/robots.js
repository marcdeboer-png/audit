import robotsParser from 'robots-parser';
import { extractValidSitemapUrls } from './discoverySemantics.js';

const AI_BOTS = [
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
];

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
  return new RegExp(`(^|\\n)\\s*user-agent\\s*:\\s*${escapeRegex(botName)}\\s*(\\n|$)`, 'i').test(content || '');
}

export function summarizeAiBotRules(robotsUrl, content) {
  const parser = parseRobots(robotsUrl, content || '');
  const wildcardRootAllowed = parser ? parser.isAllowed(new URL(robotsUrl).origin + '/', '*') : undefined;
  return AI_BOTS.map((bot) => {
    const mentioned = robotsMentions(content, bot);
    let status = 'unknown';
    if (parser) {
      const allowedRoot = parser.isAllowed(new URL(robotsUrl).origin + '/', bot);
      status = allowedRoot === false ? 'blocked' : 'allowed';
    }
    const inheritedWildcard = !mentioned && parser && status !== 'unknown' && wildcardRootAllowed === (status === 'allowed');
    const policyStatus = mentioned
      ? (status === 'blocked' ? 'blocked_explicitly' : 'allowed_explicitly')
      : inheritedWildcard
        ? `inherited_wildcard_${status}`
        : 'not_mentioned';
    return { bot, mentioned, status, policyStatus, inheritedWildcard };
  });
}

export function blocksTxtFiles(content) {
  if (!content) return false;
  const origin = 'https://audit.invalid';
  const parser = parseRobots(`${origin}/robots.txt`, content);
  if (!parser) return false;
  return ['/llms.txt', '/llms-full.txt'].some((path) => parser.isAllowed(`${origin}${path}`, '*') === false);
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
