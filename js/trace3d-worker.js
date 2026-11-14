// Module worker: runs traceScene off the editor's main thread.
// Message in: { id, document, options }. Messages out: { ready } once loaded, { id, progress } (0–1) during long
// traces when options.progress is true, then { id, result } or { id, error }.
import { traceScene } from "./trace3d.js";

self.postMessage({ ready: true });        // handshake: js/app3d.js queues requests until this arrives

self.onmessage = event => {
  const { id, document, options = {} } = event.data || {};
  try {
    const { progress, ...rest } = options;
    const onProgress = progress ? fraction => self.postMessage({ id, progress: fraction }) : undefined;
    self.postMessage({ id, result: traceScene(document, { ...rest, onProgress }) });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
