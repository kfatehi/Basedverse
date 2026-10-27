# Bodies, things and positions between rooms

How a room says where people are, and how it hands its user's body and things to other rooms so that they look
right there. Every room that takes part in Visit follows this, so that what one room makes, every other room can
show. It is written for whoever implements a room, person or coding agent: follow it as written, and check with
`Visit.checkModel` before anyone visits.

Read it with [INTEGRATING.md](INTEGRATING.md) (the steps) and [SPEC.md](SPEC.md) (the details: 8.1, 8.2, 8.6,
8.11). Visit carries and places; it decides nothing about what things are or how they move. That is each room's.

## 1. Positions: the feet

**Where someone is, is where their feet are**: the point on the ground under them, `{ x, y, z }` in the room's own
units (its `unit`: metres in one), and which way they face, `yaw` (radians; 0 faces −z, positive turns left).

- Your room's `spawn` returns that for a visitor, and its `move` returns where they are next: their feet. On your
  floor, `y` is your floor's height (0, if your floor is at 0). Upstairs, in the air, on a mount: higher.
- Your `world.frame(dt, me, input)` takes your own user the same way: `me` is where their feet are.
- **Eyes are not positions.** Someone's eyes are above their feet: their own model's `eyes` point (section 2),
  else your room's `eye` (`visit.host({ eye })`, in metres; 1.6 unless you say). Visit uses it only to place a
  visitor's camera, and to start a click's ray (`"point"`: `from` is their eyes). Your physics never needs it.
- A visitor's own world shows them as high as your room has them: your `y` for their feet.

```js
visit.host({
  spawn: (who, { at } = {}) => ({ x: at ? at.x : 2, y: at ? at.air || 0 : 0, z: at ? at.z : 6, yaw: at ? at.yaw : 0, pitch: 0 }),
  move: (pose, input, dt, { riding }) => myPhysics(pose, input, dt, riding),   // returns their feet, see section 4
  eye: 1.7,   // only if your visitors' eyes are not 1.6 m over their feet when you draw them as your own model
  // ...
});
```

**Do not** return the eyes' height from `spawn` or `move` (the old convention, before Visit 0.19: 1.6 on the
floor). A visitor drawn by another room would stand 1.6 m too high, or be buried that deep where the room
subtracted it.

## 2. Models: your user's body, and things

Anything that goes to another room as a three.js model (your user's body, `visit.avatar`; a possession,
`visit.possessions`) is made the same way:

- **One model of its own**: a fresh `Object3D` (a `Group` of meshes), not one standing in your scene. Its own
  `position` and `rotation` are zero: they would go with it, and put it off its feet everywhere.
- **Its feet at its origin**: the ground under it at y = 0, centred on x = 0, z = 0.
- **Facing −z**, +y up.
- **Its size in metres** (or say its unit: `{ unit }`, metres in one of its units).
- **Plain three.js**: three.js's own geometries and materials (`MeshStandardMaterial`, `MeshLambertMaterial`, ...);
  textures as canvases or images. No custom shaders (they do not carry). Parts moved by clips on named groups carry
  best; skinned meshes (bones) read less surely in rooms on other three.js releases.
- **Small enough**: at most 300 000 vertices, 2 000 objects, 4 MiB gzipped.

### Named points

A model may carry points: an `Object3D` (it draws nothing) with a name, placed in the model.

| name | in | what it is | without it |
|---|---|---|---|
| `eyes` | a body | where its owner sees from: a visitor's camera in a room that shows their own model | 92% of its height |
| `seat` | a mount | where its rider's feet go (its `lift`: how high) | `lift`, else 0 |

### Clips: its poses and moves

Put its moves in its `animations` (`THREE.AnimationClip`), named so that any room knows when to play each. Each
clip moves parts of it **by name**: every name a track uses must be a part it has.

| clip | for | played |
|---|---|---|
| `idle` | a body, a mount | standing still (breathing, looking about) |
| `walk` | a body, a mount | moving |
| `run` | a mount | moving fast (else `walk`) |
| `fly` | a mount that flies | in the air (the room's `move` says so: `air`, section 4) |
| `ride` (or `sit`) | a body | on a mount |

Visit plays them (eased from one to the next) wherever the model is drawn: in the room its owner visits, and at
home under your own user.

```js
// A body: rigid parts on named groups, moved by clips. Feet at the origin, facing -z, metres.
function myBody(THREE) {
  const body = new THREE.Group(), m = c => new THREE.MeshLambertMaterial({ color: c });
  const part = (name, w, h, d, color, x, y, z) => {
    const g = new THREE.Group(); g.name = name; g.position.set(x, y, z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m(color)); mesh.position.y = -h / 2; g.add(mesh);
    body.add(g); return g;
  };
  part("leg0", 0.18, 0.85, 0.18, 0x334455, -0.12, 0.85, 0); part("leg1", 0.18, 0.85, 0.18, 0x334455, 0.12, 0.85, 0);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.65, 0.28), m(0x8844aa)); torso.name = "torso"; torso.position.y = 1.18; body.add(torso);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), m(0xffd7a8)); head.name = "head"; head.position.y = 1.68; body.add(head);
  const eyes = new THREE.Object3D(); eyes.name = "eyes"; eyes.position.set(0, 1.7, -0.16); body.add(eyes);   // where it sees from
  const swing = (name, a) => new THREE.QuaternionKeyframeTrack(name + ".quaternion", [0, 0.35, 0.7],
    [...new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)).toArray(), ...new THREE.Quaternion().setFromEuler(new THREE.Euler(-a, 0, 0)).toArray(),
     ...new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)).toArray()]);
  const hold = (name, a) => new THREE.QuaternionKeyframeTrack(name + ".quaternion", [0], new THREE.Quaternion().setFromEuler(new THREE.Euler(a, 0, 0)).toArray());
  body.animations = [
    new THREE.AnimationClip("idle", 2, [new THREE.NumberKeyframeTrack("head.position[y]", [0, 1, 2], [1.68, 1.7, 1.68])]),
    new THREE.AnimationClip("walk", 0.7, [swing("leg0", 0.5), swing("leg1", -0.5)]),
    new THREE.AnimationClip("ride", 1, [hold("leg0", -1.4), hold("leg1", -1.4)]),
  ];
  return body;
}
visit.avatar(myBody(THREE));   // your user's body, for rooms that show their visitors' own looks
```

### Check it

```js
const c = Visit.checkModel(myBody(THREE), { three: THREE });   // { kind: "mount" } for a mount; { unit } if not metres
console.log(c.ok, c.problems, c.notes, c.height, c.eyes, c.clips);
```

It runs the model through what another room does with it (its JSON, read back with three.js) and says what is
wrong: feet off its origin, not centred, its own place or turn not zero, a size that does not fit its unit, a clip
that moves a part it does not have, shaders, too big, does not read back. `visit.avatar` and `visit.possessions`
run it as you give them: what is wrong goes to the console and the panel says it.

## 3. Showing your visitors

- **Their own model** (your panel's "visitors look like: their model", the default, or theirs for one person):
  **Visit draws it**, in your scene, at their feet, facing their way, playing its clips. Draw nothing of yours for
  them, and nothing of theirs: no adding it to your scene, no moving it.
- **Your model** ("our model"): you draw your own figure for them, at their feet (`pose`), facing `pose.yaw`.
- Which, for each: `visit.visitors[i].look` ("theirs" or "mine"). Draw your own only when it is "mine". If you
  keep something of yours with them either way (a name tag), put it over their eyes: `pose.y + visitors[i].eyes`.
- Mark your own figure for a visitor `userData.visitor = visitors[i].id`: their own copy of your room then leaves it
  out of their eyes, and their clicks pass through it.
- When their own model cannot be shown (their room gives none, or it does not read here), they are shown as yours,
  and both panels say why: yours ("their model can't be shown here: ..."), and theirs ("in your room they look like
  your model: ...").

## 4. Your physics

Visit has none: no gravity, no flying, no pace of its own. Your `move` decides, from what it is told:

- `input`: `forward`, `strafe`, `run`, `up` (−1, 0, 1: Space or Page Up, X or Page Down), the look (`yaw`, `pitch`).
- `riding` (`who.riding`): the mount they ride here, `{ id, name, fly, speed, lift }`, or null. Visit puts the mount
  under their feet, `lift` below them; how they ride is yours.
- `spawn`'s `at.air`: how high above their own floor they were, stepping in from a world in the air.

What we suggest, so that rooms feel alike (each is your call):

```js
function myPhysics(pose, input, dt, riding) {
  const floor = (riding ? riding.lift : 0);                               // a rider sits its mount's lift up
  const p = Visit.walk(pose, input, dt, { speed: 2.5 * (riding ? riding.speed : 1), blocked: myWalls });   // at its pace
  const y0 = Number.isFinite(pose.y) ? pose.y : floor;
  const y = riding && riding.fly ? Math.max(floor, y0 + (input.up || 0) * 4 * dt)   // a mount that flies: up and down, 4 m/s
    : y0 > floor ? Math.max(floor, y0 - 1.5 * dt) : floor;                       // above the floor: down, gently, 1.5 m/s
  return Object.assign(p, { y, air: y - floor });                              // air: how high above the floor (its fly clip)
}
```

Say `walk: { speed: 2.5, mounts: true }` in `visit.host` when your `move` walks with `Visit.walk` at that speed
(and riders at their mount's pace): a visitor's page walks at once, before your answer. `mounts: false` keeps
mounts out of your room.

## 5. Your user at home

With a world (`visit.world`): Visit draws your user's mount under their feet (`me`; pass `me.facing` if they face
another way than they look). Draw your user yourself, lifted onto it (`visit.rideLift`), walking at its pace
(`visit.rideSpeed`), flying if it flies (`visit.rideFly`; pass `air` and `up` to `world.frame` while they fly).

## 6. A checklist

- [ ] `spawn` and `move` return feet; `eye` said if not 1.6.
- [ ] `visit.avatar(body)`: a model of its own, feet at its origin, facing −z, metres, an `eyes` point, `idle` and
      `walk` clips (and `ride`); `Visit.checkModel` says ok.
- [ ] Possessions the same; a mount with `seat` (or `lift`), `speed`, `fly`, and `walk`/`fly` clips.
- [ ] Your visitors: your own figure only where `look` is "mine", at their feet, marked `userData.visitor`.
- [ ] Your physics in `move`: what happens to someone above your floor, to `up`, to `riding`.
- [ ] With a friend: each of you visits the other; each looks like their own model, standing on the floor, seeing
      from their own eyes; nobody's panel says a model can't be shown.
