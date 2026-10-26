// visit.js: the Visit library (../../SPEC.md section 9; ../../INTEGRATING.md shows it in use). Served by
// visit-client at /visit.js, so a page always runs the library its visit-client speaks. It talks only to
// that visit-client, on 127.0.0.1: it keeps the lobby's state, sends this room's three.js scene to its
// visitors (moving them with its hooks, spawn and move), draws the scene of the room it visits, and captures
// a visitor's input (SPEC 8).
//
//   const v = await Visit.connect({ port, token, sim: { name, version } });
//   v.host({ spawn, move, fov, scene: { root, three, renderer, near, far }, walk: { speed } });
//   Visit.stage(v);   Visit.panel(element, v);
//
// A room takes part once it hosts its scene: every room is three.js, and a visitor's browser draws the room it
// visits itself, with that very three.js release. Walking and looking are as quick as in its own room (the
// visitor's page walks at once and the host corrects it), and a host renders and encodes nothing for anyone.
"use strict";
(function () {
  const VERSION = "0.5.0", PROTO = "basedverse-visit-local/2";
  const MOVE_MS = 1000 / 60, INPUT_MS = 1000 / 30, INPUT_MIN_MS = 8, STALE_MS = 300, LOOK = 0.0025;
  // What the host hears many times a second: none of it changes what the page shows, so none fires "change".
  const QUIET = new Set(["input", "keyframe", "link_stats", "scene", "scene_lost", "scene_resync"]);
  // A timer from a Worker: a page's own timers slow to once a second (or less) while its tab is in the
  // background, and a host must go on rendering for its visitors.
  function ticker(ms, fn) {
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms});`], { type: "text/javascript" })));
      w.onmessage = fn;
      return { stop: () => w.terminate() };
    } catch (e) {   // workers forbidden (a strict CSP): the page's own timer, slow in the background
      const t = setInterval(fn, ms);
      return { stop: () => clearInterval(t) };
    }
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- scenes: a three.js room, sent as itself and drawn by the visitor's own browser (SPEC 8) ----------
  // A host sends its scene once whole (three.js's own JSON, gzipped), then what changes in it (edits: gzipped
  // JSON, in order, never dropped) and where its moving things are (deltas: binary, newest wins). The visitor
  // draws it with the very three.js release the host runs, fetched from a CDN and checked against the hashes
  // below (Subresource Integrity): nothing else ever runs from it, and what the host sends is only ever read as
  // data (cleanScene). The visitor walks at once, predicted here, and the host's answer corrects it.
  const KEY = 1, EDIT = 2;   // frames' flags: bit 0 a key delta; bit 1 a scene edit (page to visit-client) (SPEC 5.4)
  // How often a host sends its scene's changes, and the places of everything that has moved, regardless; how far
  // behind the host's clock a visitor shows moving things (two updates: always one to move toward); the most
  // pixels a visitor's view draws (it is stretched past that).
  const SCENE_MS = 1000 / 30, SCENE_KEY_MS = 1000, INTERP_MS = 70, MAX_PIXELS = 1920 * 1080;
  const THREE_BASE = "https://cdn.jsdelivr.net/npm/three@0.{r}.0/build/";
  // three.js revision -> the SHA-384 of its first release's build/three.module.js, or (r171 on, split in two)
  // of [build/three.core.js, build/three.module.js]. A visitor draws the scenes of these revisions.
  const THREE_FILES = {
    "125": "sha384-5Ywi4WNpxs0w7HozLb+bKpTJNY20kAqeXn8GWrqNsIc35NOt7tqRDsjlqQTNQKNF",
    "126": "sha384-B1lRArgkaBiW5faJFZgZ3Y/384PIWuidSL2uNNndFO/OQpgx/t0B+JdK3sNZYM95",
    "127": "sha384-sBwxpuzXNbu5dmQMypWvEMKwpJDWuwlKjYHspu3bOhU6kotCdQhWEohdiMepsva6",
    "128": "sha384-LKlxEdW8EIaLsGQXf6tbodzIk3iElYdwYuFHYRIoTn89xvUzXM/9Ld9KPYTxk4Zc",
    "129": "sha384-hO+ysv9dQX1marzdRDxUAzpim6yMr73w6MnaXEg5Vn530DDf+Bz/u2HrxhcQ7WZM",
    "130": "sha384-X30Nbdd324ays+U+6cW5KSPkr0k/KfDLJdev9xVyIaIQV5vSogTGprr9OMpcV4H5",
    "131": "sha384-v4PgD/ouaGXkgMqHuWiTq9lZJ+lsGK0r3f8/TqN9VPaTSNAPlCJHFhHXPwecfYgh",
    "132": "sha384-4TMDanTqjpAj1zaXppMTQaRdrAF8dP7IzGhr2Vkz5ZDFEK+a8Rb9ikEFyrywstVu",
    "133": "sha384-+9gvq6U5LIiKWpZr5TN4CKBaFHYJYjJBBfCmeLUOYHOyeauFczAKYeko695NhW7a",
    "134": "sha384-Wfr00bxzAvoTAQTXfxH8PIsT5JJIY/U+Z9XziadFRmiHk8OebbConLyrX6sYU/ge",
    "135": "sha384-G2EofhFHZOwtmrs8D3EiwAeo83NR9KAKuB0KTscSkOS0GMhnkZu/2xUn85J4TW6m",
    "136": "sha384-gQBL0VcTpNUqiL90PW82aoOu6EHGaqkmfUdzwqlFCcEiEmMsFanJvrfZ88AoTK+l",
    "137": "sha384-L4AJFgq8HHKtqeG+0jy6j5ZajIGQz37TAiQjQQCbwly2X3MYaU5foXmQseXyP+qk",
    "138": "sha384-pjwJZ/skEfUdUP3KMcJ7R7DK0EuZRYe5F9dorg6Wn/Ir0ZeFouRUyTWHf7LmJA5R",
    "139": "sha384-S5XkCGb5am6P7Rv2RXgTA4Krb3LXhedDK+YrtyqC0195vctAZkIlKE4j5C+azzwc",
    "140": "sha384-V5FXA8YZz9kx4vKeRWWrjBs0EMbFFlPlJp5Rc0Dzove929kAD660bBoCcwP+Ku3A",
    "141": "sha384-po1eddWuuRpjNPxlslM9lQb0UPFCrgL7nJdSnu9zmkjbhitNFai6at7zcS+2O/7B",
    "142": "sha384-x/Al+cOCpZIKZIRFdekN+Yu0ntTZtyTXzAuivfVKLjjAVruJbmDqC37QdupObzUn",
    "143": "sha384-rkhRzjkxQRTIq6KfhMlmDK0WeNc7zppOEgXQbexSP7iFO7OilyNewEUMC02ojJ3o",
    "144": "sha384-zGPkkFv5YPY4udMFe6P/NKDGsgOpNa60NEbvZHPHLGtTr4/aHBMtPJG/clUwH1X1",
    "145": "sha384-D5chtu28ZTnLB+ntDkE/IM65wndGw1NB7eVUEEJk+GiUt/+VJlvZC26KwMAM8olN",
    "146": "sha384-EgZkglHd5d5CpSGV/XQ+oAL89JkW5Jss32pdskxNQb3V/7H9pZblIhbbWs2yGyrs",
    "147": "sha384-foyviqS/+yPbsMkU32dJTGX9lWnqtalJsKDYMmQ0Tr+tiJqUYE/tTTs1nl3dP/PI",
    "148": "sha384-Ov4qZQIF7j8e5K2QrP/k/FbyJBxNvZtXnwJ4i05t/pCaf6eWKwMpMuQcPsj7rNLg",
    "149": "sha384-12YogFBvdVetjPVfxidCU7NzjtjvSQnNeVzUAtopFVGtoco6uyZfxHwbAU1E6nB9",
    "150": "sha384-4XHUcSkRNflX/146yx9K2FPU3HI4DuRxC1ZOQ25lkVKrhnHYAkQypBvChqRHFXnN",
    "151": "sha384-ls6F1ocsyH0C4W24fbbUlOxnRPJcvyr2j7+QZKQD9bzpHwhtw7IFHaN5aND2bKHB",
    "152": "sha384-Q+gzrfCnkOqOv+jRz5Pn2712IWFGBxVZBR7KLX63tOie3TCDPfmqafcbcowKMDVX",
    "153": "sha384-Ftnx0JBTANz3pBRth6b6WelDf1nk4opQiE62V92gzUHaQ8Rx75aR3FCfD3xh+udC",
    "154": "sha384-iJA3Wh2Mk4VM2GiHhGzeRsMla5CtcEYxZOgF1WnaxXWsoAIV52usXoLuuD5EUd97",
    "155": "sha384-mnNh5DCZAFA4qsq6N8lzuYrSVHDw47RurhMpZQWOPZbbKnkesHLJlkKh0ZMyK97x",
    "156": "sha384-CYnyeGNCWc3qAUjmhBJ5c7rSNKZkWKCPS1l5/XfFEGvQSa7qevZ622z98lXKmTf5",
    "157": "sha384-8HEtwX7v0qvVEXBPVFMWgMAgI6hHJzZ0qycweA/vGl79MWdyXxzAHl0XwWprM3nY",
    "158": "sha384-iuC3I0bVuCDzGoJi9KmCkGzEwo7vYFG/gBa7C/1D7mp8ZTt1CgTJ8C57dTDqqpfM",
    "159": "sha384-Od8aWTp92huHhx5H/3qCH5ZPG12v/+EpJktLK/hPpYiC4UoV1yf8OeSk+jD/GCC3",
    "160": "sha384-61S/Nu32S3E5+n+KpCOTb2eRYps6fVKm+9Gz1QBvSePFthb46f063Aa/qe/lykFZ",
    "161": "sha384-c1WSdrtrvLWoZQC5zBcuCBhTpWvCcKFvUPFkF9wsEestdGUyCxZPiVXzYCZEPRzJ",
    "162": "sha384-94gajc6XgNyCt0QElkXXk0mG9VEkNMmL4KZrhzqiErIDYDnA9qb8lR13pW6DGZMN",
    "163": "sha384-yQjt8MxgaibK/2q9rswHtmpprSJXTyvk5UewNPUcnFG8AS53v7JY3JcBgjMD0REu",
    "164": "sha384-wlK04bYFr3nyu6ipQq5N4n7KKGByMS1Yu1T8IrNtEnHiJ5WcGDt9dZBZFpRZjXEE",
    "165": "sha384-Qvl1RLjZOCDFOOH2bKcGnaDHMM8MVv3zVtMvhy3juQdiIOs6RgQ/7zYdM1FbpHzI",
    "166": "sha384-8Ka7v/0OHGFjCdsh2NfPsfSx8QWgM5GXxK78G78tnUN7UjY9LkOqJToGj10DT7Yh",
    "167": "sha384-efR4yFjiLe4PrOyKvJfuUnmdEz0ohNoJEvmCVrdgDU5eigOkblJOVZwt1g8+64kv",
    "168": "sha384-aFCwa46B5vks6EU3cxsUhpA9qOy3yrw5fTF4Y51WEavCCGWj0YzSGsdsP5Ougby2",
    "169": "sha384-qOubuRxWZ0I7rXTjcuhcKNHKvPM7q0ztN8/82sJnxnyKS0OXTeB5FsIcysc2T9EY",
    "170": "sha384-GY5FqjttLCFRt/McQbyaVdCk2O1IQtOeX8Py6NfD89BIAsIyJFRl4UgSXrk2vXAk",
    "171": ["sha384-YpGRVT0+68wf/Tq05Sw6Nuv4F785EXwqdLOynItG6Cyvn2LGu9TSE99n+EUK12AD", "sha384-u+VykAKeL4ZnM4aIDWzqvG2G/XJtXtrdNfBeIn3gGrgMUCGh300cp5h8q6Cl2p+y"],
    "172": ["sha384-gJN+0/sjgafSBd8VGFwNZmLffdxHYB9basxDhZKjxH7PqUizoWy+ZFIAWfknJpsS", "sha384-jSE70HgY49pvjJTRC7wZjn6JUajBcRHT3XSUEIeBqOuHlY8AzkDEjQ1Ortuqy9gh"],
    "173": ["sha384-hDOhkNIzjECbUeD7y0ZuARgCndDLsHIuKhhnmv7Aqxr6MarrEsKbcu33dVXVKVja", "sha384-0SHQLUQ+OesZFn0blBzsF4hsvOTa52wQyct1xwYFAnTTcE3zrv7TSNt/nPZ4TGzq"],
    "174": ["sha384-v4ooZZpwAOZGuZr/1Aw2lIuvBUqLMXwXo4YPUxvwjAEX7LMjrTbTJ00YxL392JL/", "sha384-XYnXNAOuPDbehWj5Esz4dUjqxDbdgiQMzzHwBk3u+S8hIT06xorwCCqxT2/levx+"],
    "175": ["sha384-9iVlJdFMhmo7AjXDdUB+T8nF93quj9nhfeEX3b2Nklv3aoN/VAqsSYpJ+aKLZbxc", "sha384-54vXwOTeTwpNxEBFrjmaBZG3guaJvxC0KbKuhK3YwfVvQipd0/xa0P3Y2b6EMt31"],
    "176": ["sha384-otibkZtXfamhCvKhSPwls+10DMOoYgxW8HQCOC6H0tG3MY+mchtwF0XlkGdPAzBY", "sha384-p5Plfh0W9MU6uGNwg+SryQ5EROPDcqxekRMB9Crrr+uCHXcgE3T0oot4ByGAYDKa"],
    "177": ["sha384-m0oq2VuT/Tt5IpjZtCp+HTaarVOrfp03v2AYRveyDoX4lOVlpk1DPm8fgcn1tDes", "sha384-ITUL0v5v2j45lpwmHksUHldYxM9gaEuM96EH4dDqwIVZpxWI+PMksJcTHxCAB1jM"],
    "178": ["sha384-v7zMvc4Cb5TVml7Htaud7ffbaZ6T1inM2KUGHbfogwbzpbM2HjvdYcn9CpA750Gb", "sha384-FWF4sd0r4IzFTqeNbUmKIVBAWeo88feJafLWCRweaAy60myqpVini5QSjSFsDJ0a"],
    "179": ["sha384-kdRESMLTvI77N5JbbUfZRkASeD0sPnpy89hrqC8kG9/Ih16CWrS9L9qpIdd7CYTM", "sha384-NU/HwPb+8799fAUOI2MmcKBXISPLF1rxYZk5lhnqPQ+IWd3zjAvW2jv0RSihhPKx"],
    "180": ["sha384-r1q8Si7xFBrvMv3Q4yjQkKhkYZ2lp+wn/bPPzNZTsc8DY4uPJmm2vheuz1Yn+8m8", "sha384-wyxAlyAVVsyc7KN24a4+m1tMTC2BwrjQyLgLStDaUBDmwK+gWUMULWHSS0NRoZKv"],
    "181": ["sha384-TwzOUuMYWxW+SbKueCH0R+hoyXBEJ4ZosoHXv+5iX96teAZkI7+lJzKISlR0DRyV", "sha384-fV/3dzi4eiEEAyJEEtFCmXv8gRy4AYNwnDxN+Ki3G97d4hZOliHXxM65JEZbgdsV"],
    "182": ["sha384-6fmg00/Gyjwhs6thvtCHmdaCH/64inXNq9FpwdBWtjV7wHXiHPaPtkBTXl1J7w17", "sha384-u+OjJoQpIuqoJyY+K18+0gLahoZWtDRoz5XJlhiJ/9OpKZV61xnAmgFDYGLrD8X7"],
    "183": ["sha384-bO4ODxwQgwSn05egB/vbceihrp4tn6jmJzx7oZDy/EVWd0imIgGkvccDH3k6HXdL", "sha384-tDnOBR4yGB9V87jI7t3/bA2vGgtDUaOU+poekPUUnV7O3yEhLb4f+gRAXEd6eoCN"],
    "184": ["sha384-dw2ooPewaEIrAgl6oFDBmmBWCE9oW9LxRGcfwZ0hLvEprzo202wXl7vCYHRlSnOT", "sha384-8FCZ1eVO6it4+pbec2aDtnTrwjWXZLJRC+MAGCIPDgsYnUrl/E0A2YlF8ioMKI/J"],
    "185": ["sha384-3nKmLDZR5EoFrqfdssW1u3u4Mi0kjozeBhgNj6XQQ7CT8BEnu/6Skhv0k4MDLmoN", "sha384-Ecdwhw2t8c3nTR0hkEDZbwj+5rkKqzJ376RCQN2x1uofujOCuW/EvGg3BQzE7TS6"],
    "186": ["sha384-mdKeCwPEcbDvzaxwhm+MVuLoMou+E7jQqrs4tmu/n8HBYPGI1kZt0MkJxlMR4zFM", "sha384-m8JoFX52V6NGv2usipnlLJKnJfL7IE8dbniPDDCSGSQv3Hm4n6PjfV6syVwfuoRc"],
  };
  const threes = new Map();   // revision -> its module (a promise)

  // A three.js release as a module of its own (not the page's THREE): fetched, checked against its hash, run.
  function loadThree(rev, base) {
    rev = String(rev);
    if (!threes.has(rev)) {
      const files = THREE_FILES[rev];
      const p = !files ? Promise.reject(new Error(`three.js r${rev} is not one this visit.js knows`)) : (async () => {
        const url = f => (base || THREE_BASE).replace("{r}", rev) + f;
        const get = async (f, integrity) => {
          const r = await fetch(url(f), { integrity, credentials: "omit" });
          if (!r.ok) throw new Error(`${url(f)}: ${r.status}`);
          return r.text();
        };
        const js = text => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
        let main;
        if (Array.isArray(files)) {   // three.module.js imports ./three.core.js: the checked copy instead
          const core = js(await get("three.core.js", files[0]));
          main = (await get("three.module.js", files[1])).replace(/(["'])\.\/three\.core\.js\1/g, JSON.stringify(core));
        } else main = await get("three.module.js", files);
        // three.js warns of a second copy in a page (the room's own): this one is apart, on purpose.
        const prev = window.__THREE__;
        window.__THREE__ = undefined;
        try { return await import(js(main)); } finally { window.__THREE__ = prev; }
      })();
      threes.set(rev, p);
      p.catch(() => threes.delete(rev));
    }
    return threes.get(rev);
  }

  // A data URL image's size, from its header (PNG, JPEG, WebP), before anything decodes it; null if not one.
  function imageDims(url) {
    const m = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
    if (!m) return null;
    let b;
    try { b = Uint8Array.from(atob(url.slice(m[0].length, m[0].length + 87380)), c => c.charCodeAt(0)); } catch (e) { return null; }
    const u16 = i => (b[i] << 8) | b[i + 1], le = (i, n) => { let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + k]; return v; };
    if (m[1] === "png") return b.length >= 24 && b[1] === 0x50 ? [u16(16) * 65536 + u16(18), u16(20) * 65536 + u16(22)] : null;
    if (m[1] === "jpeg") {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [u16(i + 7), u16(i + 5)];
        i += mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7) ? 2 : 2 + u16(i + 2);
      }
      return null;
    }
    const kind = String.fromCharCode(...b.slice(12, 16));
    if (kind === "VP8 ") return [le(26, 2) & 0x3fff, le(28, 2) & 0x3fff];
    if (kind === "VP8L") return [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))];
    if (kind === "VP8X") return [1 + le(24, 3), 1 + le(27, 3)];
    return null;
  }

  // What a host sends, made safe to hand to three.js's ObjectLoader (SPEC 8.3): materials only of the kinds
  // three.js draws itself (a ShaderMaterial is a program: it becomes plain grey), images only as data URLs no
  // bigger than 4096 px a side (checked from their headers, before decoding), shapes' segment counts at most
  // 256, and, across the scene, at most about 4 million vertices and 100,000 objects. In place; the JSON too.
  const MATERIALS = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshStandardMaterial", "MeshPhysicalMaterial",
    "MeshToonMaterial", "MeshNormalMaterial", "MeshMatcapMaterial", "MeshDepthMaterial", "MeshDistanceMaterial", "LineBasicMaterial",
    "LineDashedMaterial", "PointsMaterial", "SpriteMaterial", "ShadowMaterial"]);
  const SEGMENTS = new Set(["widthSegments", "heightSegments", "depthSegments", "radialSegments", "tubularSegments", "capSegments",
    "phiSegments", "thetaSegments", "segments", "curveSegments", "steps", "bevelSegments"]);
  const ARRAYS = new Set(["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array"]);
  const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const MAX_SIDE = 4096, MAX_VERTICES = 4e6, MAX_OBJECTS = 1e5;
  const isObj = x => !!x && typeof x === "object" && !Array.isArray(x);
  function cleanScene(json, budget) {
    if (!isObj(json)) throw new Error("a scene is a JSON object");
    const arr = k => (Array.isArray(json[k]) ? json[k] : []).filter(isObj);
    json.materials = arr("materials").map(m => MATERIALS.has(m.type) ? m : { uuid: String(m.uuid), type: "MeshLambertMaterial", color: 0x808080 });
    json.geometries = arr("geometries").map(g => {
      let n = 1;
      if (isObj(g.data)) n = (((g.data.attributes || {}).position || {}).array || []).length / 3;
      else {
        const clamp = (o, k, hi) => { o[k] = Math.max(0, Math.min(hi, Math.floor(Number(o[k]) || 0))); return o[k]; };
        const p = isObj(g.parameters) ? g.parameters : {};
        for (const o of [p, isObj(p.options) ? p.options : {}]) for (const k of Object.keys(o)) if (SEGMENTS.has(k)) n *= clamp(o, k, 256) + 1;
        if ("detail" in p) n *= 20 * (clamp(p, "detail", 5) + 1) ** 2;
        if (Array.isArray(p.points)) { p.points = p.points.slice(0, 4096); n *= p.points.length; }   // a lathe's outline
        if (/Box/.test(g.type)) n *= 6;
      }
      budget.vertices += n;
      return budget.vertices <= MAX_VERTICES ? g : { uuid: String(g.uuid), type: "BufferGeometry", data: { attributes: {} } };
    });
    const ok = u => {
      if (typeof u === "string") { const d = imageDims(u); return d && d[0] <= MAX_SIDE && d[1] <= MAX_SIDE ? u : BLANK; }
      return isObj(u) && Array.isArray(u.data) && ARRAYS.has(u.type) && u.width > 0 && u.height > 0 && u.width <= MAX_SIDE && u.height <= MAX_SIDE
        && u.data.length <= u.width * u.height * 4 ? u : BLANK;
    };
    json.images = arr("images").map(im => ({ uuid: String(im.uuid), url: Array.isArray(im.url) ? im.url.slice(0, 6).map(ok) : ok(im.url) }));
    let count = 0;
    const stack = [json.object];
    while (stack.length) {
      const o = stack.pop();
      if (!isObj(o)) continue;
      count++;
      if (Array.isArray(o.children)) { o.children = o.children.filter(isObj); for (const c of o.children) stack.push(c); }
    }
    budget.objects += count;
    if (budget.objects > MAX_OBJECTS) throw new Error(`more than ${MAX_OBJECTS} objects`);
    return json;
  }

  // What the host's renderer draws with, for the visitor's to match, by what its release calls it.
  function rendererProps(r, three) {
    const rev = Number(three.REVISION), out = {};
    if (!r) return out;
    if (r.shadowMap) out.shadowMap = { enabled: !!r.shadowMap.enabled, type: r.shadowMap.type };
    const keys = ["toneMapping", "toneMappingExposure", "sortObjects", rev < 152 ? "outputEncoding" : "outputColorSpace"];
    if (rev < 155) keys.push("physicallyCorrectLights"); else if (rev < 165) keys.push("useLegacyLights");
    for (const k of keys) if (k in r && ["number", "boolean", "string"].includes(typeof r[k])) out[k] = r[k];
    try { const c = new three.Color(); r.getClearColor(c); out.clear = [c.getHex(), r.getClearAlpha()]; } catch (e) { /* not this release */ }
    if (rev >= 152 && three.ColorManagement) out.colorManagement = !!three.ColorManagement.enabled;
    return out;
  }

  // A material's state that changes as a room runs (colours, opacity, visibility...), sent as it changes; a
  // change of its textures sends the whole material again.
  const COLORS = ["color", "emissive", "specular"];
  const VALUES = ["opacity", "transparent", "visible", "wireframe", "side", "depthWrite", "depthTest", "alphaTest", "emissiveIntensity",
    "roughness", "metalness", "shininess", "size", "rotation", "vertexColors", "flatShading", "fog", "toneMapped", "blending"];
  const RECOMPILE = new Set(["transparent", "side", "vertexColors", "flatShading", "fog", "alphaTest", "blending", "toneMapped", "wireframe"]);
  const MAPS = ["map", "emissiveMap", "alphaMap", "normalMap", "bumpMap", "aoMap", "lightMap", "roughnessMap", "metalnessMap", "specularMap",
    "envMap", "gradientMap", "matcap", "displacementMap"];
  const list = x => Array.isArray(x) ? x : x ? [x] : [];
  function matProps(m) {
    const p = {};
    for (const k of COLORS) if (m[k] && m[k].isColor) p[k] = m[k].getHex();
    for (const k of VALUES) if (k in m && ["number", "boolean"].includes(typeof m[k])) p[k] = m[k];
    return p;
  }
  function setProps(m, p) {
    for (const k of COLORS) if (typeof p[k] === "number" && m[k] && m[k].isColor) m[k].setHex(p[k]);
    for (const k of VALUES) {
      if (!(k in p) || !(k in m) || typeof p[k] !== typeof m[k] || m[k] === p[k]) continue;
      m[k] = p[k];
      if (RECOMPILE.has(k)) m.needsUpdate = true;
    }
  }
  const mat16 = (a, b) => { for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return true; return false; };
  const keep = (a, x) => { a.push(x); if (a.length > 6000) a.splice(0, 1000); };

  // The host's side of a scene: what it last sent of each object, material, geometry and texture, so that each
  // round (every SCENE_MS) sends only what changed. One for all of a host's visitors: they get the same edits.
  class SceneSync {
    constructor(cfg) {
      const t = cfg.three;
      Object.assign(this, { cfg, objs: new Map(), next: 1, mats: new Map(), geos: new Map(), texs: new Map(), dynamic: new Set(), sent: new Set(),
        keyAt: 0, sceneSig: null, tmp: { p: new t.Vector3(), q: new t.Quaternion(), s: new t.Vector3() } });
      this.scan(0);   // where everything is now: what the first whole scene shows
    }

    _record(o, parent) {
      const r = { o, idx: this.next++, parent: parent ? parent.o.uuid : null, mats: list(o.material).map(m => m.uuid).join(),
        geo: o.geometry ? o.geometry.uuid : "", m: Float64Array.from(o.matrix.elements), vis: o.visible };
      this.objs.set(o.uuid, r);
      return r;
    }

    // Since the last round: objects added (whole, with what they are made of), removed, moved to another parent,
    // given other materials or geometry; materials' state; geometries and textures changed in place; the scene's
    // background and fog: { edit (null: nothing), moved (the objects whose place or visibility changed) }.
    scan(now) {
      const root = this.cfg.root, first = !this.objs.size;
      const adds = [], removes = [], parents = [], assigns = [], props = [], moved = [], res = new Map(), seen = new Set();
      const usedMats = new Set(), usedGeos = new Set(), usedTexs = new Set();
      root.updateMatrixWorld();
      const stack = [[root, null, false]];
      while (stack.length) {
        const [o, parent, fresh] = stack.pop();
        seen.add(o.uuid);
        let r = this.objs.get(o.uuid), inNew = fresh;
        if (fresh || !r) {
          if (r) removes.push(r.idx);   // it was elsewhere: it comes again within what it was added under
          r = this._record(o, parent);
          if (!fresh && !first) { adds.push(r); inNew = true; }
        } else {
          const p = parent ? parent.o.uuid : null;
          if (r.parent !== p) { r.parent = p; parents.push([r.idx, parent ? parent.idx : 0]); }
          const mats = list(o.material).map(m => m.uuid).join(), geo = o.geometry ? o.geometry.uuid : "";
          if (mats !== r.mats || geo !== r.geo) { r.mats = mats; r.geo = geo; assigns.push(r); }
          if (r.vis !== o.visible || mat16(r.m, o.matrix.elements)) { r.m.set(o.matrix.elements); r.vis = o.visible; moved.push(r); this.dynamic.add(r); }
        }
        for (const m of list(o.material)) usedMats.add(m);
        if (o.geometry) usedGeos.add(o.geometry);
        for (let i = o.children.length - 1; i >= 0; i--) stack.push([o.children[i], r, inNew]);
      }
      const gone = [];
      for (const [uuid, r] of this.objs) if (!seen.has(uuid)) { this.objs.delete(uuid); this.dynamic.delete(r); gone.push(r); }
      const goneIds = new Set(gone.map(r => r.o.uuid));
      for (const r of gone) if (!goneIds.has(r.parent)) removes.push(r.idx);
      // Materials: their state, or (their textures changed) all of them again.
      for (const m of usedMats) {
        const ps = JSON.stringify(matProps(m)), maps = MAPS.map(k => m[k] && m[k].isTexture ? m[k].uuid : "").join(), rec = this.mats.get(m.uuid);
        for (const k of MAPS) if (m[k] && m[k].isTexture) usedTexs.add(m[k]);
        if (!rec) { this.mats.set(m.uuid, { props: ps, maps }); continue; }
        if (maps !== rec.maps) { Object.assign(rec, { props: ps, maps }); res.set(m.uuid, ["material", m]); }
        else if (ps !== rec.props) { rec.props = ps; props.push(Object.assign({ uuid: m.uuid }, JSON.parse(ps))); }
      }
      // Geometries and textures changed in place (their versions moved on): again, at most every 250 and 500 ms.
      const again = (map, x, ver, every, kind) => {
        const rec = map.get(x.uuid);
        if (!rec) return map.set(x.uuid, { ver, at: now });
        if (rec.ver !== ver && now - rec.at >= every) { Object.assign(rec, { ver, at: now }); res.set(x.uuid, [kind, x]); }
      };
      for (const g of usedGeos) again(this.geos, g, Object.values(g.attributes || {}).map(a => a.version).join() + "|" + (g.index ? g.index.version : ""), 250, "geometry");
      if (root.background && root.background.isTexture) usedTexs.add(root.background);
      for (const t of usedTexs) again(this.texs, t, t.version, 500, "texture");
      // What the scene no longer uses, a visitor's page lets go of (_sceneGc): it counts as unsent again, and
      // goes with whatever uses it next.
      const used = new Set([...usedMats, ...usedGeos, ...usedTexs].map(x => x.uuid));
      for (const uuid of this.sent) if (!used.has(uuid)) this.sent.delete(uuid);
      for (const r of assigns) {
        for (const m of list(r.o.material)) if (!this.sent.has(m.uuid)) res.set(m.uuid, ["material", m]);
        if (r.o.geometry && !this.sent.has(r.o.geometry.uuid)) res.set(r.o.geometry.uuid, ["geometry", r.o.geometry]);
      }
      // The scene's own: its background and fog.
      let scene = null;
      if (root.isScene) {
        const bg = root.background, f = root.fog;
        const now2 = { background: bg && bg.isColor ? bg.getHex() : bg && bg.isTexture ? { texture: bg.uuid } : null,
          fog: f ? { type: f.isFogExp2 ? "FogExp2" : "Fog", color: f.color.getHex(), near: f.near, far: f.far, density: f.density } : null };
        const sig = JSON.stringify(now2);
        if (this.sceneSig !== null && sig !== this.sceneSig) {
          scene = now2;
          if (bg && bg.isTexture && !this.sent.has(bg.uuid)) res.set(bg.uuid, ["texture", bg]);
        }
        this.sceneSig = sig;
      }
      if (first) return { edit: null, moved: [] };
      const edit = { type: "edit" };
      if (res.size) edit.res = this._resources([...res.values()]);
      if (removes.length) edit.remove = removes;
      if (adds.length) edit.add = adds.map(r => this._added(r));
      if (parents.length) edit.parent = parents;
      if (assigns.length) edit.assign = assigns.map(r => [r.idx, Array.isArray(r.o.material) ? r.o.material.map(m => m.uuid) : r.o.material ? r.o.material.uuid : null, r.o.geometry ? r.o.geometry.uuid : null]);
      if (props.length) edit.props = props;
      if (scene) edit.scene = scene;
      return { edit: Object.keys(edit).length > 1 ? edit : null, moved };
    }

    // An added object: its JSON (with what it is made of, but the geometries and materials its visitors have: those
    // it names by uuid), each object's number, its lights' targets.
    _added(r) {
      const json = r.o.toJSON(), ids = [];
      for (const k of ["geometries", "materials"]) if (json[k]) json[k] = json[k].filter(x => !this.sent.has(x.uuid));
      // A texture goes with each material (or object) that names it, an image with each texture, a shape with each
      // geometry.
      const named = new Set(), stack = [json.object, ...(json.materials || [])];
      while (stack.length) {
        const x = stack.pop();
        if (!isObj(x)) continue;
        for (const v of Object.values(x)) if (typeof v === "string") named.add(v);
        if (Array.isArray(x.children)) stack.push(...x.children);
      }
      if (json.textures) json.textures = json.textures.filter(x => named.has(x.uuid));
      const images = new Set((json.textures || []).map(t => t.image)), shapes = new Set((json.geometries || []).flatMap(g => list(g.shapes)));
      if (json.images) json.images = json.images.filter(x => images.has(x.uuid));
      if (json.shapes) json.shapes = json.shapes.filter(x => shapes.has(x.uuid));
      r.o.traverse(o => { const x = this.objs.get(o.uuid); if (x) ids.push([o.uuid, x.idx]); });
      for (const k of ["geometries", "materials", "textures", "images"]) for (const x of json[k] || []) this.sent.add(x.uuid);
      const parent = this.objs.get(r.parent);
      return { parent: parent ? parent.idx : 0, json, ids, targets: this.targets(r.o) };
    }

    // Geometries, materials and textures to send again (or for the first time), as three.js's toJSON makes them.
    _resources(items) {
      const meta = { geometries: {}, materials: {}, textures: {}, images: {}, shapes: {}, skeletons: {}, animations: {}, nodes: {} };
      for (const [kind, x] of items) {
        if (kind === "geometry") {
          meta.geometries[x.uuid] = x.toJSON();
          for (const sh of list(x.parameters && x.parameters.shapes)) meta.shapes[sh.uuid] = sh.toJSON();
        } else if (kind === "material") meta.materials[x.uuid] = x.toJSON(meta);
        else meta.textures[x.uuid] = x.toJSON(meta);
      }
      const out = {};
      for (const k of ["geometries", "materials", "textures", "images", "shapes"]) {
        out[k] = Object.values(meta[k]).map(x => { delete x.metadata; return x; });
        for (const x of out[k]) this.sent.add(x.uuid);
      }
      return out;
    }

    // Lights' targets (three.js's own JSON leaves them out before r160): [light, target] numbers, or [light,
    // null, the target's place] for a target that is not in the scene.
    targets(top) {
      const out = [];
      top.traverse(o => {
        if (!(o.isDirectionalLight || o.isSpotLight) || !o.target) return;
        const l = this.objs.get(o.uuid), t = this.objs.get(o.target.uuid);
        if (l) out.push(t ? [l.idx, t.idx] : [l.idx, null, o.target.position.toArray()]);
      });
      return out;
    }

    // Everything that has moved since the scene was first sent: a key delta's objects.
    dynamicRecs() { return [...this.dynamic].filter(r => this.objs.get(r.o.uuid) === r); }

    // Objects' places, as a delta lists them (SPEC 8.3): number (u32), flags (u8: 1 visible, 2 scaled), position
    // and quaternion (f32), and the scale (f32) when it is not 1.
    entries(recs) {
      recs = recs.slice(0, 20000);
      const buf = new ArrayBuffer(recs.length * 45), dv = new DataView(buf), { p, q, s } = this.tmp;
      let at = 0;
      for (const r of recs) {
        r.o.matrix.decompose(p, q, s);
        const scaled = Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-6;
        dv.setUint32(at, r.idx); dv.setUint8(at + 4, (r.o.visible ? 1 : 0) | (scaled ? 2 : 0)); at += 5;
        for (const x of [p.x, p.y, p.z, q.x, q.y, q.z, q.w]) { dv.setFloat32(at, x); at += 4; }
        if (scaled) for (const x of [s.x, s.y, s.z]) { dv.setFloat32(at, x); at += 4; }
      }
      return { n: recs.length, bytes: new Uint8Array(buf, 0, at) };
    }

    // The whole scene, for a visitor starting (or starting again): three.js's own JSON of it, each object's
    // number, and what the visitor needs to draw it as the host does and to walk in it.
    snapshot(h, hooks) {
      const { root, three, renderer } = this.cfg, w = hooks.walk;
      root.updateMatrixWorld();
      const json = root.toJSON();
      this.sent = new Set(["geometries", "materials", "textures", "images"].flatMap(k => (json[k] || []).map(x => x.uuid)));
      return { type: "scene", three: String(three.REVISION), json, ids: [...this.objs.values()].map(r => [r.o.uuid, r.idx]), targets: this.targets(root),
        renderer: rendererProps(renderer, three), fov: Number(hooks.fov) || 70, near: Number(this.cfg.near) || 0.1, far: Number(this.cfg.far) || 1000,
        walk: w && Number(w.speed) > 0 ? { speed: Number(w.speed) } : null, yaw0: h.yaw0, pose: h.pose };
    }
  }

  class Client {
    constructor(port, token, sim, { threeBase = null } = {}) {
      Object.assign(this, { port, token, sim, _threeBase: threeBase });
      this.state = "connecting";   // then "online", "offline" (the lobby out of reach), or "away" (left on purpose)
      this.office = null;
      this.status = "available";
      this.maxVisitors = 3;
      this._samples = { latency: [], drawn: [] };   // the last few thousand of each, for a test's percentiles
      this.offices = [];
      this.knocks = [];        // on your door: { id, from, message, until }
      this.knocking = [];      // yours, waiting: { id, to }
      this.visiting = null;    // { id, host, paused }
      this.visitors = [];      // { id, visitor, pose }
      this._on = {};
      this._hosted = new Map();   // channel -> a visit to this office
      this._hooks = null;         // until visit.host(): this office is not in the lobby to be visited, nor knocks
      // A visitor's numbers, about once a second (the "stats" event): input to screen (drawn here) and the
      // link's round trip in ms, the link's path ("direct" or "relay"), frames drawn a second. null while not
      // visiting.
      this.stats = { latency: null, rtt: null, path: null, fps: 0 };
      this._sync = null;          // what this room last sent of its scene (SceneSync), while it has visitors
      this._viewer = null;        // the visit this office is on: { channel, scene, sceneQ, count }
      this._view = null;          // where it is shown: { element, canvas, ... }
      this._closed = false;
      this._fails = 0;
      this._loop = ticker(MOVE_MS, () => this._tick());
    }

    // ---------- events ----------
    on(event, fn) { (this._on[event] = this._on[event] || []).push(fn); return this; }
    off(event, fn) { this._on[event] = (this._on[event] || []).filter(f => f !== fn); return this; }
    _emit(event, arg) { for (const fn of this._on[event] || []) { try { fn(arg); } catch (e) { console.error("visit: a", event, "handler threw", e); } } }
    _changed() { this._emit("change", this); }

    // ---------- the connection ----------
    // `token` is the token, or a function giving it (fresh each time: a visit-client restarted with a new
    // one is then found again by itself).
    async _open() {
      const token = typeof this.token === "function" ? await this.token() : this.token;
      return new Promise((resolve, reject) => {
        const ws = this._ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
        ws.binaryType = "arraybuffer";
        let ready = false;
        ws.onopen = () => ws.send(JSON.stringify({ type: "hello", proto: PROTO, token, sim: this.sim }));
        ws.onmessage = e => {
          if (typeof e.data !== "string") return this._frame(e.data);
          let m;
          try { m = JSON.parse(e.data); } catch (err) { return; }
          if (m.type === "ready" && !ready) { ready = true; this._fails = 0; this._ready(m); resolve(); return; }
          this._message(m);
          if (!QUIET.has(m.type)) this._changed();
        };
        ws.onclose = e => {
          if (ws !== this._ws) return;
          this._dropAll();
          if (!ready) {
            const err = new Error(e.code === 4401 ? "visit-client refused the token" : `visit-client is not running on 127.0.0.1:${this.port}, or refused this page`);
            err.code = e.code;
            return reject(err);
          }
          this.state = "offline";
          this._changed();
          if (this._closed || e.code === 4409) {
            return this._emit("error", { code: "closed", message: e.code === 4409 ? "visit-client: another page of this workroom took over" : "visit-client: closed" });
          }
          setTimeout(() => this._reopen(), 2000);   // visit-client restarting: try again
        };
      });
    }
    // Again every 2 s while visit-client is away. A wrong token is final unless `token` is a function (then
    // a few more tries, each with what it gives): a stale token tried forever only keeps failing.
    _reopen() {
      if (this._closed) return;
      this._open().catch(e => {
        if (e.code === 4401 && (typeof this.token !== "function" || ++this._fails >= 3)) {
          return this._emit("error", { code: "token", message: "visit-client refused the token: reload the page" });
        }
        setTimeout(() => this._reopen(), 2000);
      });
    }
    _send(m) { if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(m)); }
    close() { this._closed = true; this._loop.stop(); this._dropAll(); if (this._ws) this._ws.close(); }

    _ready(m) {
      this.state = m.away ? "away" : m.online ? "online" : "offline";
      this.office = m.office && m.office.id ? m.office : null;
      this.status = m.status; this.maxVisitors = m.max_visitors;
      this.knocks = []; this.knocking = [];
      for (const v of m.visits || []) this._started(v);
      if (this._hooks) this._sendHost();   // a visit-client that came back: this page hosts, again
      this._changed();
    }

    _message(m) {
      switch (m.type) {
        case "online":   // (again, after a drop): its own knocks still waiting are these
          this.state = "online"; this.office = m.office;
          if (Array.isArray(m.knocking)) this.knocking = m.knocking.map(k => ({ id: k.id, to: k.to }));
          break;
        case "offline":   // away: this office left the lobby on purpose, and sees nobody until it joins again
          this.state = m.away ? "away" : "offline";
          if (m.away) { this.offices = []; this.knocks = []; this.knocking = []; }
          break;
        case "lobby":
          this.offices = (m.offices || []).map(o => ({ id: String(o.id), name: String(o.name), status: String(o.status), sim: o.sim || {},
            maxVisitors: Number(o.max_visitors) || 0, visitors: Number(o.visitors) || 0, visiting: o.visiting || null, ready: o.ready === true }));
          { const me = this.offices.find(o => this.office && o.id === this.office.id); if (me) { this.status = me.status; this.maxVisitors = me.maxVisitors; } }
          break;
        case "knock":
          this.knocks = this.knocks.filter(k => k.id !== m.id).concat([{ id: m.id, from: m.from, message: m.message || "", until: Date.now() + 1000 * (m.expires_in || 60) }]);
          this._emit("knock", this.knocks[this.knocks.length - 1]);
          break;
        case "knock_cancelled": this.knocks = this.knocks.filter(k => k.id !== m.id); break;
        case "knock_sent": this.knocking = this.knocking.concat([{ id: m.id, to: m.to }]); break;
        case "answered": {
          const k = this.knocking.find(x => x.id === m.knock);
          this.knocking = this.knocking.filter(x => x.id !== m.knock);
          this._emit("answered", { to: k && k.to, accept: m.accept, reason: m.reason, message: m.message || "" });
          break;
        }
        case "visit_started": this._started(m); break;
        case "visit_ended": this._ended(m); break;
        case "host_paused": case "host_resumed":
          if (this.visiting && this._viewer && this._viewer.channel === m.channel) this.visiting.paused = m.type === "host_paused";
          break;
        case "link_stats":
          if (this._viewer && this._viewer.channel === m.channel) { this.stats.rtt = Number(m.rtt_ms); this.stats.path = String(m.path); }
          break;
        case "keyframe": case "input": case "scene_resync": this._hostMessage(m); break;
        case "scene": this._sceneEdit(m); break;
        case "scene_lost": if (this._viewer && this._viewer.channel === m.channel) this._sceneResync(this._viewer); break;
        case "error": this._emit("error", { code: m.code, message: m.message, ref: m.ref }); break;
      }
    }

    // ---------- actions ----------
    setStatus(status) { this._send({ type: "status", status }); }
    setMaxVisitors(n) { this._send({ type: "max_visitors", n }); }
    rename(name) { this._send({ type: "rename", name }); }
    knock(officeId, message = "") { this._send({ type: "knock", to: officeId, message }); }
    answer(knockId, accept, message = "") { this.knocks = this.knocks.filter(k => k.id !== knockId); this._send({ type: "answer", knock: knockId, accept, message }); this._changed(); }
    leave() { if (this.visiting) this._send({ type: "end", visit: this.visiting.id }); }
    // Out of the lobby (nobody sees this office or can knock; its visits end) and back. visit-client keeps
    // it out across its restarts when it has a state file (VISIT_STATE_FILE).
    leaveLobby() { this._send({ type: "leave_lobby" }); }
    joinLobby() { this._send({ type: "join_lobby" }); }
    kick(visitId) { this._send({ type: "end", visit: visitId }); }

    // ---------- visits ----------
    _started(m) {
      if (m.role === "host") {
        const h = { id: m.id, channel: m.channel, visitor: m.peer || {}, pose: null, yaw0: 0, input: null, inputAt: 0,
          keyNext: true, fails: 0, sceneSent: false, posed: null };
        if (m.state && m.state.pose) { h.pose = m.state.pose; h.yaw0 = m.state.yaw0 || 0; }   // back after this page reloaded
        this._hosted.set(m.channel, h);
        this._spawn(h);
      } else {
        this.visiting = { id: m.id, host: m.peer || {}, paused: false };
        this._viewer = { channel: m.channel, count: 0, scene: null, sceneQ: null, since: performance.now(), loading: false, failed: false };
        this._placeholder();
      }
      this._visitorsList();
      this._emit("visit_started", { id: m.id, role: m.role, peer: m.peer });
    }

    _ended(m) {
      const h = this._hosted.get(m.channel);
      if (h && h.id === m.id) this._hosted.delete(m.channel);
      if (this.visiting && this.visiting.id === m.id) { this._dropViewer(); this.visiting = null; }
      this._visitorsList();
      this._emit("visit_ended", { id: m.id, reason: m.reason });
    }

    _dropAll() {
      this._hosted.clear();
      this._dropViewer();
      this.visiting = null;
      this._visitorsList();
    }

    _visitorsList() { this.visitors = [...this._hosted.values()].map(h => ({ id: h.id, visitor: h.visitor, pose: h.pose })); }

    // ---------- hosting ----------
    // `scene`: { root, three, renderer, near, far }, the room's three.js scene (or the part of it to share), the
    // THREE namespace it was made with, its renderer and its visitors' camera range. `fov`: that camera's vertical
    // field of view, in degrees. `walk` (optional): { speed }, when `move` walks with Visit.walk at that speed:
    // the visitor's page then walks at once, before the host's answer. Until this is called, this office is not
    // in the lobby to be visited, and cannot knock: every room takes part with its scene.
    host(hooks) {
      if (!hooks || typeof hooks.spawn !== "function" || typeof hooks.move !== "function") throw new Error("visit.host needs spawn and move functions");
      const sc = hooks.scene;
      if (!sc || !(sc.root && sc.root.isObject3D && sc.three && sc.three.REVISION)) {
        throw new Error("visit.host needs scene: { root, three }: the room's three.js scene, and the THREE it was made with");
      }
      const revs = Object.keys(THREE_FILES);
      if (!THREE_FILES[String(sc.three.REVISION)]) throw new Error(`visit.host: three.js r${sc.three.REVISION} is not one this visit.js knows (r${revs[0]} to r${revs[revs.length - 1]})`);
      this._hooks = hooks;
      this._sync = null;
      for (const h of this._hosted.values()) { this._spawn(h); h.sceneSent = false; }
      this._sendHost();
    }
    _sendHost() { this._send({ type: "host", three: String(this._hooks.scene.three.REVISION) }); }

    _spawn(h) {
      if (!this._hooks || h.pose) return;
      try { h.pose = Object.assign({}, this._hooks.spawn(h.visitor)); h.yaw0 = h.pose.yaw || 0; }
      catch (e) { console.error("visit: spawn threw", e); }
    }

    _hostMessage(m) {
      const h = this._hosted.get(m.channel);
      if (!h) return;
      if (m.type === "input") { h.input = m; h.inputAt = performance.now(); this._step(h, h.inputAt); }   // at once: the next delta has it
      else if (m.type === "keyframe") h.keyNext = true;   // a key delta: where everything that moves is
      else if (m.type === "scene_resync") h.sceneSent = false;
    }

    // Every SCENE_MS, for this room's visitors: what changed in its scene (one edit for them all), where its
    // moving things and each visitor are (a delta each), and the whole scene to any visitor starting.
    _sceneTick(now) {
      const hs = [...this._hosted.values()].filter(h => h.pose);
      if (!hs.length || !this._hooks) { this._sync = null; return; }
      try {
        if (!this._sync || this._sync.cfg !== this._hooks.scene) {   // a new scene, or numbered anew: everyone gets it whole
          this._sync = new SceneSync(this._hooks.scene);
          for (const h of hs) h.sceneSent = false;
        }
        const sync = this._sync, { edit, moved } = sync.scan(now), ready = hs.filter(h => h.sceneSent);
        if (edit && ready.length) this._sendScene(ready, edit);
        const key = now - sync.keyAt >= SCENE_KEY_MS;
        if (key) sync.keyAt = now;
        const body = sync.entries(moved), all = key || ready.some(h => h.keyNext) ? sync.entries(sync.dynamicRecs()) : null;
        for (const h of ready) {
          const k = key || h.keyNext, p = h.pose, posed = [p.x, p.y, p.z, p.yaw, p.pitch, h.input && h.input.t].join();
          if (k || body.n || posed !== h.posed) { this._sendDelta(h, k ? all : body, k, now); h.posed = posed; h.keyNext = false; }
        }
        for (const h of hs) if (!h.sceneSent) { this._sendScene([h], sync.snapshot(h, this._hooks)); h.sceneSent = true; h.keyNext = true; }
      } catch (e) { console.error("visit: could not send the scene", e); }
    }

    // A scene edit to these visitors, gzipped, after any before it (SPEC 5.4: flags EDIT).
    _sendScene(hs, edit) {
      let text;
      try { text = JSON.stringify(edit); } catch (e) { return console.warn("visit: a scene edit that does not turn into JSON", e); }
      const channels = hs.map(h => h.channel);
      this._sceneOut = (this._sceneOut || Promise.resolve()).then(async () => {
        const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        if (gz.byteLength > 16 << 20) return console.warn(`visit: a scene edit too big to send (${gz.byteLength} bytes gzipped)`);
        for (const ch of channels) {
          if (!this._ws || this._ws.readyState !== 1) return;
          const buf = new Uint8Array(11 + gz.byteLength);
          new DataView(buf.buffer).setUint16(0, ch);
          buf[2] = EDIT;
          buf.set(gz, 11);
          this._ws.send(buf);
        }
      }).catch(e => console.warn("visit: could not send a scene edit", e));
    }

    // A delta (SPEC 8.3): where the host has this visitor (and the input it got that far with), then objects'
    // places; a key delta has everything that ever moved.
    _sendDelta(h, body, key, now) {
      if (!this._ws || this._ws.readyState !== 1) return;
      const buf = new Uint8Array(11 + 37 + body.bytes.byteLength), dv = new DataView(buf.buffer), p = h.pose;
      dv.setUint16(0, h.channel); dv.setUint8(2, key ? KEY : 0); dv.setBigUint64(3, BigInt(Math.round(now * 1000)));
      dv.setUint8(11, 1);
      dv.setFloat64(12, h.input ? Number(h.input.t) || 0 : 0);
      dv.setFloat32(20, h.input ? now - h.inputAt : 0);
      [p.x, p.y, p.z, p.yaw, p.pitch].forEach((x, i) => dv.setFloat32(24 + 4 * i, Number(x) || 0));
      dv.setUint32(44, body.n);
      buf.set(body.bytes, 48);
      this._ws.send(buf);
    }

    // Edits apply one after another, in order (the first, the whole scene, waits for three.js to load).
    _sceneEdit(m) {
      const w = this._viewer;
      if (!w || w.channel !== m.channel || !isObj(m.edit)) return;
      const whole = m.edit.type === "scene";
      if (whole) w.loading = true;
      w.sceneQ = (w.sceneQ || Promise.resolve()).then(() => this._viewer !== w ? null : whole ? this._sceneStart(w, m.edit) : this._sceneApply(w, m.edit))
        .finally(() => { if (whole) w.loading = false; })
        .catch(e => {
          if (this._viewer !== w) return;
          if (whole) {   // this page cannot draw it (three.js would not load, say): it says so where the room would be
            console.warn("visit: cannot draw this room's scene", e);
            w.failed = true;
            this._sceneDrop(w);
            this._placeholder(`cannot draw ${(this.visiting && this.visiting.host.name) || "this"}'s room: ${e.message || e}`);
            this._emit("error", { code: "scene", message: String(e.message || e) });
          } else { console.warn("visit: a scene edit that did not apply; asking for the whole scene again", e); this._sceneResync(w); }
        });
    }

    // At most every 2 s (as visit-client passes them on): one asked for sooner goes when it may.
    _sceneResync(w) {
      const wait = 2000 - (performance.now() - (w.resyncAt || -1e9));
      if (wait > 0) {
        if (!w.resyncTimer) w.resyncTimer = setTimeout(() => { w.resyncTimer = 0; if (this._viewer === w) this._sceneResync(w); }, wait);
        return;
      }
      w.resyncAt = performance.now();
      this._send({ type: "scene_resync", channel: w.channel });
    }

    async _sceneStart(w, e) {
      const T = await loadThree(e.three, this._threeBase);
      if (this._viewer !== w) return;
      this._sceneDrop(w);
      const budget = { vertices: 0, objects: 0 }, loader = new T.ObjectLoader();
      let root = loader.parse(cleanScene(e.json, budget));
      if (!root.isScene) { const sc = new T.Scene(); sc.add(root); root = sc; }
      const pose = isObj(e.pose) ? e.pose : {}, num = (x, d) => Number.isFinite(Number(x)) ? Number(x) : d;
      const s = { T, loader, budget, root, byIdx: new Map(), idxOf: new Map(), geos: new Map(), mats: new Map(), texs: new Map(), samples: new Map(),
        offs: [], offset: null, pose: { x: num(pose.x, 0), y: num(pose.y, 1.6), z: num(pose.z, 0) }, yaw0: num(e.yaw0, 0),
        walk: isObj(e.walk) && num(e.walk.speed, 0) > 0 ? { speed: Math.min(50, num(e.walk.speed, 2.5)) } : null,
        hist: [], vis: { x: 0, y: 0, z: 0 }, waitKey: true, own: [], last: 0, gcAt: performance.now(), q: new T.Quaternion(), v: new T.Vector3() };
      this._sceneAdopt(s, root);
      const byUuid = new Map();
      root.traverse(o => byUuid.set(o.uuid, o));
      for (const [uuid, idx] of Array.isArray(e.ids) ? e.ids : []) { const o = byUuid.get(uuid); if (o) { s.byIdx.set(idx, o); s.idxOf.set(o, idx); } }
      s.byIdx.set(0, root);
      this._sceneTargets(s, e.targets);
      // Drawn as the host draws it: its renderer's settings, its camera's field of view and range.
      s.canvas = document.createElement("canvas");
      s.renderer = new T.WebGLRenderer({ canvas: s.canvas, antialias: true });
      const r = isObj(e.renderer) ? e.renderer : {};
      if (isObj(r.shadowMap)) { s.renderer.shadowMap.enabled = !!r.shadowMap.enabled; if (typeof r.shadowMap.type === "number") s.renderer.shadowMap.type = r.shadowMap.type; }
      for (const k of ["toneMapping", "toneMappingExposure", "sortObjects", "outputEncoding", "outputColorSpace", "physicallyCorrectLights", "useLegacyLights"]) {
        if (k in r && k in s.renderer && typeof r[k] === typeof s.renderer[k]) s.renderer[k] = r[k];
      }
      if (Array.isArray(r.clear)) s.renderer.setClearColor(num(r.clear[0], 0), num(r.clear[1], 1));
      if (typeof r.colorManagement === "boolean" && T.ColorManagement && "enabled" in T.ColorManagement) T.ColorManagement.enabled = r.colorManagement;
      s.camera = new T.PerspectiveCamera(Math.min(150, Math.max(10, num(e.fov, 70))), 1, Math.max(0.001, num(e.near, 0.1)), Math.max(1, num(e.far, 1000)));
      s.camera.rotation.order = "YXZ";
      w.scene = s;
      this._sceneOwn(s);
      this._sceneAttach(w);
      this._send({ type: "keyframe", channel: w.channel });   // where its moving things are now
      const loop = () => {
        if (w.scene !== s) return;
        s.raf = requestAnimationFrame(loop);
        try { this._sceneFrame(w); } catch (x) { console.error("visit: drawing the scene", x); }
      };
      s.raf = requestAnimationFrame(loop);
    }

    // Each geometry, material and texture kept once, by its uuid: one the scene has already stays (the new copy
    // goes), so an added object made of what is already here shares it.
    _sceneAdopt(s, top) {
      const maps = m => {
        for (const k of MAPS) {
          const t = m[k];
          if (!t || !t.isTexture) continue;
          const have = s.texs.get(t.uuid);
          if (have && have !== t) { t.dispose(); m[k] = have; } else s.texs.set(t.uuid, t);
        }
      };
      top.traverse(o => {
        if (o.geometry && o.geometry.uuid) {
          const have = s.geos.get(o.geometry.uuid);
          if (have && have !== o.geometry) { o.geometry.dispose(); o.geometry = have; } else s.geos.set(o.geometry.uuid, o.geometry);
        }
        if (o.material) {
          const ms = list(o.material).map(m => {
            const have = s.mats.get(m.uuid);
            if (have && have !== m) { m.dispose(); return have; }
            s.mats.set(m.uuid, m); maps(m); return m;
          });
          o.material = Array.isArray(o.material) ? ms : ms[0];
        }
        if (o.isScene && o.background && o.background.isTexture) s.texs.set(o.background.uuid, o.background);
      });
    }

    _sceneTargets(s, targets) {
      for (const t of Array.isArray(targets) ? targets : []) {
        const light = s.byIdx.get(t[0]);
        if (!light || !(light.isDirectionalLight || light.isSpotLight)) continue;
        const to = t[1] != null && s.byIdx.get(t[1]);
        if (to) light.target = to;
        else if (Array.isArray(t[2]) && t[2].length === 3 && t[2].every(Number.isFinite)) { light.target.position.fromArray(t[2]); light.target.updateMatrixWorld(); }
      }
    }

    // The visitor's own body, which the host draws in its room for everyone else: not drawn in its own eyes
    // (the host marks it with userData.visitor = the visit's id).
    _sceneOwn(s) {
      const id = this.visiting && this.visiting.id;
      s.own = [];
      s.root.traverse(o => { if (id && o.userData && o.userData.visitor === id) s.own.push(o); });
    }

    _sceneAttach(w) {
      const v = this._view, s = w.scene;
      if (v && s && v.gl !== s.canvas) v.attach(s.canvas);
    }

    _sceneApply(w, e) {
      const s = w.scene;
      if (!s) return this._sceneResync(w);   // an edit with no scene to apply it to: start again
      if (isObj(e.res)) this._sceneResources(s, e.res);
      for (const idx of Array.isArray(e.remove) ? e.remove : []) {
        const o = idx ? s.byIdx.get(idx) : null;
        if (!o) continue;
        if (o.parent) o.parent.remove(o);
        o.traverse(c => { const i = s.idxOf.get(c); if (i !== undefined) { s.byIdx.delete(i); s.idxOf.delete(c); s.samples.delete(i); } });
      }
      for (const a of Array.isArray(e.add) ? e.add : []) {
        if (!isObj(a)) continue;
        try {
          const budget = Object.assign({}, s.budget), o = this._sceneParse(s, cleanScene(a.json, s.budget));
          if (!o) {   // what it would have counted is not in the scene
            Object.assign(s.budget, budget);
            console.warn("visit: an object added to the scene made of what this page does not have: the whole scene again");
            this._sceneResync(w);
            continue;
          }
          this._sceneAdopt(s, o);
          const byUuid = new Map();
          o.traverse(c => byUuid.set(c.uuid, c));
          for (const [uuid, idx] of Array.isArray(a.ids) ? a.ids : []) { const c = byUuid.get(uuid); if (c && idx) { s.byIdx.set(idx, c); s.idxOf.set(c, idx); } }
          (s.byIdx.get(a.parent) || s.root).add(o);
          this._sceneTargets(s, a.targets);
        } catch (x) { console.warn("visit: an object added to the scene that could not be read", x); }
      }
      for (const [idx, p] of Array.isArray(e.parent) ? e.parent : []) {
        const o = s.byIdx.get(idx), to = s.byIdx.get(p) || s.root;
        if (o && idx && o !== to && !o.getObjectById(to.id)) to.add(o);
      }
      for (const [idx, mats, geo] of Array.isArray(e.assign) ? e.assign : []) {
        const o = s.byIdx.get(idx);
        if (!o) continue;
        if (mats != null && "material" in o) {
          const ms = list(mats).map(u => s.mats.get(u)).filter(Boolean);
          if (ms.length) o.material = Array.isArray(mats) ? ms : ms[0];
        }
        if (geo != null && "geometry" in o && s.geos.get(geo)) o.geometry = s.geos.get(geo);
      }
      for (const p of Array.isArray(e.props) ? e.props : []) { const m = isObj(p) && s.mats.get(p.uuid); if (m) setProps(m, p); }
      if (isObj(e.scene)) {
        const { background: bg, fog } = e.scene, T = s.T;
        if (typeof bg === "number") s.root.background = new T.Color(bg);
        else if (isObj(bg)) s.root.background = s.texs.get(bg.texture) || null;
        else if (bg === null) s.root.background = null;
        if (fog === null) s.root.fog = null;
        else if (isObj(fog) && Number.isFinite(fog.color)) s.root.fog = fog.type === "FogExp2" ? new T.FogExp2(fog.color, Number(fog.density) || 0.00025) : new T.Fog(fog.color, Number(fog.near) || 1, Number(fog.far) || 1000);
      }
      this._sceneOwn(s);
    }

    // An added object, read with the geometries and materials this scene already has: the host sends each once,
    // and an added object names the ones sent before only by uuid. Null when it names one this page does not have
    // (an edit or a whole scene that never arrived, or an add that could not be read).
    _sceneParse(s, json) {
      const has = (k, map) => { const here = new Set((json[k] || []).map(x => x.uuid)); return u => here.has(u) || map.has(u); };
      const geo = has("geometries", s.geos), mat = has("materials", s.mats), stack = [json.object];
      while (stack.length) {
        const o = stack.pop();
        if (!isObj(o)) continue;
        if (o.geometry !== undefined && !geo(o.geometry)) return null;
        for (const u of list(o.material)) if (!mat(u)) return null;
        if (Array.isArray(o.children)) stack.push(...o.children);
      }
      const L = s.loader, P = Object.getPrototypeOf(L), had = { parseGeometries: s.geos, parseMaterials: s.mats };
      for (const [k, map] of Object.entries(had)) L[k] = (...a) => Object.assign(Object.fromEntries(map), P[k].apply(L, a));
      try { return L.parse(json); } finally { for (const k of Object.keys(had)) delete L[k]; }
    }

    // Geometries, materials and textures sent again (changed in place) or new: one the scene has takes the new
    // one's content, where it is used; a new one is kept for what refers to it.
    _sceneResources(s, res) {
      const L = s.loader, json = cleanScene(Object.assign({}, res), s.budget);
      const geos = L.parseGeometries(json.geometries, L.parseShapes(Array.isArray(res.shapes) ? res.shapes : []));
      const texs = L.parseTextures(Array.isArray(res.textures) ? res.textures : [], L.parseImages(json.images));
      const mats = L.parseMaterials(json.materials, Object.assign(Object.fromEntries(s.texs), texs));
      for (const [uuid, g] of Object.entries(geos)) {
        const have = s.geos.get(uuid);
        if (have) { have.dispose(); have.copy(g); g.dispose(); } else s.geos.set(uuid, g);
      }
      for (const [uuid, t] of Object.entries(texs)) {
        const have = s.texs.get(uuid);
        if (have) { have.copy(t); have.needsUpdate = true; } else s.texs.set(uuid, t);
      }
      for (const [uuid, m] of Object.entries(mats)) {
        const have = s.mats.get(uuid);
        for (const k of MAPS) if (m[k] && m[k].isTexture && s.texs.get(m[k].uuid)) m[k] = s.texs.get(m[k].uuid);
        if (have && have.type === m.type) { have.copy(m); have.needsUpdate = true; m.dispose(); continue; }
        if (have) s.root.traverse(o => { if (o.material === have) o.material = m; else if (Array.isArray(o.material)) o.material = o.material.map(x => x === have ? m : x); });
        s.mats.set(uuid, m);
      }
    }

    // A delta: where the host has this visitor, and its moving things' places, each kept with the host's time
    // to be shown INTERP_MS later, between two of them.
    _sceneDelta(w, dv, key) {
      const s = w.scene;
      if (!s || dv.byteLength < 48 || dv.getUint8(11) !== 1) return;
      if (s.waitKey && !key) return;
      if (key) s.waitKey = false;
      const ts = Number(dv.getBigUint64(3)) / 1000, now = performance.now();
      // The host's clock against this page's: the least (arrival - sent) of the last 2 s (a one-way trip's
      // floor: no update is shown before it could have come).
      s.offs.push([now, now - ts]);
      while (s.offs.length > 1 && now - s.offs[0][0] > 2000) s.offs.shift();
      s.offset = s.offs.reduce((a, x) => Math.min(a, x[1]), Infinity);
      this._sceneReconcile(s, dv.getFloat64(12), dv.getFloat32(20), dv.getFloat32(24), dv.getFloat32(28), dv.getFloat32(32), now);
      const n = dv.getUint32(44);
      let at = 48;
      for (let i = 0; i < n && at + 33 <= dv.byteLength; i++) {
        const idx = dv.getUint32(at), fl = dv.getUint8(at + 4), f = k => dv.getFloat32(at + 5 + 4 * k);
        const p = [f(0), f(1), f(2)], q = [f(3), f(4), f(5), f(6)];
        at += 33;
        let sc = null;
        if (fl & 2) { if (at + 12 > dv.byteLength) break; sc = [dv.getFloat32(at), dv.getFloat32(at + 4), dv.getFloat32(at + 8)]; at += 12; }
        const o = s.byIdx.get(idx);
        if (!o || !idx || ![...p, ...q, ...(sc || [])].every(x => Number.isFinite(x) && Math.abs(x) < 1e7)) continue;
        let l = s.samples.get(idx);
        if (!l) s.samples.set(idx, l = []);
        const last = l[l.length - 1];
        if (last && ts <= last.ts) continue;   // older than what it has
        // At rest until now: where it was, just before this, so it moves from there rather than glides from long ago.
        if (!last || ts - last.ts > 2.5 * SCENE_MS) l.push({ ts: ts - SCENE_MS, p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray(), vis: o.visible });
        l.push({ ts, p, q, s: sc, vis: !!(fl & 1) });
        if (l.length > 8) l.splice(0, l.length - 8);
      }
    }

    // Where the host has this visitor, for the input of time `t` (this page's clock) it had got `age` ms into:
    // against where this page had predicted it would be by then, the difference is put right at once in where
    // it stands, and eased away (in 100 ms or so) in what it sees. A host that does not say how its visitors
    // walk gets followed, eased the same way.
    _sceneReconcile(s, t, age, x, y, z, now) {
      if (![x, y, z].every(Number.isFinite)) return;
      s.vis.y -= y - s.pose.y; s.pose.y = y;
      let px = s.pose.x, pz = s.pose.z, when = null;
      if (s.walk && t > 0 && s.hist.length) {
        when = Math.min(now, t + Math.max(0, age));
        const h = s.hist;
        let i = h.length - 1;
        while (i > 0 && h[i][0] > when) i--;
        const a = h[i], b = h[i + 1];
        const k = b && b[0] > a[0] ? Math.max(0, Math.min(1, (when - a[0]) / (b[0] - a[0]))) : 0;
        px = b ? a[1] + (b[1] - a[1]) * k : a[1]; pz = b ? a[2] + (b[2] - a[2]) * k : a[2];
      }
      const ex = x - px, ez = z - pz;
      if (Math.hypot(ex, ez) > 4) { s.pose.x = x; s.pose.z = z; s.vis.x = s.vis.z = 0; s.hist.length = 0; return; }   // far off (put elsewhere): there at once
      if (Math.abs(ex) + Math.abs(ez) < 1e-5) return;
      s.pose.x += ex; s.pose.z += ez; s.vis.x -= ex; s.vis.z -= ez;
      if (when !== null) for (const e of s.hist) if (e[0] >= when) { e[1] += ex; e[2] += ez; }
    }

    // One frame of the room visited, drawn here: this visitor walked as its keys say (when the host said how its
    // visitors walk), looking where its mouse says, the room's moving things where they were INTERP_MS ago.
    _sceneFrame(w) {
      const s = w.scene, v = this._view, c = s.canvas, now = performance.now();
      const dt = Math.min(0.1, s.last ? (now - s.last) / 1000 : 0);
      s.last = now;
      const cw = c.clientWidth, ch = c.clientHeight;
      if (!cw || !ch) return;   // not shown
      const k = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (cw * ch))), W = Math.max(2, Math.round(cw * k)), H = Math.max(2, Math.round(ch * k));
      if (c.width !== W || c.height !== H) { s.renderer.setSize(W, H, false); s.camera.aspect = W / H; s.camera.updateProjectionMatrix(); }
      const yaw = s.yaw0 + (v ? v.yaw : 0), pitch = v ? v.pitch : 0;
      if (s.walk && v && v.active && this.visiting && !this.visiting.paused) {
        const key = x => v.keys.has(x);
        const p = walk({ x: s.pose.x, z: s.pose.z, yaw }, { forward: (key("KeyW") || key("ArrowUp") ? 1 : 0) - (key("KeyS") || key("ArrowDown") ? 1 : 0),
          strafe: (key("KeyD") || key("ArrowRight") ? 1 : 0) - (key("KeyA") || key("ArrowLeft") ? 1 : 0), run: key("ShiftLeft") || key("ShiftRight") }, dt, s.walk);
        s.pose.x = p.x; s.pose.z = p.z;
      }
      s.hist.push([now, s.pose.x, s.pose.z]);
      while (s.hist.length > 2 && now - s.hist[0][0] > 2000) s.hist.shift();
      const fade = Math.exp(-dt / 0.1);
      s.vis.x *= fade; s.vis.y *= fade; s.vis.z *= fade;
      s.camera.position.set(s.pose.x + s.vis.x, s.pose.y + s.vis.y, s.pose.z + s.vis.z);
      s.camera.rotation.set(pitch, yaw, 0);
      if (s.offset !== null) this._sceneInterp(s, now - s.offset - INTERP_MS);
      for (const o of s.own) o.visible = false;
      s.renderer.render(s.root, s.camera);
      w.count++;
      this.frames = (this.frames || 0) + 1;
      const done = performance.now();
      keep(this._samples.drawn, done);
      if (v && v.changedAt) {   // input to screen: drawn here, the next frame after the keys or mouse changed
        const ms = done - v.changedAt;
        v.changedAt = 0;
        this.stats.latency = this.stats.latency == null ? ms : this.stats.latency * 0.9 + ms * 0.1;
        keep(this._samples.latency, ms);
      }
      if (now - s.gcAt > 30000) { s.gcAt = now; this._sceneGc(s); }
    }

    _sceneInterp(s, at) {
      for (const [idx, l] of s.samples) {
        const o = s.byIdx.get(idx);
        if (!o || !l.length) { s.samples.delete(idx); continue; }
        let i = 0;
        while (i < l.length - 1 && l[i + 1].ts <= at) i++;
        const a = l[i], b = l[i + 1], k = b && at > a.ts ? Math.min(1, (at - a.ts) / (b.ts - a.ts)) : 0;
        o.position.fromArray(a.p);
        o.quaternion.fromArray(a.q);
        if (a.s) o.scale.fromArray(a.s); else o.scale.set(1, 1, 1);
        if (b && k > 0) {
          o.position.lerp(s.v.fromArray(b.p), k);
          o.quaternion.slerp(s.q.fromArray(b.q), k);
          o.scale.lerp(b.s ? s.v.fromArray(b.s) : s.v.set(1, 1, 1), k);
        }
        o.visible = (b && k >= 1 ? b : a).vis;
        if (i > 0) l.splice(0, i);
        if (!b && at - a.ts > 1000) s.samples.delete(idx);   // at rest: as it is
      }
    }

    // What no object uses any more (removed with them): freed, and the scene's size counted again.
    _sceneGc(s) {
      const used = new Set();
      let objects = 0, vertices = 0;
      s.root.traverse(o => {
        objects++;
        if (o.geometry) used.add(o.geometry.uuid);
        for (const m of list(o.material)) { used.add(m.uuid); for (const k of MAPS) if (m[k] && m[k].isTexture) used.add(m[k].uuid); }
      });
      if (s.root.background && s.root.background.isTexture) used.add(s.root.background.uuid);
      for (const map of [s.geos, s.mats, s.texs]) for (const [uuid, x] of map) if (!used.has(uuid)) { x.dispose(); map.delete(uuid); }
      for (const g of s.geos.values()) vertices += g.attributes && g.attributes.position ? g.attributes.position.count : 0;
      Object.assign(s.budget, { objects, vertices });
    }

    _sceneDrop(w) {
      const s = w && w.scene;
      if (!s) return;
      w.scene = null;
      cancelAnimationFrame(s.raf);
      for (const map of [s.geos, s.mats, s.texs]) for (const x of map.values()) { try { x.dispose(); } catch (e) { /* gone */ } }
      try { s.renderer.dispose(); s.renderer.forceContextLoss(); } catch (e) { /* gone */ }
      if (this._view && this._view.gl === s.canvas) this._view.detach(); else s.canvas.remove();
    }


    // 60 times a second: a visitor's input (when it is due), every visitor moved, and (every SCENE_MS) what
    // changed in this room's scene sent; once a second the stats.
    _tick() {
      const now = performance.now();
      if (this._view) this._sendInput(now, this._view.pending);
      const w = this._viewer;
      if (w && !w.scene && !w.loading && !w.failed && now - (w.askedAt || w.since) > 3000) { w.askedAt = now; this._sceneResync(w); }   // no scene yet: ask again
      if (this._viewer && now - (this._statsAt || 0) >= 1000) {
        this._statsAt = now;
        this.stats.fps = this._viewer.count; this._viewer.count = 0;
        this._emit("stats", this.stats);
      }
      if (!this._hooks || !this._hosted.size) return;
      for (const h of [...this._hosted.values()]) this._step(h, now);
      if (now - (this._sceneAt || 0) >= SCENE_MS - 2) { this._sceneAt = now; this._sceneTick(now); }
      this._visitorsList();
    }

    // One visitor: moved up to now from its latest input. Every tick, and at once when its input comes, so the
    // next delta has where it went.
    _step(h, now) {
      if (!this._hooks) return;
      if (!h.pose) { this._spawn(h); if (!h.pose) return; }
      const dt = Math.min(0.25, (now - (h.movedAt || now)) / 1000);
      h.movedAt = now;
      const fresh = h.input && now - h.inputAt < STALE_MS;
      const input = fresh ? h.input : { forward: 0, strafe: 0, run: false, yaw: h.input ? h.input.yaw : 0, pitch: h.input ? h.input.pitch : 0 };
      try {
        const turned = Object.assign({}, h.pose, { yaw: h.yaw0 + (input.yaw || 0), pitch: input.pitch || 0 });
        h.pose = Object.assign({}, this._hooks.move(turned, input, dt) || turned);
        h.fails = 0;
      } catch (e) { return this._hookFailed(h, "move", e); }
      if (now - (h.keptAt || 0) >= 200) {   // where the visitor stands, kept by visit-client for a reload of this page
        h.keptAt = now;
        this._send({ type: "pose", channel: h.channel, state: { pose: h.pose, yaw0: h.yaw0 } });
      }
    }

    _hookFailed(h, hook, e) {
      console.error(`visit: ${hook} threw, for ${h.visitor.name}`, e);
      if (++h.fails >= 3) this.kick(h.id);
    }

    // ---------- visiting ----------
    // Where the room you are visiting is drawn. While the view is active (the default) it takes WASD, Shift and
    // the mouse; inactive (setActive(false): a picture-in-picture, say) it takes nothing, and the page's own
    // keys are its own again. `viewFocused` says which.
    get viewFocused() { return !!(this.visiting && this._view && this._view.active); }

    view(element) {
      if (this._view) this._view.release();
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%;background:#000;cursor:pointer;outline:none";
      canvas.tabIndex = 0;
      element.appendChild(canvas);
      const view = { element, canvas, ctx: canvas.getContext("2d"), keys: new Set(), yaw: 0, pitch: 0, sentAt: 0, resizeAt: 0, active: true, pending: false, raf: 0,
        gl: null, changedAt: 0 };   // gl: the canvas a scene is drawn on, in this one's place
      const locked = () => !!document.pointerLockElement && (document.pointerLockElement === canvas || document.pointerLockElement === view.gl);
      const ignore = e => e.ctrlKey || e.metaKey || e.altKey || (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)));
      const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"];
      const changed = () => { view.changedAt = view.changedAt || performance.now(); this._sendInput(performance.now(), true); };   // at once (at most every 8 ms): no waiting for a tick
      const down = e => {
        if (!this.visiting || !view.active || ignore(e) || !KEYS.includes(e.code)) return;
        e.preventDefault();
        if (!view.keys.has(e.code)) { view.keys.add(e.code); changed(); }
      };
      const up = e => { if (view.keys.delete(e.code)) changed(); };
      const blur = () => { if (view.keys.size) { view.keys.clear(); changed(); } };
      const click = e => { if (view.active && e.currentTarget.requestPointerLock) e.currentTarget.requestPointerLock(); };
      const look = e => {
        if (!locked()) return;
        view.yaw -= e.movementX * LOOK;
        view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch - e.movementY * LOOK));
        changed();
      };
      addEventListener("keydown", down); addEventListener("keyup", up); addEventListener("blur", blur);
      canvas.addEventListener("click", click); document.addEventListener("mousemove", look);
      const resize = new ResizeObserver(() => { view.resizeAt = performance.now() + 250; });
      resize.observe(element);
      view.attach = gl => {
        view.detach();
        gl.style.cssText = canvas.style.cssText; gl.tabIndex = 0;
        element.insertBefore(gl, canvas);
        canvas.style.display = "none";
        gl.addEventListener("click", click);
        view.gl = gl;
      };
      view.detach = () => {
        if (!view.gl) return;
        if (document.pointerLockElement === view.gl) document.exitPointerLock();
        view.gl.removeEventListener("click", click);
        view.gl.remove();
        view.gl = null;
        canvas.style.display = "block";
      };
      view.release = () => {
        removeEventListener("keydown", down); removeEventListener("keyup", up); removeEventListener("blur", blur);
        canvas.removeEventListener("click", click); document.removeEventListener("mousemove", look);
        resize.disconnect();
        if (locked()) document.exitPointerLock();
        view.detach();
        canvas.remove();
        if (this._view === view) this._view = null;
      };
      view.setActive = on => {
        view.active = !!on;
        if (!view.active) {
          if (locked()) document.exitPointerLock();
          if (view.keys.size) { view.keys.clear(); changed(); }
        }
      };
      this._view = view;
      this._sizeView();
      if (this._viewer && this._viewer.scene) this._sceneAttach(this._viewer);   // a scene being drawn: here now
      return { release: () => view.release(), setActive: on => view.setActive(on), get active() { return view.active; }, canvas };
    }

    _sizeView() {
      const v = this._view;
      if (!v) return;
      const r = v.element.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      v.canvas.width = Math.max(2, Math.round(r.width * dpr)); v.canvas.height = Math.max(2, Math.round(r.height * dpr));
      v.resizeAt = 0;
      if (!(this._viewer && this._viewer.scene)) this._placeholder();
    }

    // Where the room visited will be, until its scene is drawn: what is happening, in words.
    _placeholder(text) {
      const v = this._view;
      if (!v) return;
      const { canvas, ctx } = v;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const say = text || (this.visiting && !(this._viewer && this._viewer.scene) ? `walking into ${this.visiting.host.name || "their"}'s room…` : "");
      if (!say) return;
      const px = Math.max(14, Math.round(canvas.height / 30));
      ctx.fillStyle = "#e6edf3"; ctx.font = `${px}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(say, canvas.width / 2, canvas.height / 2);
    }
    // The visitor's input: the state of its keys and look, whole each time (the newest wins; none is ever
    // queued). When it changes, now (at most every 8 ms; a change sooner goes on the next tick); and every
    // 33 ms regardless, so a host knows it is still held. `t` is this page's clock, which the host's frames
    // carry back: their age when drawn is the latency figure.
    _sendInput(now, changed) {
      const v = this._view;
      if (!v) return;
      if (v.resizeAt && now >= v.resizeAt) this._sizeView();
      if (!this.visiting) return;
      if (now - v.sentAt < (changed ? INPUT_MIN_MS : INPUT_MS)) { if (changed) v.pending = true; return; }
      v.sentAt = now; v.pending = false;
      const k = c => v.keys.has(c);
      this._send({ type: "input", forward: (k("KeyW") || k("ArrowUp") ? 1 : 0) - (k("KeyS") || k("ArrowDown") ? 1 : 0),
        strafe: (k("KeyD") || k("ArrowRight") ? 1 : 0) - (k("KeyA") || k("ArrowLeft") ? 1 : 0),
        run: k("ShiftLeft") || k("ShiftRight"), yaw: v.yaw, pitch: v.pitch, t: now });
    }

    // A delta of the scene of the room visited (SPEC 5.4).
    _frame(buf) {
      const w = this._viewer;
      if (!w || buf.byteLength < 11) return;
      const dv = new DataView(buf);
      if (dv.getUint16(0) === w.channel) this._sceneDelta(w, dv, (dv.getUint8(2) & KEY) !== 0);
    }

    _dropViewer() {
      const w = this._viewer;
      this._sceneDrop(w);
      this._viewer = null;
      this.stats = { latency: null, rtt: null, path: null, fps: 0 };
      if (this._view) {
        const { canvas, ctx } = this._view;
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
    }
  }

  // First-person walking for a host's move(): forward and strafe in the direction it looks, at `speed`
  // units a second (twice that running), sliding along whatever `blocked(x, z)` says is in the way.
  // Pose: { x, y, z, yaw, pitch }, y up, yaw 0 looking toward -z, positive turning left.
  function walk(pose, input, dt, { speed = 2.5, blocked = null } = {}) {
    const f = input.forward || 0, r = input.strafe || 0;
    if (!f && !r) return pose;
    const sin = Math.sin(pose.yaw || 0), cos = Math.cos(pose.yaw || 0);
    let dx = -sin * f + cos * r, dz = -cos * f - sin * r;
    const len = Math.hypot(dx, dz), step = speed * (input.run ? 2 : 1) * dt;
    dx = dx / len * step; dz = dz / len * step;
    const ok = (x, z) => !blocked || !blocked(x, z);
    if (ok(pose.x + dx, pose.z + dz)) return Object.assign({}, pose, { x: pose.x + dx, z: pose.z + dz });
    if (ok(pose.x + dx, pose.z)) return Object.assign({}, pose, { x: pose.x + dx });
    if (ok(pose.x, pose.z + dz)) return Object.assign({}, pose, { z: pose.z + dz });
    return pose;
  }

  // ---------- the ready-made lobby panel ----------
  const PANEL_CSS = `
.visit-panel { font: 12px/1.4 ui-monospace, Consolas, monospace; color: #e6edf3; background: #161b22; border: 1px solid #2d333b; border-radius: 10px; overflow: auto; min-width: 260px; }
.visit-panel .row { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid #2d333b; }
.visit-panel .row:first-child { border-top: 0; }
.visit-panel .hd { font-weight: 700; } .visit-panel .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-panel .muted { color: #8b949e; } .visit-panel .dot { width: 8px; height: 8px; border-radius: 50%; background: #6e7681; flex: none; }
.visit-panel .dot.available { background: #3fb950; } .visit-panel .dot.busy { background: #e3b341; }
.visit-panel button, .visit-panel select, .visit-panel input { font: inherit; color: inherit; background: #0d1117; border: 1px solid #2d333b; border-radius: 6px; padding: 2px 8px; }
.visit-panel button { cursor: pointer; } .visit-panel button:disabled { opacity: .45; cursor: default; }
.visit-panel button.go { background: #2f9e4f; border-color: #2f9e4f; color: #fff; }
.visit-panel .knock { display: block; background: #fff0d6; color: #7a4a00; } .visit-panel .knock .btns { display: flex; gap: 6px; margin-top: 4px; }
.visit-panel input { flex: 1; min-width: 0; }`;

  function panel(element, v) {
    if (!document.getElementById("visit-panel-css")) {
      const st = document.createElement("style"); st.id = "visit-panel-css"; st.textContent = PANEL_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-panel";
    element.appendChild(root);
    let composing = null, timer = null, drawn = "";
    const knockable = o => o.ready && o.status === "available" && (!v.office || o.id !== v.office.id) && o.visitors < o.maxVisitors
      && !(v.visiting && v.visiting.host.id === o.id) && !v.knocking.some(k => k.to === o.id);
    function draw() {
      if (root.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;   // never under a typing hand
      const me = v.office, rows = [];
      rows.push(`<div class="row hd"><span class="dot ${v.state === "online" ? esc(v.status) : ""}"></span><span class="grow">Visit${me ? " · " + esc(me.name) : ""}</span><span class="muted">${esc(v.state)}</span>${v.state === "online" ? `<button data-v="away" title="leave the lobby: nobody sees you or can knock until you come back">Go offline</button>` : ""}</div>`);
      if (v.state === "away") rows.push(`<div class="row"><span class="grow muted">out of the lobby: nobody sees you or can knock</span><button class="go" data-v="back">Go online</button></div>`);
      if (v.state === "online") {
        rows.push(`<div class="row"><span class="grow">you are</span><select data-v="status">${["available", "busy"].map(s => `<option${s === v.status ? " selected" : ""}>${s}</option>`).join("")}</select>
          <select data-v="max" title="how many visitors at once">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}"${n === v.maxVisitors ? " selected" : ""}>${n} visitors</option>`).join("")}</select></div>`);
      }
      for (const k of v.knocks) {
        rows.push(`<div class="row knock"><b>${esc(k.from.name)}</b> is knocking${k.message ? `: “${esc(k.message)}”` : ""}
          <div class="btns"><button class="go" data-v="in" data-k="${esc(k.id)}">Let in</button><button data-v="out" data-k="${esc(k.id)}">Not now</button>
          <span class="muted">${Math.max(0, Math.round((k.until - Date.now()) / 1000))}s</span></div></div>`);
      }
      if (v.visiting) rows.push(`<div class="row"><span class="grow">in <b>${esc(v.visiting.host.name)}</b>'s room${v.visiting.paused ? " (reloading)" : ""}</span><button data-v="leave">Leave</button></div>`);
      for (const x of v.visitors) rows.push(`<div class="row"><span class="grow"><b>${esc(x.visitor.name)}</b> is visiting</span><button data-v="kick" data-x="${esc(x.id)}">Kick</button></div>`);
      for (const o of v.offices) {
        if (me && o.id === me.id) continue;
        const why = !o.ready ? "not ready" : o.status !== "available" ? o.status : o.visitors >= o.maxVisitors ? "full"
          : v.visiting && v.visiting.host.id === o.id ? "you are there" : v.knocking.some(k => k.to === o.id) ? "knocking…" : "";
        rows.push(`<div class="row"><span class="dot ${esc(o.status)}"></span><span class="grow" title="${esc(o.name)}">${esc(o.name)} <span class="muted">${esc(o.sim.name || "")} ${o.visitors}/${o.maxVisitors}</span></span>
          <button data-v="knock" data-o="${esc(o.id)}" ${why ? `disabled title="${esc(why)}"` : ""}>${v.knocking.some(k => k.to === o.id) ? "Knocking…" : "Knock"}</button></div>`);
        if (composing === o.id) rows.push(`<form class="row" data-o="${esc(o.id)}"><input maxlength="280" placeholder="a message for ${esc(o.name)}"><button class="go">Knock</button></form>`);
      }
      if (v.state === "online" && v.offices.length < 2) rows.push(`<div class="row muted">nobody else is here yet</div>`);
      const html = rows.join("");
      if (html === drawn) return;   // nothing new: an open menu stays open, a click lands
      drawn = html;
      root.innerHTML = html;
      const input = root.querySelector("form input");
      if (input) input.focus();
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      const act = b.dataset.v;
      if (act === "knock") { composing = composing === b.dataset.o ? null : b.dataset.o; draw(); }
      else if (act === "in" || act === "out") v.answer(b.dataset.k, act === "in");
      else if (act === "leave") v.leave();
      else if (act === "kick") v.kick(b.dataset.x);
      else if (act === "away") v.leaveLobby();
      else if (act === "back") v.joinLobby();
    });
    root.addEventListener("change", e => {
      if (e.target.dataset.v === "status") v.setStatus(e.target.value);
      if (e.target.dataset.v === "max") v.setMaxVisitors(Number(e.target.value));
    });
    root.addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target.closest("form");
      v.knock(f.dataset.o, f.querySelector("input").value.trim());
      composing = null;
      f.querySelector("input").blur();
      draw();
    });
    root.addEventListener("focusout", () => setTimeout(draw, 0));
    v.on("change", draw);
    timer = setInterval(() => { if (v.knocks.length) draw(); }, 1000);   // the knocks' countdown
    draw();
    return { element: root, release() { clearInterval(timer); v.off("change", draw); root.remove(); } };
  }

  // ---------- the ready-made stage: the room you are visiting, full-window or in a corner ----------
  const STAGE_CSS = `
.visit-stage { position: fixed; z-index: 5; background: #000; overflow: hidden; }
.visit-stage.big { inset: 0; }
.visit-stage.small { right: 16px; bottom: 16px; width: 320px; height: 180px; border: 1px solid #2d333b; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4); cursor: pointer; }
.visit-stage .screen { position: absolute; inset: 0; }
.visit-stage .bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; align-items: center; padding: 6px 10px; font: 12px/1.3 ui-monospace, Consolas, monospace; color: #e6edf3; background: rgba(13,17,23,.78); }
.visit-stage .bar .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.visit-stage .bar .stats { color: #8b949e; white-space: nowrap; }
.visit-stage .bar button { font: inherit; color: inherit; background: #161b22; border: 1px solid #2d333b; border-radius: 6px; padding: 2px 10px; cursor: pointer; }
.visit-stage.small .bar button, .visit-stage.small .bar .stats { display: none; }`;

  // While you visit: the room you are in fills the window, with how it is going (the link's path and round
  // trip, input to screen, frames a second), "Back to my room" and "Leave". Back in your room, the visit
  // shrinks to a corner (and takes no keys: v.viewFocused is false, so the page's own are its own); a click
  // on it brings it back to the full window. Gone when the visit ends. { element, big, shrink(), grow(),
  // release() }
  function stage(v, { parent = document.body } = {}) {
    if (!document.getElementById("visit-stage-css")) {
      const st = document.createElement("style"); st.id = "visit-stage-css"; st.textContent = STAGE_CSS; document.head.appendChild(st);
    }
    const root = document.createElement("div");
    root.className = "visit-stage big"; root.hidden = true;
    root.innerHTML = `<div class="screen"></div><div class="bar"><span class="grow"></span><span class="stats"></span>`
      + `<button type="button" data-s="small" title="your own room, with this one in the corner">Back to my room</button><button type="button" data-s="leave">Leave</button></div>`;
    parent.appendChild(root);
    const screen = root.querySelector(".screen"), cap = root.querySelector(".grow"), nums = root.querySelector(".stats");
    let view = null, big = true;
    function set(on) { big = on; root.className = "visit-stage " + (on ? "big" : "small"); if (view) view.setActive(on); draw(); stats(); }
    function draw() {
      if (v.visiting && !view) { root.hidden = false; view = v.view(screen); big = true; root.className = "visit-stage big"; }
      if (!v.visiting && view) { view.release(); view = null; root.hidden = true; }
      if (!v.visiting) return;
      const name = v.visiting.host.name || "Their";
      cap.textContent = big ? `${name}'s room${v.visiting.paused ? " (reloading)" : ""} · click to look around, WASD to walk, Shift to run, Esc frees the mouse`
        : `${name}'s room · click to go back in`;
    }
    function stats() {
      const x = v.stats;
      nums.textContent = !v.visiting ? "" : [x.path, x.rtt != null && `link ${Math.round(x.rtt)} ms`,
        x.latency != null && `input to screen ${Math.round(x.latency)} ms`, x.fps ? `${x.fps} fps` : ""].filter(Boolean).join(" · ");
    }
    root.addEventListener("click", e => {
      const b = e.target.closest("button[data-s]");
      if (b) { e.stopPropagation(); return b.dataset.s === "leave" ? v.leave() : set(false); }
      if (!big) set(true);
    });
    v.on("change", draw); v.on("stats", stats);
    draw();
    return {
      element: root, get big() { return big; }, shrink: () => set(false), grow: () => set(true),
      release() { v.off("change", draw); v.off("stats", stats); if (view) view.release(); root.remove(); },
    };
  }

  window.Visit = {
    version: VERSION,
    // `threeBase`: where to fetch three.js from instead of the CDN ("{r}" the revision; the same files, checked
    // against the same hashes).
    connect({ port, token, sim = {}, threeBase = null }) {
      const c = new Client(port, token, sim, { threeBase });
      return c._open().then(() => c, e => { c.close(); throw e; });
    },
    walk,
    panel,
    stage,
    _test: { cleanScene, imageDims },   // for visit-client's own tests
  };
})();
