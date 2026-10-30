import { sleep } from './util.js';

/** Shared rolling-window request starts; does not hold slots until responses finish. */
export class DiscoveryRateLimiter {
  constructor({ rpm = 600, now = Date.now, sleepImpl = sleep } = {}) {
    this.rpm = Math.max(1, Math.floor(rpm));
    this.now = now;
    this.sleep = sleepImpl;
    this.starts = [];
    this.tail = Promise.resolve();
  }

  acquire() {
    const pending = this.tail.then(async () => {
      for (;;) {
        const now = this.now();
        this.starts = this.starts.filter(t => t > now - 60000);
        if (this.starts.length < this.rpm) { this.starts.push(now); return; }
        await this.sleep(Math.max(1, this.starts[0] + 60000 - now));
      }
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
}
