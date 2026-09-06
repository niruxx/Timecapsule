// Minimal counting semaphore: acquire() resolves once a slot is free (immediately if one already
// is), release() hands that slot straight to the next waiter if there is one. Used to cap how
// many archive jobs actually run their Puppeteer work at once, without needing a queue library
// or an external service - fits the same "no new infra" bias as the rest of this project.
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  get isFull() {
    return this.active >= this.limit;
  }

  get queueLength() {
    return this.queue.length;
  }
}

module.exports = { Semaphore };
