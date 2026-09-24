# The Amazing Race — 3D

**[▶ Play it](https://imelendez.github.io/amazing-race-3d/)**

A playable 3D browser port of [a 2016 Panda3D college
game](https://github.com/imelendez/TheAmazeingRace), running the original's own
maze, models, and character rig. Kill 4 enemies, collect 3 orbs, reach the portal
before the 4:00 clock runs out.

**WASD** move · **mouse** look · **click** or **F** shoot · **Space** jump · **M** mute

It started as a spike to answer one question — *can a 48-joint rigged character from a
2004-era format reach the browser and still animate?* — and the answer turned out to be
yes, so it became a game. The technical writeup below is the spike; §11 covers what it
took to make it playable. The conversion tool is
[`tools/panda2gltf.py`](tools/panda2gltf.py), and the original viewer is still at
[`spike.html`](https://imelendez.github.io/amazing-race-3d/spike.html).

![The original maze rendering in Three.js](docs/maze3d.png)

*The 2016 maze art, in Three.js. Ceiling clipped away so you can see in.*

![Finishing the game](docs/you-win.png)

*A genuine finish — four kills, five orbs, 57 seconds left on the clock.*

It began as a spike: one question, asked before committing to a full port — *can the
original art reach the web with its rigging intact?* The answer was yes, so it became
a game. Sections 1–10 are that spike, written up including the parts I got wrong,
because the wrong turns are the useful bit. [§11](#11-from-spike-to-game) is what it
took to turn it into something you can actually finish.

---

## 1. What had to be proven

The charter called a full 3D port "explicitly optional" and the riskiest phase. After
Phase 2, most of that risk was already gone — the maze geometry, every spawn point,
and the whole game simulation were done and tested. What was left was one genuine
unknown:

> Can a 48-joint skinned character with baked animation clips survive a conversion out
> of a format from 2004 into one from 2017, and still animate correctly?

If yes, the rest of Phase 3 is assembly. If no, the port needs new art and stops being
a port. So the spike targets exactly that, and nothing else.

## 2. Why Three.js

| Option | Verdict |
| --- | --- |
| **Three.js** | **Chosen.** `GLTFLoader` + `AnimationMixer` handle skinned characters natively, which is precisely the shape of the risk. Largest ecosystem, most legible to a reviewer. |
| Babylon.js | Genuinely good, and has a stronger built-in collision/physics story. But I don't need that — see §3 — so its main advantage doesn't apply here. |
| Raw WebGL | Writing a glTF skinning pipeline by hand to prove a glTF skinning pipeline works. Circular and slow. |
| Godot / Unity → WASM | That's a rebuild in another engine, not a port, and ships tens of MB of runtime. |

**Version: three.js r185** (npm `0.185.1`), current as of this writing.

### Why WebGL and not WebGPU

WebGPU is production-ready in Three.js — since r171 you can swap `WebGLRenderer` for
`WebGPURenderer` in roughly one line, and it falls back to WebGL 2 automatically.
The reported wins are ~30–50% on *dense* scenes, plus compute shaders.

This scene peaks around 118k triangles and **4–10 draw calls**, and renders in
0.8 ms. There is no CPU-overhead problem to solve and no compute work to move to the GPU, so WebGPU
would buy nothing measurable while adding a larger runtime and the node-material
(TSL) learning curve. The honest engineering call is WebGL now, with WebGPU as a
one-line change later if the scene ever grows teeth.

*This is the general lesson: "newer" is not a reason. Pick the thing whose advantage
your actual workload can cash in.*

## 3. Collision: reuse Phase 2, don't port Panda's

Phase 2 already extracted an exact wall grid from this same mesh — 242×276 cells,
2.7 KB run-length encoded, verified against 29 tests. Phase 3 renders in 3D and
collides against that same 2D grid, plus a Z axis for the jump. The maze floor is
flat, so this is exact, not an approximation.

That is why Babylon's collision advantage didn't move the decision, and it's why the
existing `game.js` can become a renderer-agnostic simulation layer with a Canvas view
and a Three.js view over it.

## 4. The real obstacle was never rendering — it was 103 MB

The game loads 14 models. Together they are **103.4 MB of `.egg`**, because they're
unoptimised student meshes exported from Rhino and Maya with no decimation:

| model | `.egg` | triangles |
| --- | ---: | ---: |
| `fetus2` | 22.9 MB | — |
| `rose2` | 18.2 MB | — |
| `cheken2` | 17.2 MB | 48,264 |
| `gianteye` | 12.8 MB | 126,134 |
| `ralph` | 1.5 MB | 7,100 |
| `solidfloormazefinal` | 1.0 MB | 3,612 |

The maze — the entire playfield — is **3,612 triangles**. A single enemy chicken is
**48,264**. The portal eyeball is **126,134**. That inversion is the whole asset story.

### Why not `egg2obj`

Panda3D ships `egg2obj`, and it would have been one command. But **OBJ has no concept
of a skeleton.** It would carry the maze and the props and silently drop the only
thing the spike existed to test. Converting twice (egg → obj → glTF) would also lose
materials on the way.

So the exporter loads the model *in Panda3D itself* and writes glTF 2.0 directly,
which keeps Panda's own scene graph as the source of truth — the same data the 2016
game saw.

## 5. Writing the exporter — three traps

[`tools/panda2gltf.py`](tools/panda2gltf.py), ~380 lines, no dependencies beyond
Panda3D itself.

### Trap 1 — the matrix convention cancels itself

Panda3D uses **row-vector** convention (`v' = v × M`) with row-major storage.
glTF uses **column-vector** convention (`v' = M × v`) with column-major storage.

Two mismatches that happen to cancel:

```python
def panda_mat_to_gltf(m):
    return [m.getCell(r, c) for r in range(4) for c in range(4)]
```

Writing Panda's elements out in **row** order produces a correct glTF **column-major**
array, because glTF's math matrix is the transpose of Panda's and transposing a
row-major buffer *is* reading it column-major. Transposing "to be safe" would have
broken it.

### Trap 2 — where the Z-up→Y-up flip is allowed to live

Panda is Z-up, glTF is Y-up. There are three places to put that rotation, and two are
wrong:

- **In the vertices?** Then static meshes get rotated twice — once in the data, once by
  the parent node. And if you also bake the model's uniform scale into vertices, a
  skinned mesh tears apart, because the *skeleton* didn't get scaled with it.
- **On the mesh node?** The glTF spec says the transform of a **skinned** mesh node
  *must be ignored*. So the flip would silently apply to props and silently not apply
  to Ralph.
- **On a shared root node** — correct. Joints are children of it, so their world
  matrices pick it up, and static meshes under it get it too. One place, both cases.

```
root  (matrix = Z-up→Y-up × uniform scale)
├── skeleton root joint → … 48 joints …
└── mesh node (skin → skeleton)
```

Inverse bind matrices are then computed in **pure Panda space** — the root transform
is applied at runtime by the joint hierarchy, so folding it in again would apply it
twice. I made exactly that mistake first; the giveaway was that the maths *looked*
right in isolation.

### Trap 3 — skinning data

Panda stores skin weights indirectly: each vertex holds a `transform_blend` index into
a `TransformBlendTable`, and each blend entry lists (joint, weight) pairs. glTF wants
`JOINTS_0`/`WEIGHTS_0` as flat VEC4s.

Convenient discovery: this rig's **maximum influences per vertex is exactly 4**, which
is glTF's VEC4 limit, so nothing had to be dropped or renormalised away. Empty blend
entries do exist (blend 0 has zero transforms) and will assert if you index them
blindly.

Animation is sampled rather than parsed: pose the actor at each frame, read every
joint's local matrix, decompose to translation/rotation/scale. glTF animation channels
can't carry raw matrices, only TRS — so a matrix→quaternion decomposition is
unavoidable.

## 6. Four bugs worth keeping

**The 118 MB maze.** First successful export of a 1.0 MB source produced a
**118.5 MB** `.glb`. The maze arrives as **301 separate geoms**, and I embedded the
texture once *per primitive* — 301 copies of the same 393 KB PNG. Caching images by
path, and merging geoms that share a material into one primitive, took it to
**0.66 MB and 1 draw call**. Two lessons: verbose formats hide fan-out, and *check the
output size against the input size* — a 100× inflation is a bug announcing itself.

**`base` shadowing.** Assigning a local named `base` inside a function that also reads
Panda's `base` global turned every earlier read into `UnboundLocalError` — but only on
the static-model code path, because the skinned path never touched `base.loader`. A
whole-function-scope language rule producing a path-dependent failure. Renamed the
local; used the `ShowBase()` instance explicitly instead of the global.

**I measured frames per second and learned nothing.** The on-page fps counter read
`1`, which looked like a catastrophic performance bug. Dropping the render resolution
5.7× moved it to 1.3 — nearly nothing, which rules out the GPU. The actual cause:
`requestAnimationFrame` *itself* was only firing ~1.3 times a second, because the
browser pane throttles unfocused tabs. A direct `renderer.render()` call took
**0.8 ms**. FPS conflates two unrelated things — how expensive your frame is, and how
often the browser chooses to schedule you. When it looks wrong, measure the frame
cost directly and check the scheduler separately; on an earlier run the same build
reported a healthy 60 fps purely because the pane happened to be focused.

**I diagnosed with the wrong bone.** Ralph rendered looking like bind pose, so I
sampled `LeftWrist` and found its quaternion essentially identity — apparent proof the
animation hadn't exported. It hadn't failed: **`LeftWrist` simply has no keyframes in
this rig.** `LeftShoulder` swings `0.502 → 0.186 → -0.465` across the same frames. I
nearly rewrote a working exporter. *Validate the probe before trusting what it says.*

## 7. How the result was actually verified

Not by looking at it. Sample a bone that provably moves, at known frames, in both
engines, and compare:

| frame | Panda3D `LeftShoulder` (w,x,y,z) | Three.js | \|dot\| |
| --- | --- | --- | --- |
| 0 | 0.502, −0.385, −0.194, 0.750 | 0.502, −0.385, −0.194, 0.750 | 0.99998 |
| 4 | 0.185, −0.563, −0.210, 0.777 | 0.186, −0.563, −0.210, 0.777 | 1.00000 |
| 8 | −0.465, −0.143, 0.057, 0.872 | −0.465, −0.143, 0.057, 0.872 | 1.00004 |

Compared by **absolute dot product**, not component equality: quaternions are a double
cover, so `q` and `−q` are the same rotation and an interpolator may legitimately flip
the sign. Component-wise comparison would report false failures.

![Ralph mid-stride](docs/ralph-run.png)

*Ralph mid-stride — the 2016 model, the 2016 run cycle, in a browser.*

Also verified: clip durations survive exactly (`run` 17 frames @ 24 fps = 0.667 s,
`walk` 25 frames = 1.042 s) and each clip carries 144 tracks — 48 joints × 3 TRS
channels.

## 8. Where it stands

| | |
| --- | --- |
| three.js | r185, WebGL2 (ANGLE Metal, Apple M1) |
| render cost | **0.8 ms/frame** with shadows, 0.2 ms without |
| triangles | 117,952 in view |
| draw calls | 4–10 |
| geometries / textures | 3 / 6 |
| assets on disk | **5.13 MB** (4 models, down from 10.96) |
| total page weight | ~3.6 MB over the wire — GitHub Pages gzips the `.glb`s |
| Ralph | 48 joints, 2 clips, 7,100 tris |

0.8 ms a frame is roughly 1,250 fps of rendering headroom — the scene is nowhere near
being the bottleneck.

Disk size and transfer size are different questions, and only one of them is what a
player waits for. See [§11](#the-asset-diet) for how the four models went from 10.96 MB
to 5.13 MB without touching a single triangle.

### What's still unsolved

1. **Decimation.** 48k triangles for a chicken and 126k for an eyeball are 10–20×
   more than needed. This is the single biggest win available and it isn't started.
   It also shrinks what gzip can't: fewer vertices beats better-compressed vertices.
2. **Mesh compression.** For a web game, **meshopt** (`EXT_meshopt_compression`) is the
   better default over Draco: similar or better ratios with markedly faster decode, and
   decode speed is what a player feels on load. Draco wins on raw file size if that's
   the only axis you care about.
3. **Texture compression.** Textures are embedded as raw PNG/JPEG. KTX2/Basis would
   cut both download and GPU memory.
Camera collision *was* on this list — the chase camera reversed straight into walls in
the ~13-unit rooms. It's now solved with the Phase 2 wall grid; see §11.

A realistic target after (1)–(3) is **2–3 MB**, roughly half again on what's there now.

## 9. Running it

```bash
python3 serve.py 8125
```

- <http://127.0.0.1:8125/> — the game.
- <http://127.0.0.1:8125/spike.html> — the original viewer, kept as-is: Orbit / Chase /
  Top cameras and run / walk / stop clips. Its Top and Orbit views clip the ceiling
  away, because the maze mesh has a roof and an un-clipped camera above it just sees
  roofing.

Re-export assets (needs the original repo and `pip install panda3d`):

```bash
python3 tools/panda2gltf.py --actor models/ralph --out assets/ralph.glb --scale 0.2 \
    --anim run=models/ralph-run --anim walk=models/ralph-walk \
    --model-path /path/to/TheAmazeingRace
```

## 10. Verdict on the spike

The risky part was never risky after all. The art converts, the rig survives, the
animation is numerically exact, and a frame costs under a millisecond. Which left
assembly — and that's §11.

## 11. From spike to game

### One simulation, two views

The rules live in [`src/sim.js`](src/sim.js): headless, no DOM, no Three.js. It owns
health, damage, patrol behaviour, pickups, the portal gate and the clock, and nothing
about how any of it looks. [`src/game3d.js`](src/game3d.js) is a *view* over it —
rendering, camera, input, audio.

That split is why this repo is a port rather than a rewrite: the same rules already ran
the [2D Canvas version](https://github.com/imelendez/amazing-race-web) against 29 tests.
Collision is the Phase 2 wall grid — 242×276 cells, 2.7 KB, the real floorplan — so the
3D build renders in three dimensions and collides in two, plus a Z axis for the jump the
original had and the 2D port dropped.

![Gameplay](docs/gameplay3d.png)

*Mid-run: an orb going up in sparks, a donut ahead, and one of the chickens closing in
from the right.*

### What playing it actually found

None of this came from a test suite. All of it came from someone playing for a minute.

| Symptom | Cause | Fix |
| --- | --- | --- |
| "camera goes out above" | boom rose to `2.6 + 8·sin(0.95) = 9.1`; the maze ends at 8.33 | clamp below the ceiling; sample the boom at 20 points, not 8 — at 8 an 8-unit boom skips a whole cell and slides through thin walls |
| "turning is not smooth" | the boom's pull-in factor is quantised to 1/20 and was applied raw every frame, so the view popped whenever it grazed geometry | ease toward it: snap in fast so the camera is never inside a wall, drift out slowly |
| "eat the donuts, it does not" | I'd invented a "don't waste it at full health" rule; the original always eats it and caps at 100 | always eat it — and the same invented rule was in the 2D build, with a test asserting it |
| "moves too fast" | 58 units/sec, applied instantly, to a character **1.04 units tall** | 32, strafe ×0.75, input ramped over ~90 ms |
| "being stopped from proceeding" | collision radius 3.2 = 6.4 units across, ~13× Ralph's real 0.50-unit width — only 58% of the maze was standable | radius 1.6; standable cells 4,941 → **6,717**, every objective still reachable, no stranded pockets |
| "dies too fast, no breathing room" | no recovery window, so damage stacked linearly — one enemy emptied 100 HP in 23 s, six did it in about four | 1.2 s invulnerability after each hit; sight 155 → 115; cadence 1.15 → 1.45 |

Survival standing still in the open, before and after the invulnerability window:

| | before | after |
| --- | ---: | ---: |
| 1 enemy | 23.1 s | 29.2 s |
| 6 enemies | ~4 s | 28.9 s |

Capping damage by *time* rather than by source is what "breathing room" turned out to
mean: it makes being seen by six enemies no worse than being seen by one.

Two of these are worth keeping as general lessons. **A hitbox inherited from a
different view of the same game was 13× too big** — in the top-down port the player was
*drawn* at that size, so it looked right there and was invisible here until someone
walked into a doorway. And **the character was completely off-screen at NDC y = −1.48**
and I hadn't noticed, because the look target was pinned 9 units ahead no matter how
short the boom was. I only found it by projecting his world position to screen space
and checking the number, which is the kind of thing you do instead of squinting at a
screenshot.

### The asset diet

The four models started at **10.96 MB** and ended at **5.13 MB**, without removing a
single triangle:

- **Welding by position, averaging normals.** Exact welding merged 40 vertices out of
  cheken2's 101,268 — the mesh has a split normal on every face, so nothing ever
  matches. Dropping the normal from the key and averaging instead merged **77,075**:
  3.64 MB → 1.29 MB. The trade is hard facets for smooth shading, which on an organic
  blob is an improvement anyway.
- **16-bit indices.** Every mesh here is under 65,536 vertices, so 32-bit indices were
  pure waste — that's half the index buffer back.
- **Texture downscaling.** `space.png` shipped at 1884×1064 and 2.63 MB, for a portal
  nobody inspects up close. Capped at 512 px.

`gianteye` barely moved under welding (10 vertices), and that's informative rather than
disappointing: 64,170 vertices for 126,134 triangles is already near-optimal sharing.
Its weight is real geometry, so the only lever left on it is decimation.

Phase 2 remains the simplest thing to hand someone —
[play it](https://imelendez.github.io/amazing-race-web/) — but this one is finishable
now too.

## The three repos

| | |
| --- | --- |
| [TheAmazeingRace](https://github.com/imelendez/TheAmazeingRace) | The 2016 Panda3D original. Still runs — it needed a current Panda3D and a four-line Python 2 → 3 fix, nothing else. |
| [amazing-race-web](https://github.com/imelendez/amazing-race-web) | [2D Canvas port.](https://imelendez.github.io/amazing-race-web/) Dependency-free, 44 KB, 29 tests. The maze was extracted from the original's 3D model. |
| **amazing-race-3d** | [This one.](https://imelendez.github.io/amazing-race-3d/) The original art and rig, in Three.js. |
