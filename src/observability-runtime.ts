import { watch } from 'node:fs';
import { Observability, OBS_LIMITS } from './observability.js';

/** No polling timer while off. File notifications and command admission reconcile the preference. */
export function observeProcess(
  observer: Observability,
  intervalMs: number = OBS_LIMITS.sampleMs,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let retention: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let watchDegraded = false;
  function reconcile(): void {
    observer.refresh();
    if (!observer.enabled || closed) {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!closed && !retention && observer.maintain()) {
        retention = setInterval(() => {
          if (!observer.maintain()) {
            clearInterval(retention);
            retention = undefined;
          }
        }, intervalMs);
        retention.unref();
      }
      return;
    }
    if (retention) clearInterval(retention);
    retention = undefined;
    if (timer) return;
    let previous = process.cpuUsage();
    let previousTime = performance.now();
    timer = setInterval(() => {
      try {
        observer.refresh();
        if (!observer.enabled) {
          reconcile();
          return;
        }
        const currentTime = performance.now();
        const current = process.cpuUsage();
        const memory = process.memoryUsage();
        observer.record('sample', {
          elapsedMs: currentTime - previousTime,
          cpuUserUs: current.user - previous.user,
          cpuSystemUs: current.system - previous.system,
          rssBytes: memory.rss,
          heapBytes: memory.heapUsed,
          lagMs: Math.max(0, currentTime - previousTime - intervalMs),
        });
        previous = current;
        previousTime = currentTime;
      } catch {
        observer.failure();
      }
    }, intervalMs);
    timer.unref();
  }
  try {
    watcher = watch(
      observer.directory,
      { persistent: false },
      (_event, name) => {
        if (name === 'observability.json') reconcile();
      },
    );
    watcher.on('error', () => {
      watchDegraded = true;
    });
  } catch {
    watchDegraded = true;
  }
  reconcile();
  return {
    reconcile,
    status() {
      reconcile();
      return {
        ...observer.status(),
        samplerActive: timer !== undefined,
        retentionActive: retention !== undefined,
        preferenceWatchDegraded: watchDegraded,
      };
    },
    stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (retention) clearInterval(retention);
      retention = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}
