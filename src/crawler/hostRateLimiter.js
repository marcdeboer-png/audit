export class HostRateLimiter {
  constructor({ maxConcurrentPerHost = 2, crawlDelayMs = 0, targetPagesPerSecond = 0, onCooldown = null } = {}) {
    this.maxConcurrentPerHost = Math.max(1, Number(maxConcurrentPerHost || 2));
    this.crawlDelayMs = Math.max(0, Number(crawlDelayMs || 0));
    this.targetPagesPerSecond = Math.max(0, Number(targetPagesPerSecond || 0));
    this.minGlobalStartIntervalMs = this.targetPagesPerSecond > 0 ? Math.ceil(1000 / this.targetPagesPerSecond) : 0;
    this.nextGlobalStartAt = 0;
    this.onCooldown = onCooldown;
    this.hosts = new Map();
  }

  async acquire(url) {
    const host = hostFromUrl(url);
    const state = this.getState(host);
    while (true) {
      const now = Date.now();
      const waitForConcurrency = state.active >= this.maxConcurrentPerHost;
      const waitForDelay = state.nextAllowedAt > now;
      const waitForCooldown = state.cooldownUntil > now;
      const waitForGlobalRate = this.nextGlobalStartAt > now;

      if (!waitForConcurrency && !waitForDelay && !waitForCooldown && !waitForGlobalRate) {
        state.active += 1;
        if (this.minGlobalStartIntervalMs > 0) {
          this.nextGlobalStartAt = Date.now() + this.minGlobalStartIntervalMs;
        }
        return () => this.release(host);
      }

      const waits = [];
      if (waitForConcurrency) waits.push(25);
      if (waitForDelay) waits.push(state.nextAllowedAt - now);
      if (waitForCooldown) waits.push(state.cooldownUntil - now);
      if (waitForGlobalRate) waits.push(this.nextGlobalStartAt - now);
      await sleep(Math.max(1, Math.min(...waits)));
    }
  }

  release(host) {
    const state = this.getState(host);
    state.active = Math.max(0, state.active - 1);
    if (this.crawlDelayMs > 0) {
      state.nextAllowedAt = Date.now() + this.crawlDelayMs;
    }
  }

  cooldown(url, ms, reason = 'Host cooldown') {
    const host = hostFromUrl(url);
    const state = this.getState(host);
    const until = Date.now() + Math.max(0, Number(ms || 0));
    state.cooldownUntil = Math.max(state.cooldownUntil, until);
    if (this.onCooldown) this.onCooldown({ host, ms, reason, cooldownUntil: new Date(state.cooldownUntil).toISOString() });
  }

  getState(host) {
    if (!this.hosts.has(host)) {
      this.hosts.set(host, { active: 0, nextAllowedAt: 0, cooldownUntil: 0 });
    }
    return this.hosts.get(host);
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
