import robotsParser from 'robots-parser';

const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot'
];

export function parseRobots(url, content) {
  try {
    return robotsParser(url, content || '');
  } catch {
    return null;
  }
}

export function extractSitemapUrls(content) {
  if (!content) return [];
  return String(content)
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*Sitemap\s*:\s*(.+)\s*$/i)?.[1]?.trim())
    .filter(Boolean);
}

export function robotsMentions(content, botName) {
  return new RegExp(`(^|\\n)\\s*user-agent\\s*:\\s*${escapeRegex(botName)}\\s*(\\n|$)`, 'i').test(content || '');
}

export function summarizeAiBotRules(robotsUrl, content) {
  const parser = parseRobots(robotsUrl, content || '');
  return AI_BOTS.map((bot) => {
    const mentioned = robotsMentions(content, bot);
    let status = 'unknown';
    if (parser) {
      const allowedRoot = parser.isAllowed(new URL(robotsUrl).origin + '/', bot);
      status = allowedRoot === false ? 'blocked' : 'allowed';
    }
    return { bot, mentioned, status };
  });
}

export function blocksTxtFiles(content) {
  if (!content) return false;
  return /disallow\s*:\s*.*\*?\.txt/i.test(content) || /disallow\s*:\s*\/.*\.txt/i.test(content);
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
