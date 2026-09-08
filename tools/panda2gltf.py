#!/usr/bin/env python3
"""Convert Panda3D models (.egg/.bam) to binary glTF (.glb), including skinned characters.

Why this exists
---------------
The 2016 project's art is in Panda3D's `.egg` format — a verbose ASCII format nothing
on the web can read. Panda ships `egg2obj`, but OBJ has no concept of a skeleton, so it
can't carry Ralph (48 joints, two animation clips). Rather than convert twice and lose
the rigging, this loads the model *in Panda3D itself* and writes glTF 2.0 directly.
That way the source of truth is Panda's own scene graph, exactly as the game saw it.

Usage
-----
  # static prop
  python3 panda2gltf.py --model models/gianteye --out gianteye.glb --scale 0.126

  # skinned character with animation clips
  python3 panda2gltf.py --actor models/ralph --out ralph.glb --scale 0.2 \
      --anim run=models/ralph-run --anim walk=models/ralph-walk
"""
import argparse
import json
import math
import os
import struct
import sys

from panda3d.core import loadPrcFileData

loadPrcFileData("", "window-type none")
loadPrcFileData("", "audio-library-name null")

from direct.showbase.ShowBase import ShowBase          # noqa: E402
from direct.actor.Actor import Actor                   # noqa: E402
from panda3d.core import (                             # noqa: E402
    GeomVertexReader, TransformState, LMatrix4, NodePath, Filename,
)

# ---------------------------------------------------------------------------
# glTF component/type constants
FLOAT, UNSIGNED_SHORT, UNSIGNED_INT = 5126, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


class Gltf:
    """Accumulates glTF JSON plus one binary blob, then writes a .glb."""

    def __init__(self):
        self.json = {
            "asset": {"version": "2.0", "generator": "panda2gltf (TheAmazeingRace)"},
            "scene": 0, "scenes": [{"nodes": []}], "nodes": [],
            "meshes": [], "accessors": [], "bufferViews": [], "buffers": [],
            "materials": [], "textures": [], "images": [], "samplers": [],
        }
        self.bin = bytearray()
        self._out = "."
        self._images = {}      # (abs path, max_px) -> texture index
        self._materials = {}   # texture index -> material index

    # -- binary helpers ----------------------------------------------------
    def _align(self, n=4):
        while len(self.bin) % n:
            self.bin.append(0)

    def view(self, data, target=None):
        self._align()
        off = len(self.bin)
        self.bin.extend(data)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.json["bufferViews"].append(v)
        return len(self.json["bufferViews"]) - 1

    def accessor(self, data, count, ctype, tname, target=None, minmax=None):
        idx = self.view(data, target)
        a = {"bufferView": idx, "componentType": ctype, "count": count, "type": tname}
        if minmax:
            a["min"], a["max"] = minmax
        self.json["accessors"].append(a)
        return len(self.json["accessors"]) - 1

    def floats(self, values, comps, target=None, with_minmax=False):
        n = len(values) // comps
        data = struct.pack("<%df" % len(values), *values)
        mm = None
        if with_minmax:
            lo = [min(values[i::comps]) for i in range(comps)]
            hi = [max(values[i::comps]) for i in range(comps)]
            mm = (lo, hi)
        tname = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4"}[comps]
        return self.accessor(data, n, FLOAT, tname, target, mm)

    def write(self, path):
        self.json["buffers"] = [{"byteLength": len(self.bin)}]
        js = json.dumps(self.json, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        bn = bytes(self.bin) + b"\x00" * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(bn)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack("<II", len(bn), 0x004E4942)); f.write(bn)
        return total


# ---------------------------------------------------------------------------
# matrix helpers.
#
# Panda uses row-vector convention (v' = v * M) with row-major storage; glTF uses
# column-vector convention (v' = M * v) with column-major storage. Those two flips
# cancel: writing Panda's elements out in row order yields a correct glTF matrix.

def panda_mat_to_gltf(m):
    return [m.getCell(r, c) for r in range(4) for c in range(4)]


def decompose(a):
    """Split a glTF column-major 4x4 into (translation, rotation quat xyzw, scale)."""
    t = [a[12], a[13], a[14]]
    cols = [a[0:3], a[4:7], a[8:11]]
    s = [math.sqrt(sum(v * v for v in c)) or 1.0 for c in cols]
    r = [[cols[c][row] / s[c] for c in range(3)] for row in range(3)]  # r[row][col]

    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0:
        k = math.sqrt(tr + 1.0) * 2
        w = 0.25 * k
        x = (r[2][1] - r[1][2]) / k
        y = (r[0][2] - r[2][0]) / k
        z = (r[1][0] - r[0][1]) / k
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        k = math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
        w = (r[2][1] - r[1][2]) / k; x = 0.25 * k
        y = (r[0][1] + r[1][0]) / k; z = (r[0][2] + r[2][0]) / k
    elif r[1][1] > r[2][2]:
        k = math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
        w = (r[0][2] - r[2][0]) / k; x = (r[0][1] + r[1][0]) / k
        y = 0.25 * k; z = (r[1][2] + r[2][1]) / k
    else:
        k = math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
        w = (r[1][0] - r[0][1]) / k; x = (r[0][2] + r[2][0]) / k
        y = (r[1][2] + r[2][1]) / k; z = 0.25 * k
    n = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    return t, [x / n, y / n, z / n, w / n], s


def mat_mul(a, b):
    """Column-major 4x4 multiply: returns a*b."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def mat_inverse(m):
    """General 4x4 inverse (Gauss-Jordan) on a column-major array."""
    a = [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    inv = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise ValueError("singular matrix")
        a[col], a[piv] = a[piv], a[col]
        inv[col], inv[piv] = inv[piv], inv[col]
        d = a[col][col]
        a[col] = [v / d for v in a[col]]
        inv[col] = [v / d for v in inv[col]]
        for r in range(4):
            if r == col:
                continue
            f = a[r][col]
            if f:
                a[r] = [x - f * y for x, y in zip(a[r], a[col])]
                inv[r] = [x - f * y for x, y in zip(inv[r], inv[col])]
    return [inv[r][c] for c in range(4) for r in range(4)]


# Panda is Z-up; glTF is Y-up. Rotating -90 deg about X maps (x, y, z) -> (x, z, -y).
# It rides on one root node (combined with the model's uniform scale) so it applies to
# the skeleton as well as the mesh: glTF ignores a *skinned* mesh node's own transform,
# so the flip cannot live there, and baking it into vertices would apply it twice for
# static meshes and desynchronise mesh from skeleton for skinned ones.
ZUP_TO_YUP = [1, 0, 0, 0,
              0, 0, -1, 0,
              0, 1, 0, 0,
              0, 0, 0, 1]


# ---------------------------------------------------------------------------
def collect_geoms(root_np):
    out = []
    for i in range(root_np.findAllMatches("**/+GeomNode").getNumPaths()):
        gnp = root_np.findAllMatches("**/+GeomNode").getPath(i)
        gn = gnp.node()
        for g in range(gn.getNumGeoms()):
            out.append((gnp, gn.getGeom(g), gn.getGeomState(g)))
    return out


def find_texture(root_np, geom_state):
    tex = None
    try:
        from panda3d.core import TextureAttrib
        if geom_state.hasAttrib(TextureAttrib):
            tex = geom_state.getAttrib(TextureAttrib).getTexture()
    except Exception:
        pass
    if tex is None:
        ts = root_np.findAllTextures()
        if ts.getNumTextures():
            tex = ts.getTexture(0)
    return tex


def embed_image(gltf, path, max_px=None):
    """Embed a texture once, however many primitives reference it.

    Getting this wrong is expensive and silent: the maze has 301 separate geoms, so
    embedding per-primitive produced a 118 MB .glb from a 1 MB source.
    """
    key = (os.path.abspath(path), max_px)
    if key in gltf._images:
        return gltf._images[key]
    ext = os.path.splitext(path)[1].lower()
    mime = "image/png" if ext == ".png" else "image/jpeg"

    # The original art ships game textures at print resolution - space.png is
    # 1884x1064 (2.6 MB) for a portal nobody inspects up close.
    if max_px:
        from panda3d.core import PNMImage, Filename
        img = PNMImage()
        if img.read(Filename.fromOsSpecific(path)) and max(img.getXSize(), img.getYSize()) > max_px:
            sc = max_px / float(max(img.getXSize(), img.getYSize()))
            small = PNMImage(max(1, int(img.getXSize() * sc)), max(1, int(img.getYSize() * sc)))
            small.quickFilterFrom(img)
            tmp = os.path.join(os.path.dirname(os.path.abspath(gltf._out)),
                               "._tex%d%s" % (len(gltf._images), ext))
            small.write(Filename.fromOsSpecific(tmp))
            path = tmp
    with open(path, "rb") as f:
        data = f.read()
    if max_px and path.find("._tex") >= 0:
        os.remove(path)
    view = gltf.view(data)
    gltf.json["images"].append({"bufferView": view, "mimeType": mime})
    if not gltf.json["samplers"]:
        gltf.json["samplers"].append({"magFilter": 9729, "minFilter": 9987,
                                      "wrapS": 10497, "wrapT": 10497})
    gltf.json["textures"].append({"sampler": 0, "source": len(gltf.json["images"]) - 1})
    gltf._images[key] = len(gltf.json["textures"]) - 1
    return gltf._images[key]


def make_material(gltf, tex_index, name):
    if tex_index in gltf._materials:
        return gltf._materials[tex_index]
    pbr = {"metallicFactor": 0.0, "roughnessFactor": 0.85}
    if tex_index is not None:
        pbr["baseColorTexture"] = {"index": tex_index}
    else:
        pbr["baseColorFactor"] = [0.8, 0.8, 0.8, 1.0]
    gltf.json["materials"].append({"name": name, "pbrMetallicRoughness": pbr,
                                   "doubleSided": True})
    gltf._materials[tex_index] = len(gltf.json["materials"]) - 1
    return gltf._materials[tex_index]


# ---------------------------------------------------------------------------
def export(args):
    sb = ShowBase()          # named, not the `base` builtin — a local `base` would shadow it
    gltf = Gltf()

    anims = dict(a.split("=", 1) for a in (args.anim or []))
    if args.actor:
        np_root = Actor(args.actor, anims) if anims else Actor(args.actor)
        model_np = np_root
    else:
        np_root = sb.loader.loadModel(args.model)
        model_np = np_root

    # ---- skeleton -------------------------------------------------------
    joints, joint_index, joint_parent = [], {}, {}
    if args.actor:
        chars = model_np.findAllMatches("**/+Character")
        if chars.getNumPaths():
            bundle = chars.getPath(0).node().getBundle(0)

            def walk(part, parent):
                from panda3d.core import CharacterJoint
                if isinstance(part, CharacterJoint):
                    joint_index[part.getName()] = len(joints)
                    joint_parent[part.getName()] = parent
                    joints.append(part)
                    parent = part.getName()
                for i in range(part.getNumChildren()):
                    walk(part.getChild(i), parent)

            walk(bundle, None)

    # ---- geometry -------------------------------------------------------
    geoms = collect_geoms(model_np)
    # Geoms sharing a material are merged into one primitive. The maze arrives as 301
    # separate geoms; left alone that's 301 draw calls a frame for 3,612 triangles.
    buckets = {}
    total_welded = [0]
    total_v = total_t = 0
    scale = args.scale

    for gnp, geom, state in geoms:
        vd = geom.getVertexData()
        blend_tbl = vd.getTransformBlendTable() if joints else None

        rv = GeomVertexReader(vd, "vertex")
        rn = GeomVertexReader(vd, "normal") if vd.hasColumn("normal") else None
        rt = GeomVertexReader(vd, "texcoord") if vd.hasColumn("texcoord") else None
        rb = (GeomVertexReader(vd, "transform_blend")
              if (blend_tbl is not None and vd.hasColumn("transform_blend")) else None)

        pos, nrm, uv, jnt, wgt = [], [], [], [], []
        while not rv.isAtEnd():
            v = rv.getData3f()
            # Vertices stay in Panda space. Axis flip and scale live on the root node
            # instead: doing it here as well would rotate static meshes twice, and
            # scaling vertices without scaling the skeleton would tear Ralph apart.
            pos.extend([v[0], v[1], v[2]])
            if rn:
                n = rn.getData3f()
                nrm.extend([n[0], n[1], n[2]])
            if rt:
                t = rt.getData2f()
                uv.extend([t[0], 1.0 - t[1]])          # glTF UV origin is top-left
            if rb:
                bi = rb.getData1i()
                b = blend_tbl.getBlend(bi)
                js, ws = [], []
                for k in range(min(4, b.getNumTransforms())):
                    tr = b.getTransform(k)
                    jn = tr.getJoint().getName() if hasattr(tr, "getJoint") else None
                    if jn in joint_index:
                        js.append(joint_index[jn]); ws.append(b.getWeight(k))
                while len(js) < 4:
                    js.append(0); ws.append(0.0)
                s = sum(ws)
                if s > 0:
                    ws = [w / s for w in ws]
                else:
                    ws = [1.0, 0.0, 0.0, 0.0]
                jnt.extend(js); wgt.extend(ws)

        idx = []
        for p in range(geom.getNumPrimitives()):
            prim = geom.getPrimitive(p).decompose()
            idx.extend(prim.getVertexList())
        if not idx:
            continue

        # resolve the material first, so it can key the merge bucket
        tex = find_texture(model_np, state)
        ti = None
        if tex is not None:
            fn = tex.getFullpath().toOsSpecific()
            if os.path.exists(fn):
                ti = embed_image(gltf, fn, args.max_texture)
        if args.texture and ti is None and os.path.exists(args.texture):
            ti = embed_image(gltf, args.texture, args.max_texture)
        mi = make_material(gltf, ti, os.path.basename(args.actor or args.model))

        # Weld duplicate vertices. These meshes come out of Rhino/Maya essentially
        # unshared - cheken2 has 101,308 vertices for 48,264 triangles, i.e. ~2.1
        # vertices per triangle where a welded mesh approaches 0.5. Deduplicating
        # identical (position, normal, uv, skin) tuples costs nothing visually.
        if not args.no_weld:
            seen, remap = {}, [0] * (len(pos) // 3)
            wp, wn, wu, wj, ww = [], [], [], [], []
            for i in range(len(pos) // 3):
                k = (round(pos[i*3], 5), round(pos[i*3+1], 5), round(pos[i*3+2], 5))
                # Exact welding needs matching normals, but these meshes were exported
                # with a split normal per face, so nothing ever matches (40 of 101,268
                # merged on cheken2). --smooth-weld drops the normal from the key and
                # averages instead, trading hard facets for a ~4x smaller mesh.
                if nrm and not args.smooth_weld:
                    k += (round(nrm[i*3], 4), round(nrm[i*3+1], 4), round(nrm[i*3+2], 4))
                if uv:
                    k += (round(uv[i*2], 5), round(uv[i*2+1], 5))
                if jnt:
                    k += tuple(jnt[i*4:i*4+4]) + tuple(round(w, 4) for w in wgt[i*4:i*4+4])
                j = seen.get(k)
                if j is None:
                    j = seen[k] = len(wp) // 3
                    wp.extend(pos[i*3:i*3+3])
                    if nrm: wn.extend(nrm[i*3:i*3+3])
                    if uv:  wu.extend(uv[i*2:i*2+2])
                    if jnt:
                        wj.extend(jnt[i*4:i*4+4]); ww.extend(wgt[i*4:i*4+4])
                elif nrm and args.smooth_weld:
                    for c in range(3):                 # accumulate for averaging
                        wn[j*3 + c] += nrm[i*3 + c]
                remap[i] = j
            if nrm and args.smooth_weld:
                for v in range(len(wn) // 3):
                    x, y, z = wn[v*3], wn[v*3+1], wn[v*3+2]
                    L = math.sqrt(x*x + y*y + z*z) or 1.0
                    wn[v*3], wn[v*3+1], wn[v*3+2] = x/L, y/L, z/L
            welded_from = len(pos) // 3
            pos, nrm, uv, jnt, wgt = wp, wn, wu, wj, ww
            idx = [remap[i] for i in idx]
            total_welded[0] += welded_from - len(pos) // 3

        # only merge geoms with identical attribute sets, or the arrays desynchronise
        key = (mi, bool(nrm), bool(uv), bool(jnt))
        b = buckets.setdefault(key, {"mi": mi, "pos": [], "nrm": [], "uv": [],
                                     "jnt": [], "wgt": [], "idx": []})
        voffset = len(b["pos"]) // 3
        b["pos"].extend(pos); b["nrm"].extend(nrm); b["uv"].extend(uv)
        b["jnt"].extend(jnt); b["wgt"].extend(wgt)
        b["idx"].extend(i + voffset for i in idx)
        total_v += len(pos) // 3
        total_t += len(idx) // 3

    primitives = []
    for b in buckets.values():
        attrs = {"POSITION": gltf.floats(b["pos"], 3, ARRAY_BUFFER, with_minmax=True)}
        if b["nrm"]:
            attrs["NORMAL"] = gltf.floats(b["nrm"], 3, ARRAY_BUFFER)
        if b["uv"]:
            attrs["TEXCOORD_0"] = gltf.floats(b["uv"], 2, ARRAY_BUFFER)
        if b["jnt"]:
            attrs["JOINTS_0"] = gltf.accessor(
                struct.pack("<%dH" % len(b["jnt"]), *b["jnt"]), len(b["jnt"]) // 4,
                UNSIGNED_SHORT, "VEC4", ARRAY_BUFFER)
            attrs["WEIGHTS_0"] = gltf.floats(b["wgt"], 4, ARRAY_BUFFER)
        # 16-bit indices halve the index buffer, and every mesh here fits
        nverts = len(b["pos"]) // 3
        if nverts < 65536:
            ia = gltf.accessor(struct.pack("<%dH" % len(b["idx"]), *b["idx"]),
                               len(b["idx"]), UNSIGNED_SHORT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        else:
            ia = gltf.accessor(struct.pack("<%dI" % len(b["idx"]), *b["idx"]),
                               len(b["idx"]), UNSIGNED_INT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        primitives.append({"attributes": attrs, "indices": ia, "material": b["mi"]})

    gltf.json["meshes"].append({"name": "mesh", "primitives": primitives})
    mesh_index = 0

    # ---- nodes ----------------------------------------------------------
    # root carries the Z-up -> Y-up rotation for mesh AND skeleton
    sc = args.scale
    root_matrix = [sc, 0, 0, 0,
                   0, 0, -sc, 0,
                   0, sc, 0, 0,
                   0, 0, 0, 1]
    root_node = {"name": "root", "matrix": root_matrix, "children": []}
    gltf.json["nodes"].append(root_node)
    gltf.json["scenes"][0]["nodes"] = [0]

    if joints:
        base_i = len(gltf.json["nodes"])
        for j in joints:
            t, r, s = decompose(panda_mat_to_gltf(j.getDefaultValue()))
            gltf.json["nodes"].append({"name": j.getName(), "translation": t,
                                       "rotation": r, "scale": s, "children": []})
        for j in joints:
            p = joint_parent[j.getName()]
            ni = base_i + joint_index[j.getName()]
            if p is None:
                root_node["children"].append(ni)
            else:
                gltf.json["nodes"][base_i + joint_index[p]]["children"].append(ni)

        # inverse bind matrices = inverse(global bind transform of each joint)
        globals_ = {}

        def global_of(j):
            nm = j.getName()
            if nm in globals_:
                return globals_[nm]
            local = panda_mat_to_gltf(j.getDefaultValue())
            p = joint_parent[nm]
            g = local if p is None else mat_mul(global_of(joints[joint_index[p]]), local)
            globals_[nm] = g
            return g

        ibm = []
        for j in joints:
            ibm.extend(mat_inverse(global_of(j)))
        acc = gltf.floats(ibm, 16)
        gltf.json["skins"] = [{
            "name": "skeleton",
            "inverseBindMatrices": acc,
            "joints": [base_i + i for i in range(len(joints))],
            "skeleton": base_i,
        }]
        mesh_node = {"name": "skin", "mesh": mesh_index, "skin": 0}
    else:
        mesh_node = {"name": "geometry", "mesh": mesh_index}

    gltf.json["nodes"].append(mesh_node)
    root_node["children"].append(len(gltf.json["nodes"]) - 1)

    # ---- animation ------------------------------------------------------
    if joints and anims:
        gltf.json["animations"] = []
        base_i = 1  # joints start at node 1 (node 0 is root)
        for name in anims:
            ctrl = np_root.getAnimControl(name)
            nframes, fps = ctrl.getNumFrames(), ctrl.getFrameRate()
            times = [f / fps for f in range(nframes)]
            tracks = {j.getName(): ([], [], []) for j in joints}
            for f in range(nframes):
                np_root.pose(name, f)
                np_root.update(force=True)
                for j in joints:
                    t, r, s = decompose(panda_mat_to_gltf(j.getValue()))
                    T, R, S = tracks[j.getName()]
                    T.extend(t); R.extend(r); S.extend(s)

            tacc = gltf.floats(times, 1)
            samplers, channels = [], []
            for j in joints:
                T, R, S = tracks[j.getName()]
                node_i = base_i + joint_index[j.getName()]
                for path, vals, comps in (("translation", T, 3),
                                          ("rotation", R, 4),
                                          ("scale", S, 3)):
                    samplers.append({"input": tacc, "interpolation": "LINEAR",
                                     "output": gltf.floats(vals, comps)})
                    channels.append({"sampler": len(samplers) - 1,
                                     "target": {"node": node_i, "path": path}})
            gltf.json["animations"].append({"name": name, "samplers": samplers,
                                            "channels": channels})

    size = gltf.write(args.out)
    kept = sum(len(b["pos"]) // 3 for b in buckets.values())
    print("%-16s %6.2f MB  %7d verts (welded %d away)  %6d tris  %2d joints  %d anims  %d prims"
          % (os.path.basename(args.out), size / 1048576, kept, total_welded[0], total_t,
             len(joints), len(gltf.json.get("animations", [])), len(primitives)))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--model", help="static model path (Panda-relative, no extension)")
    g.add_argument("--actor", help="animated character path")
    ap.add_argument("--anim", action="append", help="name=path, repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=1.0,
                    help="baked into vertices; use the game's runtime setScale")
    ap.add_argument("--texture", help="texture applied at runtime, not stored in the egg")
    ap.add_argument("--model-path", default=".", help="directory the assets live in")
    ap.add_argument("--no-weld", action="store_true", help="keep duplicate vertices")
    ap.add_argument("--max-texture", type=int, default=0,
                    help="downscale embedded textures to this many pixels on the long edge")
    ap.add_argument("--smooth-weld", action="store_true",
                    help="weld by position and average normals; much smaller, smooth-shaded")
    args = ap.parse_args()
    loadPrcFileData("", "model-path %s" % os.path.abspath(args.model_path))
    export(args)


if __name__ == "__main__":
    main()
