/**
 * Offline three-mesh-bvh Global Illumination & Contact Shadow Baker.
 * Builds the static studio & Halogen III machine geometry into a unified MeshBVH,
 * ray-traces contact occlusion + 2-bounce diffuse indirect GI (including emissive LED strips),
 * denoises with a geometry-aware bilateral filter, and exports:
 *   - public/gi/static-ao.png
 *   - public/gi/static-lightmap.png
 *   - public/gi/static-layout.json
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { defineGame, installNodeHost } from "@threert/gameplay";
import {
  Engine,
  LightDesc,
  MaterialDesc,
  ObjectDesc,
  PerspectiveCamera,
  Scene,
} from "@threert/scene";
import {
  buildStaticChartUv1,
  inferUnpackMode,
  StaticChartEntry,
  StaticGiLayout,
  UvUnpackMode,
} from "../src/gi/lightmapAtlas";

// ---------------------------------------------------------------------------
// Minimal Canvas/Document Stub for Procedural @threert/scene Texture Calls
// ---------------------------------------------------------------------------
function installCanvasStub() {
  const noop = () => {};
  const gradStub = () => ({ addColorStop: noop });
  const ctxStub = {
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    arc: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    fillText: noop,
    createLinearGradient: gradStub,
    createRadialGradient: gradStub,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
    }),
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 64,
      height: 64,
      getContext: () => ctxStub,
    }),
  };
}

// ---------------------------------------------------------------------------
// PNG Encoder (pure Node zlib, RGBA top-down -> standard PNG)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(4 + 4 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crc, 8 + data.length);
  return chunk;
}

function encodeRgbaPng(width: number, height: number, rgbaTopDown: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    Buffer.from(rgbaTopDown.subarray(y * stride, (y + 1) * stride)).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Collector Engine capturing @threert/scene Static Geometry & Lights
// ---------------------------------------------------------------------------
interface RawGeom {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: Uint32Array | null;
}

interface RawObj {
  id: number;
  desc: ObjectDesc;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  worldMatrix: THREE.Matrix4;
}

class BakeSceneCollector implements Engine {
  geometries = new Map<number, RawGeom>();
  materials = new Map<number, MaterialDesc>();
  objects = new Map<number, RawObj>();

  geometry(
    id: number,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    groups?: Uint32Array | null,
  ): void {
    this.geometries.set(id, {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
      groups: groups ? new Uint32Array(groups) : null,
    });
  }

  material(id: number, desc: MaterialDesc): void {
    this.materials.set(id, desc);
  }

  object(id: number, desc: ObjectDesc): void {
    this.objects.set(id, {
      id,
      desc,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(1, 1, 1),
      worldMatrix: new THREE.Matrix4(),
    });
  }

  transform(id: number, trs: Float32Array): void {
    const o = this.objects.get(id);
    if (!o) return;
    o.pos.set(trs[0], trs[1], trs[2]);
    o.quat.set(trs[3], trs[4], trs[5], trs[6]);
    o.scale.set(trs[7], trs[8], trs[9]);
  }

  light(_id: number, _desc: LightDesc): void {}
  texture(): void {}
  shader(): void {}
  visible(): void {}
  power(): void {}
  camera(): void {}
  cameraActive(): void {}
  environment(): void {}
  settings(): void {}
  particleFunction(): void {}
  particleProgram(): void {}
  particlesSpawn(): void {}
  volumeFunction(): void {}
  physics(): string {
    return "null";
  }
  gridProgram(): void {}
  densityGrid(): void {}
  gridSources(): void {}
  geometryFunction(): void {}
  procedural(): void {}
  proceduralAsset(): void {}
  customData(): void {}
  sway(): void {}
  animation(): void {}
  instances(): void {}

  computeWorldMatrices(): void {
    const cache = new Map<number, THREE.Matrix4>();
    const localMat = new THREE.Matrix4();
    const resolve = (id: number): THREE.Matrix4 => {
      const cached = cache.get(id);
      if (cached) return cached;
      const o = this.objects.get(id);
      if (!o) return new THREE.Matrix4();
      localMat.compose(o.pos, o.quat, o.scale);
      const m = localMat.clone();
      if (o.desc.parent !== null) {
        m.premultiply(resolve(o.desc.parent));
      }
      cache.set(id, m);
      o.worldMatrix.copy(m);
      return m;
    };
    for (const id of this.objects.keys()) {
      resolve(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic Shelf Packing for 1024x1024 Atlas (UV bottom-up; neutral corner at (0,0))
// ---------------------------------------------------------------------------
interface ChartRequest {
  name: string;
  tileW: number;
  tileH: number;
  unpackMode: UvUnpackMode;
  geom: RawGeom;
  obj: RawObj;
  mat: MaterialDesc;
}

function getTileSize(name: string): [number, number] {
  if (name === "static:backdrop_wall") return [1016, 152];
  if (name === "static:studio_floor") return [464, 464];
  if (name === "static:conical_base") return [224, 224];
  if (name === "static:tier_black_all" || name === "static:tier_white_all") return [384, 56];
  if (name === "static:signs_all") return [240, 112];
  if (name === "static:white_arch_all") return [192, 128];
  if (name === "static:track_clamps_all") return [112, 84];
  if (name === "static:ceiling_cans_all" || name === "static:track_rings_all") return [80, 60];
  if (name === "static:stage_rings_all") return [40, 20];
  if (name.startsWith("static:shoulder_wing")) return [128, 128];
  if (name.startsWith("static:tier_")) return [248, 40];
  if (name.startsWith("static:sign_")) return [48, 28];
  if (
    name === "static:podium_disc" ||
    name === "static:platter_top_deck" ||
    name === "static:platter_lower_rim" ||
    name === "static:platter_inner_bevel"
  ) {
    return [96, 96];
  }
  if (
    name === "static:horseshoe_arch" ||
    name.startsWith("static:horseshoe_arm") ||
    name.startsWith("static:jaw_collar") ||
    name === "static:apex_housing" ||
    name === "static:crown_neck_flange"
  ) {
    return [72, 72];
  }
  if (
    name === "static:pocket_funnel" ||
    name === "static:pocket_rim" ||
    name === "static:base_chrome_ring" ||
    name === "static:neck_shadow_collar" ||
    name === "static:ceiling_light_rail"
  ) {
    return [48, 48];
  }
  return [20, 20];
}

function packAtlasCharts(
  atlasSize: number,
  requests: ChartRequest[],
): Map<string, [number, number, number, number]> {
  const rects = new Map<string, [number, number, number, number]>();
  // Reserve 16x16 bottom-left corner [0..16, 0..16] for neutral dynamic sampling (u=0.002, v=0.002)
  const pad = 2;
  const sorted = [...requests].sort((a, b) => b.tileH - a.tileH || b.tileW - a.tileW);

  let cursorX = 16 + pad;
  let cursorY = 0 + pad;
  let shelfH = 0;

  for (const req of sorted) {
    if (cursorX + req.tileW + pad > atlasSize) {
      cursorX = pad;
      cursorY += shelfH + pad;
      shelfH = 0;
    }
    if (cursorY + req.tileH + pad > atlasSize) {
      throw new Error(`Atlas overflow while packing ${req.name} at (${cursorX}, ${cursorY})`);
    }
    const u0 = (cursorX + 0.5) / atlasSize;
    const v0 = (cursorY + 0.5) / atlasSize;
    const u1 = (cursorX + req.tileW - 0.5) / atlasSize;
    const v1 = (cursorY + req.tileH - 0.5) / atlasSize;
    rects.set(req.name, [u0, v0, u1, v1]);

    cursorX += req.tileW + pad;
    shelfH = Math.max(shelfH, req.tileH);
  }

  return rects;
}

// ---------------------------------------------------------------------------
// Fast Stratified Cosine-Weighted Hemisphere Sampling & Hash RNG
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildOrthonormalBasis(n: THREE.Vector3, tOut: THREE.Vector3, bOut: THREE.Vector3) {
  if (Math.abs(n.x) > 0.9) {
    tOut.set(0, 1, 0);
  } else {
    tOut.set(1, 0, 0);
  }
  tOut.crossVectors(tOut, n).normalize();
  bOut.crossVectors(n, tOut).normalize();
}

function sampleCosineHemisphere(
  u1: number,
  u2: number,
  n: THREE.Vector3,
  t: THREE.Vector3,
  b: THREE.Vector3,
  out: THREE.Vector3,
) {
  const r = Math.sqrt(u1);
  const phi = 2 * Math.PI * u2;
  const x = r * Math.cos(phi);
  const y = r * Math.sin(phi);
  const z = Math.sqrt(Math.max(0, 1 - u1));
  out
    .set(0, 0, 0)
    .addScaledVector(t, x)
    .addScaledVector(b, y)
    .addScaledVector(n, z)
    .normalize();
}

// ---------------------------------------------------------------------------
// Main Offline BVH Bake Routine
// ---------------------------------------------------------------------------
async function main() {
  const tStart = performance.now();
  installCanvasStub();

  const { createStudio } = await import("../src/studio/createStudio");
  const { createHalogenMachine } = await import("../src/machine/createHalogenMachine");

  const collector = new BakeSceneCollector();
  const game = defineGame({
    seed: 1,
    state: {},
    setup() {
      const scene = new Scene();
      const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 160);
      const studio = createStudio();
      scene.add(studio.group);
      const machine = createHalogenMachine();
      scene.add(machine.root);
      return { scene, camera };
    },
    handlers: {},
  });

  const host = installNodeHost(game as never, collector);
  host.setup("bake-gi");
  collector.computeWorldMatrices();

  const ATLAS_SIZE = 1024;
  const requests: ChartRequest[] = [];
  const staticMeshes: Array<{
    name: string;
    geom: RawGeom;
    obj: RawObj;
    mat: MaterialDesc;
    isEmitter: boolean;
    uv1: Float32Array | null;
  }> = [];

  for (const obj of collector.objects.values()) {
    if (obj.desc.kind !== "mesh") continue;
    const geom = collector.geometries.get(obj.desc.geometry);
    const mat = collector.materials.get(obj.desc.material);
    if (!geom || !mat) continue;

    const isStaticTarget = obj.desc.name.startsWith("static:");
    const isEmitter =
      !mat.transparent &&
      !mat.name.toLowerCase().startsWith("additive:") &&
      mat.emissiveIntensity > 0.4;

    if (!isStaticTarget && !isEmitter) continue;

    staticMeshes.push({
      name: obj.desc.name,
      geom,
      obj,
      mat,
      isEmitter,
      uv1: null,
    });

    if (isStaticTarget) {
      const unpackMode = inferUnpackMode(geom.normals, geom.indices, geom.groups);
      const [tileW, tileH] = getTileSize(obj.desc.name);
      requests.push({
        name: obj.desc.name,
        tileW,
        tileH,
        unpackMode,
        geom,
        obj,
        mat,
      });
    }
  }

  console.log(
    `[bakeStaticGI] Collected ${requests.length} static baked meshes + ${staticMeshes.length - requests.length} emitter meshes.`,
  );

  const rects = packAtlasCharts(ATLAS_SIZE, requests);
  const layout: StaticGiLayout = {
    atlasSize: ATLAS_SIZE,
    neutralUv: [0.002, 0.002],
    charts: {},
  };

  for (const req of requests) {
    const rect = rects.get(req.name)!;
    const uv1 = buildStaticChartUv1(
      req.geom.normals,
      req.geom.uvs,
      req.geom.indices,
      rect,
      req.unpackMode,
      req.geom.groups,
    );
    const sm = staticMeshes.find((m) => m.name === req.name)!;
    sm.uv1 = uv1;
    layout.charts[req.name] = {
      vertexCount: req.geom.positions.length / 3,
      rect,
      unpackMode: req.unpackMode,
    };
  }

  // Merge all static + emitter triangles into one world-space BufferGeometry for MeshBVH
  let totalVerts = 0;
  let totalIndices = 0;
  for (const sm of staticMeshes) {
    totalVerts += sm.geom.positions.length / 3;
    totalIndices += sm.geom.indices.length;
  }

  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedNorm = new Float32Array(totalVerts * 3);
  const mergedUv1 = new Float32Array(totalVerts * 2);
  const mergedIndices = new Uint32Array(totalIndices);
  const triMeshId = new Int32Array(totalIndices / 3);

  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const normMat = new THREE.Matrix3();
  let vertOffset = 0;
  let idxOffset = 0;

  for (let mIdx = 0; mIdx < staticMeshes.length; mIdx++) {
    const sm = staticMeshes[mIdx];
    const g = sm.geom;
    const vCount = g.positions.length / 3;
    normMat.getNormalMatrix(sm.obj.worldMatrix);

    for (let v = 0; v < vCount; v++) {
      tmpV
        .set(g.positions[v * 3], g.positions[v * 3 + 1], g.positions[v * 3 + 2])
        .applyMatrix4(sm.obj.worldMatrix);
      tmpN
        .set(g.normals[v * 3], g.normals[v * 3 + 1], g.normals[v * 3 + 2])
        .applyMatrix3(normMat)
        .normalize();

      const dv = vertOffset + v;
      mergedPos[dv * 3] = tmpV.x;
      mergedPos[dv * 3 + 1] = tmpV.y;
      mergedPos[dv * 3 + 2] = tmpV.z;
      mergedNorm[dv * 3] = tmpN.x;
      mergedNorm[dv * 3 + 1] = tmpN.y;
      mergedNorm[dv * 3 + 2] = tmpN.z;

      if (sm.uv1) {
        mergedUv1[dv * 2] = sm.uv1[v * 2];
        mergedUv1[dv * 2 + 1] = sm.uv1[v * 2 + 1];
      } else {
        mergedUv1[dv * 2] = 0.002;
        mergedUv1[dv * 2 + 1] = 0.002;
      }
    }

    const triCount = g.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = g.indices[t * 3] + vertOffset;
      const i1 = g.indices[t * 3 + 1] + vertOffset;
      const i2 = g.indices[t * 3 + 2] + vertOffset;
      mergedIndices[idxOffset + t * 3] = i0;
      mergedIndices[idxOffset + t * 3 + 1] = i1;
      mergedIndices[idxOffset + t * 3 + 2] = i2;
      triMeshId[idxOffset / 3 + t] = mIdx;
    }

    vertOffset += vCount;
    idxOffset += g.indices.length;
  }

  const mergedGeo = new THREE.BufferGeometry();
  mergedGeo.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
  mergedGeo.setAttribute("normal", new THREE.BufferAttribute(mergedNorm, 3));
  mergedGeo.setAttribute("uv1", new THREE.BufferAttribute(mergedUv1, 2));
  mergedGeo.setIndex(new THREE.BufferAttribute(mergedIndices, 1));

  const bvh = new MeshBVH(mergedGeo, { indirect: true });
  console.log(
    `[bakeStaticGI] Built MeshBVH (${totalIndices / 3} tris) in ${(performance.now() - tStart).toFixed(0)}ms`,
  );

  // Rasterize occupied texels across static chart triangles
  const texCount = ATLAS_SIZE * ATLAS_SIZE;
  const texOccupied = new Uint8Array(texCount);
  const texPos = new Float32Array(texCount * 3);
  const texNorm = new Float32Array(texCount * 3);
  const texChartId = new Int32Array(texCount).fill(-1);

  for (let t = 0; t < totalIndices / 3; t++) {
    const mIdx = triMeshId[t];
    const sm = staticMeshes[mIdx];
    if (!sm.uv1) continue; // skip pure emitters for target texel baking

    const i0 = mergedIndices[t * 3];
    const i1 = mergedIndices[t * 3 + 1];
    const i2 = mergedIndices[t * 3 + 2];

    const u0 = mergedUv1[i0 * 2] * ATLAS_SIZE;
    const v0 = mergedUv1[i0 * 2 + 1] * ATLAS_SIZE;
    const u1 = mergedUv1[i1 * 2] * ATLAS_SIZE;
    const v1 = mergedUv1[i1 * 2 + 1] * ATLAS_SIZE;
    const u2 = mergedUv1[i2 * 2] * ATLAS_SIZE;
    const v2 = mergedUv1[i2 * 2 + 1] * ATLAS_SIZE;

    const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (Math.abs(area) < 1e-6) continue;

    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2)));
    const maxX = Math.min(ATLAS_SIZE - 1, Math.ceil(Math.max(u0, u1, u2)));
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2)));
    const maxY = Math.min(ATLAS_SIZE - 1, Math.ceil(Math.max(v0, v1, v2)));
    const invArea = 1 / area;

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = ((u1 - cx) * (v2 - cy) - (u2 - cx) * (v1 - cy)) * invArea;
        const w1 = ((u2 - cx) * (v0 - cy) - (u0 - cx) * (v2 - cy)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.18 || w1 < -0.18 || w2 < -0.18) continue;

        // Clamp slightly outside edges inward onto triangle for clean border texels
        const cw0 = Math.max(0, w0);
        const cw1 = Math.max(0, w1);
        const cw2 = Math.max(0, w2);
        const wSum = cw0 + cw1 + cw2 || 1;
        const b0 = cw0 / wSum;
        const b1 = cw1 / wSum;
        const b2 = cw2 / wSum;

        // Top-down image Y = (ATLAS_SIZE - 1 - py) or store bottom-up & flip cleanly on PNG export
        const ti = py * ATLAS_SIZE + px;
        if (texOccupied[ti] && w0 >= 0 && w1 >= 0 && w2 >= 0) {
          // Exact interior overwrites edge fallback
        } else if (texOccupied[ti]) {
          continue;
        }
        texOccupied[ti] = 1;
        texChartId[ti] = mIdx;

        texPos[ti * 3] =
          mergedPos[i0 * 3] * b0 + mergedPos[i1 * 3] * b1 + mergedPos[i2 * 3] * b2;
        texPos[ti * 3 + 1] =
          mergedPos[i0 * 3 + 1] * b0 + mergedPos[i1 * 3 + 1] * b1 + mergedPos[i2 * 3 + 1] * b2;
        texPos[ti * 3 + 2] =
          mergedPos[i0 * 3 + 2] * b0 + mergedPos[i1 * 3 + 2] * b1 + mergedPos[i2 * 3 + 2] * b2;

        const nx =
          mergedNorm[i0 * 3] * b0 + mergedNorm[i1 * 3] * b1 + mergedNorm[i2 * 3] * b2;
        const ny =
          mergedNorm[i0 * 3 + 1] * b0 + mergedNorm[i1 * 3 + 1] * b1 + mergedNorm[i2 * 3 + 1] * b2;
        const nz =
          mergedNorm[i0 * 3 + 2] * b0 + mergedNorm[i1 * 3 + 2] * b1 + mergedNorm[i2 * 3 + 2] * b2;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        texNorm[ti * 3] = nx / nLen;
        texNorm[ti * 3 + 1] = ny / nLen;
        texNorm[ti * 3 + 2] = nz / nLen;
      }
    }
  }

  let occupiedCount = 0;
  for (let i = 0; i < texCount; i++) {
    if (texOccupied[i]) occupiedCount++;
  }
  console.log(`[bakeStaticGI] Rasterized ${occupiedCount} chart texels.`);

  const pass1Irrad = new Float32Array(texCount * 3);
  const pass2Gi = new Float32Array(texCount * 3);
  const aoBuffer = new Float32Array(texCount).fill(1.0);

  const keyDir = new THREE.Vector3(3.4, 8.6 - 2.8, 7.8).normalize();
  const fillDir = new THREE.Vector3(-5.0, 5.4 - 2.8, -5.8).normalize();
  const orangePos = new THREE.Vector3(0, 1.674, 0);
  const ceilingSpots = Array.from({ length: 12 }, (_, i) => {
    const theta = (i / 12) * Math.PI * 2;
    const pos = new THREE.Vector3(Math.sin(theta) * 12.15, 8.80, -Math.cos(theta) * 12.15);
    const target = new THREE.Vector3(Math.sin(theta) * 14.48, 4.85, -Math.cos(theta) * 14.48);
    const aim = target.clone().sub(pos).normalize();
    return { pos, aim };
  });
  const drumUpPos = new THREE.Vector3(0, 1.84, 0.25);
  const drumUpAim = new THREE.Vector3(0, 1, -0.08).normalize();

  const ray = new THREE.Ray();
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const T = new THREE.Vector3();
  const B = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const lightVec = new THREE.Vector3();
  const rng = makeRng(20261116);

  const SAMPLES_PASS1 = 24;
  const SAMPLES_BOUNCE = 24;

  // Helper to get mesh effective base radiance (emissive + albedo estimate)
  const meshEmissive = staticMeshes.map((sm) => {
    const e = sm.mat.emissive;
    let ei = sm.mat.emissiveIntensity;
    if (sm.name === "static:backdrop_wall") ei *= 0.8;
    return [e[0] * ei, e[1] * ei, e[2] * ei] as const;
  });
  const meshAlbedo = staticMeshes.map((sm) => sm.mat.color);

  // Ignore the 360° outer cyclorama wall cylinder when testing key/fill directional visibility
  const isDirectionalOccluded = (
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    dirVec: THREE.Vector3,
  ): boolean => {
    let tMin = 0.002;
    ray.origin.copy(origin).addScaledVector(normal, 0.006);
    ray.direction.copy(dirVec);
    for (let step = 0; step < 3; step++) {
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, tMin, 24.0);
      if (!hit) return false;
      const hitName =
        hit.faceIndex !== undefined ? staticMeshes[triMeshId[hit.faceIndex]]?.name : undefined;
      if (
        hitName === "static:backdrop_wall" ||
        hitName === "static:ceiling_light_rail" ||
        hitName === "static:ceiling_cans_all"
      ) {
        tMin = hit.distance + 0.02;
        continue;
      }
      return true;
    }
    return false;
  };

  // PASS 1: Contact Shadow AO + Direct Light Visibility + First-Order Emissive Radiance
  for (let ti = 0; ti < texCount; ti++) {
    if (!texOccupied[ti]) continue;
    P.set(texPos[ti * 3], texPos[ti * 3 + 1], texPos[ti * 3 + 2]);
    N.set(texNorm[ti * 3], texNorm[ti * 3 + 1], texNorm[ti * 3 + 2]);
    buildOrthonormalBasis(N, T, B);

    let occSum = 0;
    let irR = 0;
    let irG = 0;
    let irB = 0;

    // 1a. Cosine hemisphere rays for Contact Shadow AO + Ceiling Sky + Direct Emissives
    for (let s = 0; s < SAMPLES_PASS1; s++) {
      const u1 = (s + rng()) / SAMPLES_PASS1;
      const u2 = rng();
      sampleCosineHemisphere(u1, u2, N, T, B, dir);

      ray.origin.copy(P).addScaledVector(N, 0.005);
      ray.direction.copy(dir);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, 16.0);

      if (hit) {
        // Short-range contact shadow + broad cavity occlusion
        if (hit.distance < 1.5) {
          occSum += 1 - hit.distance / 1.5;
        } else if (hit.distance < 6.0) {
          occSum += 0.18 * (1 - (hit.distance - 1.5) / 4.5);
        }

        if (hit.faceIndex !== undefined) {
          const hitMeshIdx = triMeshId[hit.faceIndex];
          const em = meshEmissive[hitMeshIdx];
          if (em[0] > 0 || em[1] > 0 || em[2] > 0) {
            // Distance attenuation from emissive fixtures so nearby surfaces catch colored LED glow
            const atten = 1 / (1 + 0.14 * hit.distance * hit.distance);
            irR += em[0] * atten;
            irG += em[1] * atten;
            irB += em[2] * atten;
          }
        }
      } else {
        // Clean studio ceiling softbox ambient so pearl cyclorama stays bright while spotlights pop
        const skyT = Math.max(0, dir.y * 0.65 + 0.35);
        irR += 0.25 * skyT;
        irG += 0.26 * skyT;
        irB += 0.30 * skyT;
      }
    }

    const invS = 1 / SAMPLES_PASS1;
    aoBuffer[ti] = Math.max(0.14, 1 - occSum * invS * 1.15);
    irR *= invS;
    irG *= invS;
    irB *= invS;

    // 1b. Key directional light shadow test (for indirect bounce source accuracy)
    const keyDot = Math.max(0, N.dot(keyDir));
    if (keyDot > 0.01 && !isDirectionalOccluded(P, N, keyDir)) {
      irR += 1.45 * keyDot;
      irG += 1.38 * keyDot;
      irB += 1.24 * keyDot;
    }

    // 1c. Fill directional light bounce seed
    const fillDot = Math.max(0, N.dot(fillDir));
    if (fillDot > 0.01 && !isDirectionalOccluded(P, N, fillDir)) {
      irR += 0.55 * fillDot;
      irG += 0.57 * fillDot;
      irB += 0.65 * fillDot;
    }

    // 1d. Ring sampling of the 360-degree amber-orange LED platter rim (warm floor & pedestal bounce!)
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2 + rng() * 0.4;
      lightVec.set(
        orangePos.x + Math.cos(ang) * 1.14 - P.x,
        orangePos.y - P.y,
        orangePos.z + Math.sin(ang) * 1.14 - P.z,
      );
      const dist = lightVec.length();
      if (dist > 0.05 && dist < 4.5) {
        lightVec.multiplyScalar(1 / dist);
        const ndl = Math.max(0, N.dot(lightVec));
        if (ndl > 0.01) {
          ray.origin.copy(P).addScaledVector(N, 0.006);
          ray.direction.copy(lightVec);
          const oHit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, dist - 0.06);
          if (!oHit) {
            const atten = (ndl / (1 + 1.4 * dist * dist)) * 0.55;
            irR += 1.65 * atten;
            irG += 0.58 * atten;
            irB += 0.14 * atten;
          }
        }
      }
    }

    // 1e. Overhead studio wall-grazing spotlights (crisp scalloped studio cones + clean neutral-warm white)
    for (const sp of ceilingSpots) {
      lightVec.set(
        sp.pos.x + (rng() - 0.5) * 0.12 - P.x,
        sp.pos.y - P.y,
        sp.pos.z + (rng() - 0.5) * 0.12 - P.z,
      );
      const dist = lightVec.length();
      if (dist > 0.2 && dist < 13.5) {
        lightVec.multiplyScalar(1 / dist);
        const ndl = Math.max(0, N.dot(lightVec));
        const cosBeam = Math.max(0, -lightVec.dot(sp.aim));
        const tCone = Math.max(0, Math.min(1, (cosBeam - 0.76) / (0.96 - 0.76)));
        const coneWeight = Math.pow(tCone * tCone * (3 - 2 * tCone), 1.25);
        if (ndl > 0.02 && coneWeight > 0.01) {
          ray.origin.copy(P).addScaledVector(N, 0.006);
          ray.direction.copy(lightVec);
          const sHit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, dist - 0.18);
          if (!sHit) {
            const atten = (ndl * coneWeight / (1 + 0.035 * dist * dist)) * 10.5;
            irR += 1.04 * atten;
            irG += 1.02 * atten;
            irB += 0.98 * atten;
          }
        }
      }
    }

    // 1f. Interior central machine uplight bounce onto crown, upper shoulders & arches
    lightVec.subVectors(drumUpPos, P);
    const upDist = lightVec.length();
    if (upDist > 0.15 && upDist < 5.5) {
      lightVec.multiplyScalar(1 / upDist);
      const ndl = Math.max(0, N.dot(lightVec));
      const cosUp = Math.max(0, -lightVec.dot(drumUpAim));
      const coneUp = Math.max(0, (cosUp - 0.45) / 0.55);
      if (ndl > 0.02 && coneUp > 0.01) {
        ray.origin.copy(P).addScaledVector(N, 0.006);
        ray.direction.copy(lightVec);
        const uHit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, upDist - 0.08);
        if (!uHit) {
          const atten = (ndl * coneUp / (1 + 0.35 * upDist * upDist)) * 1.4;
          irR += 0.92 * atten;
          irG += 0.96 * atten;
          irB += 1.05 * atten;
        }
      }
    }

    pass1Irrad[ti * 3] = irR;
    pass1Irrad[ti * 3 + 1] = irG;
    pass1Irrad[ti * 3 + 2] = irB;
  }

  console.log(
    `[bakeStaticGI] Pass 1 (AO + direct/emissive) done in ${((performance.now() - tStart) / 1000).toFixed(1)}s`,
  );

  // PASS 2: Indirect Multi-Bounce Colored Diffuse GI via MeshBVH
  const bV0 = new THREE.Vector3();
  const bV1 = new THREE.Vector3();
  const bV2 = new THREE.Vector3();
  const bP = new THREE.Vector3();
  const edge0 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const vp = new THREE.Vector3();

  for (let ti = 0; ti < texCount; ti++) {
    if (!texOccupied[ti]) continue;
    P.set(texPos[ti * 3], texPos[ti * 3 + 1], texPos[ti * 3 + 2]);
    N.set(texNorm[ti * 3], texNorm[ti * 3 + 1], texNorm[ti * 3 + 2]);
    buildOrthonormalBasis(N, T, B);

    let gR = 0;
    let gG = 0;
    let gB = 0;

    for (let s = 0; s < SAMPLES_BOUNCE; s++) {
      const u1 = (s + rng()) / SAMPLES_BOUNCE;
      const u2 = rng();
      sampleCosineHemisphere(u1, u2, N, T, B, dir);

      ray.origin.copy(P).addScaledVector(N, 0.005);
      ray.direction.copy(dir);
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, 18.0);

      if (hit && hit.faceIndex !== undefined) {
        const hitMeshIdx = triMeshId[hit.faceIndex];
        const em = meshEmissive[hitMeshIdx];
        const alb = meshAlbedo[hitMeshIdx];

        // Evaluate hit texel's Pass-1 radiance via hit triangle barycentrics
        const fBase = hit.faceIndex * 3;
        const i0 = mergedIndices[fBase];
        const i1 = mergedIndices[fBase + 1];
        const i2 = mergedIndices[fBase + 2];

        bV0.set(mergedPos[i0 * 3], mergedPos[i0 * 3 + 1], mergedPos[i0 * 3 + 2]);
        bV1.set(mergedPos[i1 * 3], mergedPos[i1 * 3 + 1], mergedPos[i1 * 3 + 2]);
        bV2.set(mergedPos[i2 * 3], mergedPos[i2 * 3 + 1], mergedPos[i2 * 3 + 2]);
        bP.copy(hit.point);

        edge0.subVectors(bV1, bV0);
        edge1.subVectors(bV2, bV0);
        vp.subVectors(bP, bV0);
        const d00 = edge0.dot(edge0);
        const d01 = edge0.dot(edge1);
        const d11 = edge1.dot(edge1);
        const d20 = vp.dot(edge0);
        const d21 = vp.dot(edge1);
        const denom = d00 * d11 - d01 * d01;
        let vW = 0.33;
        let wW = 0.33;
        if (Math.abs(denom) > 1e-8) {
          vW = Math.max(0, Math.min(1, (d11 * d20 - d01 * d21) / denom));
          wW = Math.max(0, Math.min(1, (d00 * d21 - d01 * d20) / denom));
        }
        const uW = Math.max(0, 1 - vW - wW);

        const hu = Math.max(
          0,
          Math.min(
            ATLAS_SIZE - 1,
            Math.floor(
              (mergedUv1[i0 * 2] * uW + mergedUv1[i1 * 2] * vW + mergedUv1[i2 * 2] * wW) *
                ATLAS_SIZE,
            ),
          ),
        );
        const hv = Math.max(
          0,
          Math.min(
            ATLAS_SIZE - 1,
            Math.floor(
              (mergedUv1[i0 * 2 + 1] * uW +
                mergedUv1[i1 * 2 + 1] * vW +
                mergedUv1[i2 * 2 + 1] * wW) *
                ATLAS_SIZE,
            ),
          ),
        );
        const hTi = hv * ATLAS_SIZE + hu;
        const bounceR = em[0] + alb[0] * pass1Irrad[hTi * 3];
        const bounceG = em[1] + alb[1] * pass1Irrad[hTi * 3 + 1];
        const bounceB = em[2] + alb[2] * pass1Irrad[hTi * 3 + 2];

        const falloff = 1 / (1 + 0.04 * hit.distance * hit.distance);
        gR += bounceR * falloff;
        gG += bounceG * falloff;
        gB += bounceB * falloff;
      } else {
        // Subtle studio dome indirect ambient skylight
        const skyT = Math.max(0, dir.y * 0.6 + 0.4);
        gR += 0.24 * skyT;
        gG += 0.25 * skyT;
        gB += 0.30 * skyT;
      }
    }

    const invB = 1 / SAMPLES_BOUNCE;
    // Combine emissive/bounce indirect irradiance with local orange platter accent
    pass2Gi[ti * 3] = Math.min(1.8, gR * invB * 0.85 + pass1Irrad[ti * 3] * 0.22);
    pass2Gi[ti * 3 + 1] = Math.min(1.8, gG * invB * 0.85 + pass1Irrad[ti * 3 + 1] * 0.22);
    pass2Gi[ti * 3 + 2] = Math.min(1.8, gB * invB * 0.85 + pass1Irrad[ti * 3 + 2] * 0.22);
  }

  console.log(
    `[bakeStaticGI] Pass 2 (indirect GI) done in ${((performance.now() - tStart) / 1000).toFixed(1)}s`,
  );

  // Geometry-aware 3x3 Bilateral Denoise (2 iterations)
  let srcAo = aoBuffer;
  let dstAo = new Float32Array(texCount);
  let srcGi = pass2Gi;
  let dstGi = new Float32Array(texCount * 3);

  for (let iter = 0; iter < 2; iter++) {
    for (let y = 0; y < ATLAS_SIZE; y++) {
      for (let x = 0; x < ATLAS_SIZE; x++) {
        const ti = y * ATLAS_SIZE + x;
        if (!texOccupied[ti]) continue;
        const cid = texChartId[ti];
        const nx = texNorm[ti * 3];
        const ny = texNorm[ti * 3 + 1];
        const nz = texNorm[ti * 3 + 2];

        let wSum = 0;
        let aSum = 0;
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;

        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ATLAS_SIZE) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= ATLAS_SIZE) continue;
            const nti = yy * ATLAS_SIZE + xx;
            if (!texOccupied[nti] || texChartId[nti] !== cid) continue;
            const ndot =
              nx * texNorm[nti * 3] + ny * texNorm[nti * 3 + 1] + nz * texNorm[nti * 3 + 2];
            if (ndot < 0.85) continue;
            const w = dx === 0 && dy === 0 ? 2.0 : dx === 0 || dy === 0 ? 1.0 : 0.7;
            wSum += w;
            aSum += srcAo[nti] * w;
            rSum += srcGi[nti * 3] * w;
            gSum += srcGi[nti * 3 + 1] * w;
            bSum += srcGi[nti * 3 + 2] * w;
          }
        }

        const invW = 1 / (wSum || 1);
        dstAo[ti] = aSum * invW;
        dstGi[ti * 3] = rSum * invW;
        dstGi[ti * 3 + 1] = gSum * invW;
        dstGi[ti * 3 + 2] = bSum * invW;
      }
    }
    const tmpA = srcAo;
    srcAo = dstAo;
    dstAo = tmpA;
    const tmpG = srcGi;
    srcGi = dstGi;
    dstGi = tmpG;
  }

  // 2-pass gutter dilation so UV seams never sample unbaked dark pixels
  const dilatedOcc = new Uint8Array(texOccupied);
  for (let dPass = 0; dPass < 2; dPass++) {
    const nextOcc = new Uint8Array(dilatedOcc);
    const nextAo = new Float32Array(srcAo);
    const nextGi = new Float32Array(srcGi);
    for (let y = 0; y < ATLAS_SIZE; y++) {
      for (let x = 0; x < ATLAS_SIZE; x++) {
        const ti = y * ATLAS_SIZE + x;
        if (dilatedOcc[ti]) continue;
        // Never overwrite neutral [0..16, 0..16] dynamic corner
        if (x < 16 && y < 16) continue;

        let count = 0;
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ATLAS_SIZE) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= ATLAS_SIZE) continue;
            const nti = yy * ATLAS_SIZE + xx;
            if (!dilatedOcc[nti]) continue;
            count++;
            a += srcAo[nti];
            r += srcGi[nti * 3];
            g += srcGi[nti * 3 + 1];
            b += srcGi[nti * 3 + 2];
          }
        }
        if (count > 0) {
          nextOcc[ti] = 1;
          nextAo[ti] = a / count;
          nextGi[ti * 3] = r / count;
          nextGi[ti * 3 + 1] = g / count;
          nextGi[ti * 3 + 2] = b / count;
        }
      }
    }
    dilatedOcc.set(nextOcc);
    srcAo = nextAo;
    srcGi = nextGi;
  }

  // Encode top-down PNG buffers (UV v=0 is bottom of image -> row ATLAS_SIZE - 1)
  const aoRgba = new Uint8Array(texCount * 4);
  const giRgba = new Uint8Array(texCount * 4);
  const toSrgbByte = (lin: number) => {
    const clamped = Math.max(0, Math.min(1, lin));
    const srgb =
      clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  };

  for (let py = 0; py < ATLAS_SIZE; py++) {
    const imgRow = ATLAS_SIZE - 1 - py;
    for (let px = 0; px < ATLAS_SIZE; px++) {
      const ti = py * ATLAS_SIZE + px;
      const outIdx = (imgRow * ATLAS_SIZE + px) * 4;

      if (px < 16 && py < 16) {
        // Safe neutral zone for dynamic/unbaked objects: AO = 1.0 (255), GI = 0.0 (0)
        aoRgba[outIdx] = 255;
        aoRgba[outIdx + 1] = 255;
        aoRgba[outIdx + 2] = 255;
        aoRgba[outIdx + 3] = 255;

        giRgba[outIdx] = 0;
        giRgba[outIdx + 1] = 0;
        giRgba[outIdx + 2] = 0;
        giRgba[outIdx + 3] = 255;
        continue;
      }

      const aoByte = Math.round(Math.max(0, Math.min(1, srcAo[ti])) * 255);
      aoRgba[outIdx] = aoByte;
      aoRgba[outIdx + 1] = aoByte;
      aoRgba[outIdx + 2] = aoByte;
      aoRgba[outIdx + 3] = 255;

      // Normalize GI smoothly into [0..1] (scale factor 1.5 restored by lightMapIntensity at runtime)
      giRgba[outIdx] = toSrgbByte(srcGi[ti * 3] / 1.5);
      giRgba[outIdx + 1] = toSrgbByte(srcGi[ti * 3 + 1] / 1.5);
      giRgba[outIdx + 2] = toSrgbByte(srcGi[ti * 3 + 2] / 1.5);
      giRgba[outIdx + 3] = 255;
    }
  }

  const outDir = path.resolve(process.cwd(), "public/gi");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "static-ao.png"), encodeRgbaPng(ATLAS_SIZE, ATLAS_SIZE, aoRgba));
  fs.writeFileSync(
    path.join(outDir, "static-lightmap.png"),
    encodeRgbaPng(ATLAS_SIZE, ATLAS_SIZE, giRgba),
  );
  fs.writeFileSync(
    path.join(outDir, "static-layout.json"),
    JSON.stringify(layout, null, 2),
  );

  console.log(
    `[bakeStaticGI] Wrote public/gi/{static-ao.png, static-lightmap.png, static-layout.json} in ${((performance.now() - tStart) / 1000).toFixed(2)}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
