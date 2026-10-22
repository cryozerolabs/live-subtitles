// One provider request at a time. Intermediate work is expendable; final work is not.
export class ModelLane {
  constructor() { this.active = null; this.waiting = []; }

  run(work, { final = false, owner } = {}) {
    if (!final && (this.active || this.waiting.length)) return null;
    const task = { work, final, owner, controller: new AbortController() };
    const promise = new Promise((resolve, reject) => Object.assign(task, { resolve, reject }));
    this.waiting.push(task);
    if (final && this.active && !this.active.final) this.active.controller.abort();
    this.pump();
    return promise;
  }

  pump() {
    if (this.active || !this.waiting.length) return;
    const task = this.active = this.waiting.shift();
    Promise.resolve().then(() => {
      task.controller.signal.throwIfAborted();
      return task.work(task.controller.signal);
    }).then(task.resolve, task.reject).finally(() => { this.active = null; this.pump(); });
  }

  cancel(owner) {
    if (this.active?.owner === owner) this.active.controller.abort();
    for (const task of this.waiting.filter(t => t.owner === owner)) {
      task.controller.abort(); task.reject(new DOMException('Cancelled', 'AbortError'));
    }
    this.waiting = this.waiting.filter(t => t.owner !== owner);
  }
}
