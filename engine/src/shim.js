// visit-engine's shim (SPEC 5.1, points 2 to 5). The driver puts it into every document of the page before
// the page's own scripts run (Page.addScriptToEvaluateOnNewDocument), with "__URL__", "__TOKEN__" and
// __TICK_IDLE__ filled in. It touches nothing but what is listed here.
(() => {
  const E = window.VISIT_ENGINE = { url: "__URL__", token: "__TOKEN__", role: "host", idle: false, frames: 0, tickIdle: __TICK_IDLE__ };
  const noop = function () {};

  // Drawing is free: the WebGL context the page gets is the real one with its draw calls made no-ops (point 3).
  // Programs compile, geometry and textures upload, readPixels reads what is there (nothing drawn); 2D contexts
  // are untouched. The two extensions are the same draw calls under WebGL1's and multi-draw's names.
  const DRAWS = ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements", "clear", "blitFramebuffer"];
  const EXTENSION_DRAWS = {
    ANGLE_instanced_arrays: ["drawArraysInstancedANGLE", "drawElementsInstancedANGLE"],
    WEBGL_multi_draw: ["multiDrawArraysWEBGL", "multiDrawElementsWEBGL", "multiDrawArraysInstancedWEBGL", "multiDrawElementsInstancedWEBGL"],
  };
  const silence = (o, names) => { for (const n of names) if (typeof o[n] === "function") Object.defineProperty(o, n, { value: noop, writable: true, configurable: true }); };
  const seen = new WeakSet();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const gl = getContext.call(this, type, ...rest);
    if (gl && (type === "webgl" || type === "webgl2" || type === "experimental-webgl") && !seen.has(gl)) {
      seen.add(gl);
      silence(gl, DRAWS);
      const getExtension = gl.getExtension;
      Object.defineProperty(gl, "getExtension", { value: function (name) {
        const x = getExtension.call(this, name);
        if (x && EXTENSION_DRAWS[name] && !seen.has(x)) { seen.add(x); silence(x, EXTENSION_DRAWS[name]); }
        return x;
      }, writable: true, configurable: true });
    }
    return gl;
  };

  // The page is looked at (point 4): visible, focused, and without a microphone.
  Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
  Document.prototype.hasFocus = () => true;
  const noMicrophone = () => Promise.reject(new DOMException("Requested device not found", "NotFoundError"));
  if (window.MediaDevices) MediaDevices.prototype.getUserMedia = noMicrophone;
  else Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: noMicrophone }, configurable: true });   // an http origin has none

  // The room ticks (point 5): callbacks run from the real requestAnimationFrame (60 a second) while someone is
  // there, from a timer at tickIdle a second while VISIT_ENGINE.idle (the driver sets it once a second). The
  // loop itself always runs, callbacks or not, and counts its frames in VISIT_ENGINE.frames: the driver's sign
  // of life (point 6). Callbacks asked for during a frame run in the next, as with the real one.
  const rAF = window.requestAnimationFrame.bind(window);
  let queue = new Map(), nextId = 1, wasIdle = false, dueAt = 0;
  const frame = now => {
    const callbacks = queue;
    queue = new Map();
    E.frames++;
    for (const cb of callbacks.values()) {
      try { cb(now); } catch (e) { setTimeout(() => { throw e; }); }   // reported as the real one reports it; the others still run
    }
    schedule();
  };
  const schedule = () => {
    const idle = !!E.idle;
    if (!idle) { wasIdle = false; return rAF(frame); }
    const now = performance.now(), period = 1000 / Math.min(60, Math.max(1, Number(E.tickIdle) || 10));
    dueAt = wasIdle ? Math.max(dueAt + period, now) : now + period;   // kept on the beat; not stacked after a long frame
    wasIdle = true;
    setTimeout(() => frame(performance.now()), dueAt - now);
  };
  window.requestAnimationFrame = cb => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = id => { queue.delete(id); };
  schedule();
})();
