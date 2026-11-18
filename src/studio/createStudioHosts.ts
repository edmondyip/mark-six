import * as THREE from "three";
import {
  Euler as SceneEuler,
  Group,
  Matrix4 as SceneMatrix4,
  Mesh,
  MeshBasicMaterial,
  MeshGeometry,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion as SceneQuaternion,
  Vector3 as SceneVector3,
} from "@threert/scene";
import {
  canvasToDataTexture,
  createRoundedBoxMeshGeometry,
  MergeGeometryPart,
  mergeSceneGeometries,
} from "../utils/procedural";

interface LatheRing {
  y: number;
  rx: number;
  rz: number;
  xOff?: number;
  zOff?: number;
}

interface HostBuckets {
  elderSuit: MergeGeometryPart[];
  elderShirt: MergeGeometryPart[];
  elderPants: MergeGeometryPart[];
  elderSkin: MergeGeometryPart[];
  whiteHair: MergeGeometryPart[];
  elderLip: MergeGeometryPart[];
  femaleSkin: MergeGeometryPart[];
  darkHairAndEyes: MergeGeometryPart[];
  pinkBlazer: MergeGeometryPart[];
  pinkSkirt: MergeGeometryPart[];
  whiteBlouse: MergeGeometryPart[];
  pinkAccent: MergeGeometryPart[];
}

const HOST_SCALE = 1.72;

/**
 * Extracts an indexed, smooth-shaded MeshGeometry while keeping shared vertices
 * so vertex normals stay smoothly interpolated across curved surfaces.
 */
function toSmoothMeshGeometry(src: THREE.BufferGeometry): MeshGeometry {
  if (!src.getAttribute("normal")) {
    src.computeVertexNormals();
  }
  const posAttr = src.getAttribute("position") as THREE.BufferAttribute;
  const normAttr = src.getAttribute("normal") as THREE.BufferAttribute;
  const uvAttr = src.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const idxAttr = src.getIndex();

  const positions = new Float32Array(posAttr.array as ArrayLike<number>);
  const normals = new Float32Array(normAttr.array as ArrayLike<number>);
  const uvs = uvAttr
    ? new Float32Array(uvAttr.array as ArrayLike<number>)
    : new Float32Array(posAttr.count * 2);
  const indices = idxAttr
    ? new Uint32Array(idxAttr.array as ArrayLike<number>)
    : Uint32Array.from({ length: posAttr.count }, (_, i) => i);

  for (let i = 0; i < uvs.length; i++) {
    uvs[i] = Math.max(0.01, Math.min(0.99, uvs[i]));
  }

  return new MeshGeometry(positions, indices, normals, uvs);
}

/**
 * Builds an indexed smooth lathe mesh with cylindrical side UVs and optional
 * separate bottom/top cap rings so side normals stay silky-smooth.
 */
function createSmoothLatheGeometry(
  rings: readonly LatheRing[],
  sides = 22,
  capBottom = true,
  capTop = true,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const ringCount = rings.length;
  const cols = sides + 1;

  for (let ri = 0; ri < ringCount; ri++) {
    const r = rings[ri];
    const xo = r.xOff ?? 0;
    const zo = r.zOff ?? 0;
    const v = 0.08 + 0.84 * (ri / Math.max(1, ringCount - 1));
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.push(xo + Math.cos(a) * r.rx, r.y, zo + Math.sin(a) * r.rz);
      uvs.push(0.02 + 0.96 * (s / sides), v);
    }
  }

  for (let ri = 0; ri < ringCount - 1; ri++) {
    const rowA = ri * cols;
    const rowB = (ri + 1) * cols;
    for (let s = 0; s < sides; s++) {
      const a = rowA + s;
      const b = rowB + s;
      const c = rowB + s + 1;
      const d = rowA + s + 1;
      indices.push(a, b, c, a, c, d);
    }
  }

  const sideGeo = new THREE.BufferGeometry();
  sideGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  sideGeo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  sideGeo.setIndex(indices);
  sideGeo.computeVertexNormals();

  // Weld seam normals across s=0 and s=sides so cylindrical wrap has zero normal crease
  const normAttr = sideGeo.getAttribute("normal") as THREE.BufferAttribute;
  for (let ri = 0; ri < ringCount; ri++) {
    const i0 = ri * cols;
    const iEnd = ri * cols + sides;
    const nx = normAttr.getX(i0) + normAttr.getX(iEnd);
    const ny = normAttr.getY(i0) + normAttr.getY(iEnd);
    const nz = normAttr.getZ(i0) + normAttr.getZ(iEnd);
    const len = Math.hypot(nx, ny, nz) || 1;
    normAttr.setXYZ(i0, nx / len, ny / len, nz / len);
    normAttr.setXYZ(iEnd, nx / len, ny / len, nz / len);
  }
  normAttr.needsUpdate = true;

  if (!capBottom && !capTop) {
    return sideGeo;
  }

  // Append separate flat cap vertices in disjoint UV bands [0.01..0.06] and [0.94..0.99]
  const sidePos = Array.from(sideGeo.getAttribute("position").array as ArrayLike<number>);
  const sideNorm = Array.from(normAttr.array as ArrayLike<number>);
  const sideUv = Array.from(sideGeo.getAttribute("uv").array as ArrayLike<number>);
  const allIndices = Array.from(indices);
  sideGeo.dispose();

  const appendCap = (ring: LatheRing, isTop: boolean) => {
    const centerIdx = sidePos.length / 3;
    const xo = ring.xOff ?? 0;
    const zo = ring.zOff ?? 0;
    const ny = isTop ? 1 : -1;
    const vCap = isTop ? 0.965 : 0.035;

    sidePos.push(xo, ring.y, zo);
    sideNorm.push(0, ny, 0);
    sideUv.push(0.5, vCap);

    const rimStart = sidePos.length / 3;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      sidePos.push(xo + Math.cos(a) * ring.rx, ring.y, zo + Math.sin(a) * ring.rz);
      sideNorm.push(0, ny, 0);
      sideUv.push(0.02 + 0.96 * (s / sides), vCap);
    }

    for (let s = 0; s < sides; s++) {
      const next = (s + 1) % sides;
      if (isTop) {
        allIndices.push(centerIdx, rimStart + next, rimStart + s);
      } else {
        allIndices.push(centerIdx, rimStart + s, rimStart + next);
      }
    }
  };

  if (capBottom && rings[0].rx > 1e-4 && rings[0].rz > 1e-4) {
    appendCap(rings[0], false);
  }
  if (capTop && rings[ringCount - 1].rx > 1e-4 && rings[ringCount - 1].rz > 1e-4) {
    appendCap(rings[ringCount - 1], true);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(sidePos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(sideNorm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(sideUv, 2));
  out.setIndex(allIndices);
  return out;
}

function buildCharTransform(
  localPos: readonly [number, number, number],
  localRot: readonly [number, number, number],
  localScale: readonly [number, number, number],
  charPos: readonly [number, number, number],
  charRotY: number,
  charScale: number,
): SceneMatrix4 {
  const localMat = new SceneMatrix4().compose(
    new SceneVector3(localPos[0], localPos[1], localPos[2]),
    new SceneQuaternion().setFromEuler(
      new SceneEuler(localRot[0], localRot[1], localRot[2]),
    ),
    new SceneVector3(localScale[0], localScale[1], localScale[2]),
  );
  const charMat = new SceneMatrix4().compose(
    new SceneVector3(charPos[0], charPos[1], charPos[2]),
    new SceneQuaternion().setFromAxisAngle(new SceneVector3(0, 1, 0), charRotY),
    new SceneVector3(charScale, charScale, charScale),
  );
  return charMat.multiply(localMat);
}

function pushMeshGeometry(
  mg: MeshGeometry,
  localPos: readonly [number, number, number],
  localRot: readonly [number, number, number],
  localScale: readonly [number, number, number],
  charPos: readonly [number, number, number],
  charRotY: number,
  bucket: MergeGeometryPart[],
): void {
  const m = buildCharTransform(
    localPos,
    localRot,
    localScale,
    charPos,
    charRotY,
    HOST_SCALE,
  );
  mg.applyMatrix4(m);
  bucket.push({ geo: mg });
}

function addSmoothLathe(
  rings: readonly LatheRing[],
  localPos: readonly [number, number, number],
  localRot: readonly [number, number, number],
  charPos: readonly [number, number, number],
  charRotY: number,
  bucket: MergeGeometryPart[],
  sides = 22,
  capBottom = true,
  capTop = true,
): void {
  const geo = createSmoothLatheGeometry(rings, sides, capBottom, capTop);
  const mg = toSmoothMeshGeometry(geo);
  geo.dispose();
  pushMeshGeometry(mg, localPos, localRot, [1, 1, 1], charPos, charRotY, bucket);
}

function addSmoothSphere(
  radii: readonly [number, number, number],
  localPos: readonly [number, number, number],
  localRot: readonly [number, number, number],
  charPos: readonly [number, number, number],
  charRotY: number,
  bucket: MergeGeometryPart[],
  wSegs = 18,
  hSegs = 12,
): void {
  const geo = new THREE.SphereGeometry(1, wSegs, hSegs);
  const mg = toSmoothMeshGeometry(geo);
  geo.dispose();
  pushMeshGeometry(mg, localPos, localRot, radii, charPos, charRotY, bucket);
}

function addRoundedBox(
  size: readonly [number, number, number],
  radius: number,
  localPos: readonly [number, number, number],
  localRot: readonly [number, number, number],
  charPos: readonly [number, number, number],
  charRotY: number,
  bucket: MergeGeometryPart[],
): void {
  const mg = createRoundedBoxMeshGeometry(size[0], size[1], size[2], 3, radius);
  pushMeshGeometry(mg, localPos, localRot, [1, 1, 1], charPos, charRotY, bucket);
}

function addSmileMouth(
  centerY: number,
  centerZ: number,
  halfWidth: number,
  liftY: number,
  charPos: readonly [number, number, number],
  charRotY: number,
  lipBucket: MergeGeometryPart[],
): void {
  for (let i = -2; i <= 2; i++) {
    const t = i / 2;
    const x = t * halfWidth;
    const y = centerY + liftY * t * t;
    const z = centerZ - 0.009 * t * t;
    addSmoothSphere(
      [0.014, 0.0085, 0.011],
      [x, y, z],
      [0, t * -0.18, t * 0.36],
      charPos,
      charRotY,
      lipBucket,
      10,
      8,
    );
  }
}

/**
 * Adds a smooth, clean-shaven white-suited senior host standing naturally
 * on the top step deck (no glasses, no book, no beard or mustache).
 */
function buildMaleHost(
  charPos: readonly [number, number, number],
  charRotY: number,
  b: HostBuckets,
): void {
  for (const side of [-1, 1] as const) {
    const lx = side * 0.118;

    // Rounded dress loafers (sole flush at local y = 0)
    addSmoothLathe(
      [
        { y: 0.0, rx: 0.070, rz: 0.138, zOff: 0.042 },
        { y: 0.045, rx: 0.068, rz: 0.128, zOff: 0.036 },
        { y: 0.085, rx: 0.056, rz: 0.088, zOff: 0.012 },
        { y: 0.112, rx: 0.048, rz: 0.056, zOff: 0.0 },
      ],
      [lx, 0, 0],
      [0, side * 0.06, 0],
      charPos,
      charRotY,
      b.elderPants,
      20,
    );

    // Tailored straight-tapered trousers (clean ankle-to-hip fit, no sag)
    addSmoothLathe(
      [
        { y: 0.08, rx: 0.068, rz: 0.072 },
        { y: 0.36, rx: 0.072, rz: 0.076 },
        { y: 0.68, rx: 0.078, rz: 0.082 },
        { y: 1.04, rx: 0.098, rz: 0.102 },
        { y: 1.28, rx: 0.114, rz: 0.116 },
      ],
      [lx, 0, 0],
      [0, 0, 0],
      charPos,
      charRotY,
      b.elderPants,
      24,
    );
  }

  // Tailored trouser hips & high waist (no exposed low-slung belt)
  addSmoothLathe(
    [
      { y: 1.15, rx: 0.214, rz: 0.128 },
      { y: 1.32, rx: 0.218, rz: 0.132 },
      { y: 1.48, rx: 0.208, rz: 0.128 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.elderPants,
    24,
  );

  // Inner collared shirt (visible cleanly inside upper V-opening) + sleek dark tie
  addSmoothLathe(
    [
      { y: 1.66, rx: 0.168, rz: 0.110 },
      { y: 1.86, rx: 0.172, rz: 0.112 },
      { y: 2.01, rx: 0.162, rz: 0.104 },
    ],
    [0, 0, 0.010],
    [0, 0, 0],
    charPos,
    charRotY,
    b.elderShirt,
    22,
  );
  addRoundedBox([0.042, 0.28, 0.022], 0.008, [0, 1.84, 0.122], [0.06, 0, 0], charPos, charRotY, b.darkHairAndEyes);

  // Tailored smooth cream-white suit blazer (neatly buttoned at waist/torso)
  addSmoothLathe(
    [
      { y: 1.24, rx: 0.258, rz: 0.150, zOff: -0.008 },
      { y: 1.44, rx: 0.236, rz: 0.146, zOff: -0.008 },
      { y: 1.72, rx: 0.256, rz: 0.152, zOff: -0.008 },
      { y: 1.98, rx: 0.276, rz: 0.150, zOff: -0.008 },
      { y: 2.04, rx: 0.216, rz: 0.122, zOff: -0.008 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.elderSuit,
    24,
  );
  // Subtle blazer buttons on closed mid-front
  for (const by of [1.46, 1.60]) {
    addSmoothSphere([0.015, 0.015, 0.012], [0, by, 0.144], [0, 0, 0], charPos, charRotY, b.darkHairAndEyes, 10, 8);
  }

  for (const side of [-1, 1] as const) {
    // Upper blazer lapels framing V-neck shirt & tie
    addRoundedBox(
      [0.095, 0.34, 0.044],
      0.016,
      [side * 0.115, 1.85, 0.132],
      [-0.08, side * -0.15, side * -0.26],
      charPos,
      charRotY,
      b.elderSuit,
    );
    // Smooth rounded shoulder caps
    addSmoothSphere(
      [0.115, 0.095, 0.110],
      [side * 0.275, 1.94, 0],
      [0, 0, side * -0.22],
      charPos,
      charRotY,
      b.elderSuit,
    );
  }

  // Left arm (viewer's left: gentle hand-on-hip pose, zero book)
  addSmoothLathe(
    [
      { y: -0.34, rx: 0.072, rz: 0.072 },
      { y: -0.17, rx: 0.082, rz: 0.082 },
      { y: 0.0, rx: 0.092, rz: 0.092 },
    ],
    [-0.30, 1.93, 0.0],
    [0.08, 0, -0.42],
    charPos,
    charRotY,
    b.elderSuit,
    18,
  );
  addSmoothSphere([0.074, 0.074, 0.074], [-0.43, 1.63, 0.03], [0, 0, 0], charPos, charRotY, b.elderSuit, 14, 10);
  addSmoothLathe(
    [
      { y: -0.30, rx: 0.058, rz: 0.058 },
      { y: -0.15, rx: 0.066, rz: 0.066 },
      { y: 0.0, rx: 0.072, rz: 0.072 },
    ],
    [-0.43, 1.63, 0.03],
    [-0.24, 0, 0.54],
    charPos,
    charRotY,
    b.elderSuit,
    18,
  );
  addSmoothSphere([0.050, 0.062, 0.044], [-0.27, 1.38, 0.09], [0.2, 0, 0.4], charPos, charRotY, b.elderSkin, 14, 10);

  // Right arm (relaxed naturally at side, zero book)
  addSmoothLathe(
    [
      { y: -0.35, rx: 0.072, rz: 0.072 },
      { y: -0.17, rx: 0.082, rz: 0.082 },
      { y: 0.0, rx: 0.092, rz: 0.092 },
    ],
    [0.30, 1.93, 0.0],
    [0.05, 0, 0.20],
    charPos,
    charRotY,
    b.elderSuit,
    18,
  );
  addSmoothSphere([0.072, 0.072, 0.072], [0.37, 1.61, 0.02], [0, 0, 0], charPos, charRotY, b.elderSuit, 14, 10);
  addSmoothLathe(
    [
      { y: -0.31, rx: 0.058, rz: 0.058 },
      { y: -0.15, rx: 0.065, rz: 0.065 },
      { y: 0.0, rx: 0.070, rz: 0.070 },
    ],
    [0.37, 1.61, 0.02],
    [-0.16, 0, -0.08],
    charPos,
    charRotY,
    b.elderSuit,
    18,
  );
  addSmoothSphere([0.048, 0.064, 0.042], [0.35, 1.29, 0.06], [0, 0, 0], charPos, charRotY, b.elderSkin, 14, 10);

  // Neck + clean-shaven smooth rounded oval head (no beard, no mustache, no glasses)
  addSmoothLathe(
    [
      { y: 2.01, rx: 0.084, rz: 0.084 },
      { y: 2.16, rx: 0.076, rz: 0.076 },
    ],
    [0, 0, 0.01],
    [0, 0, 0],
    charPos,
    charRotY,
    b.elderSkin,
    20,
  );
  addSmoothLathe(
    [
      { y: 2.12, rx: 0.065, rz: 0.072, zOff: 0.015 },
      { y: 2.16, rx: 0.112, rz: 0.122, zOff: 0.015 },
      { y: 2.25, rx: 0.148, rz: 0.160, zOff: 0.018 },
      { y: 2.38, rx: 0.154, rz: 0.166, zOff: 0.014 },
      { y: 2.48, rx: 0.132, rz: 0.146, zOff: 0.005 },
      { y: 2.53, rx: 0.065, rz: 0.075, zOff: 0.0 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.elderSkin,
    32,
  );

  // Smooth ears, nose, sclera + dark iris, white brows & subtle warm smile line
  for (const side of [-1, 1] as const) {
    addSmoothSphere(
      [0.026, 0.052, 0.034],
      [side * 0.156, 2.31, 0.0],
      [0, side * -0.15, side * 0.12],
      charPos,
      charRotY,
      b.elderSkin,
      16,
      12,
    );
    addSmoothSphere(
      [0.020, 0.022, 0.016],
      [side * 0.056, 2.345, 0.162],
      [0, side * 0.12, 0],
      charPos,
      charRotY,
      b.darkHairAndEyes,
      16,
      12,
    );
    addRoundedBox(
      [0.064, 0.024, 0.032],
      0.010,
      [side * 0.058, 2.388, 0.166],
      [0, side * 0.10, side * -0.08],
      charPos,
      charRotY,
      b.whiteHair,
    );
  }
  addSmoothSphere(
    [0.024, 0.042, 0.032],
    [0, 2.295, 0.174],
    [-0.18, 0, 0],
    charPos,
    charRotY,
    b.elderSkin,
    12,
    10,
  );
  addSmileMouth(2.198, 0.148, 0.036, 0.015, charPos, charRotY, b.elderLip);

  // Smooth neat white hair cap & high sideburns (completely above jaw/cheeks)
  addSmoothLathe(
    [
      { y: 2.40, rx: 0.160, rz: 0.172, zOff: -0.012 },
      { y: 2.48, rx: 0.164, rz: 0.176, zOff: -0.008 },
      { y: 2.55, rx: 0.128, rz: 0.140, zOff: -0.004 },
      { y: 2.58, rx: 0.055, rz: 0.060, zOff: 0.0 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.whiteHair,
    24,
  );
  addRoundedBox([0.28, 0.16, 0.10], 0.042, [0, 2.35, -0.125], [0.1, 0, 0], charPos, charRotY, b.whiteHair);
  for (const side of [-1, 1] as const) {
    addRoundedBox([0.048, 0.11, 0.085], 0.020, [side * 0.142, 2.37, 0.01], [0, 0, 0], charPos, charRotY, b.whiteHair);
  }
}

/**
 * Adds a matching-scale smooth female presenter with long black hair cleanly tucked
 * behind her face/shoulders and a tailored rose-pink skirt suit.
 */
function buildFemaleHost(
  charPos: readonly [number, number, number],
  charRotY: number,
  b: HostBuckets,
): void {
  for (const side of [-1, 1] as const) {
    const lx = side * 0.105;

    // Smooth rose-pink heels (sole flush at local y = 0)
    addSmoothLathe(
      [
        { y: 0.0, rx: 0.052, rz: 0.122, zOff: 0.038 },
        { y: 0.040, rx: 0.050, rz: 0.112, zOff: 0.032 },
        { y: 0.078, rx: 0.042, rz: 0.075, zOff: 0.012 },
        { y: 0.100, rx: 0.038, rz: 0.048, zOff: 0.0 },
      ],
      [lx, 0, 0],
      [0, side * 0.04, 0],
      charPos,
      charRotY,
      b.pinkAccent,
      20,
    );
    addRoundedBox([0.042, 0.068, 0.040], 0.012, [lx, 0.034, -0.052], [0, 0, 0], charPos, charRotY, b.pinkAccent);

    // Smooth legs & calves
    addSmoothLathe(
      [
        { y: 0.09, rx: 0.038, rz: 0.040 },
        { y: 0.30, rx: 0.052, rz: 0.054 },
        { y: 0.48, rx: 0.058, rz: 0.060 },
        { y: 0.72, rx: 0.054, rz: 0.056 },
        { y: 0.88, rx: 0.068, rz: 0.070 },
      ],
      [lx, 0, 0],
      [0, 0, 0],
      charPos,
      charRotY,
      b.femaleSkin,
      20,
    );
  }

  // Smooth tailored rose-pink knee-length skirt
  addSmoothLathe(
    [
      { y: 0.74, rx: 0.194, rz: 0.136 },
      { y: 0.98, rx: 0.205, rz: 0.145 },
      { y: 1.24, rx: 0.212, rz: 0.146 },
      { y: 1.38, rx: 0.164, rz: 0.115 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.pinkSkirt,
    24,
  );

  // Smooth white inner V-neck blouse (recessed cleanly inside upper chest only; never pokes through stomach)
  addSmoothLathe(
    [
      { y: 1.62, rx: 0.142, rz: 0.088 },
      { y: 1.78, rx: 0.152, rz: 0.094 },
      { y: 1.93, rx: 0.144, rz: 0.088 },
    ],
    [0, 0, 0.008],
    [0, 0, 0],
    charPos,
    charRotY,
    b.whiteBlouse,
    22,
  );

  // Smooth tailored rose-pink fitted blazer jacket (cleanly closed waist, V-neck at upper chest)
  addSmoothLathe(
    [
      { y: 1.27, rx: 0.214, rz: 0.138, zOff: -0.006 },
      { y: 1.45, rx: 0.180, rz: 0.124, zOff: -0.006 },
      { y: 1.72, rx: 0.214, rz: 0.134, zOff: -0.006 },
      { y: 1.93, rx: 0.230, rz: 0.126, zOff: -0.006 },
      { y: 1.98, rx: 0.185, rz: 0.104, zOff: -0.006 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.pinkBlazer,
    24,
  );
  // Subtle fitted blazer buttons at waist
  for (const by of [1.42, 1.54]) {
    addSmoothSphere([0.012, 0.012, 0.010], [0, by, 0.120], [0, 0, 0], charPos, charRotY, b.pinkAccent, 10, 8);
  }

  for (const side of [-1, 1] as const) {
    addRoundedBox(
      [0.078, 0.30, 0.040],
      0.014,
      [side * 0.100, 1.81, 0.114],
      [-0.08, side * -0.14, side * -0.24],
      charPos,
      charRotY,
      b.pinkBlazer,
    );
    addSmoothSphere(
      [0.090, 0.078, 0.088],
      [side * 0.228, 1.89, 0],
      [0, 0, side * -0.22],
      charPos,
      charRotY,
      b.pinkBlazer,
    );
  }

  // Right arm: poised hand on hip
  addSmoothLathe(
    [
      { y: -0.30, rx: 0.058, rz: 0.058 },
      { y: -0.15, rx: 0.066, rz: 0.066 },
      { y: 0.0, rx: 0.074, rz: 0.074 },
    ],
    [0.245, 1.88, 0.0],
    [0.06, 0, 0.42],
    charPos,
    charRotY,
    b.pinkBlazer,
    18,
  );
  addSmoothSphere([0.058, 0.058, 0.058], [0.365, 1.62, 0.02], [0, 0, 0], charPos, charRotY, b.pinkBlazer, 14, 10);
  addSmoothLathe(
    [
      { y: -0.27, rx: 0.048, rz: 0.048 },
      { y: -0.13, rx: 0.054, rz: 0.054 },
      { y: 0.0, rx: 0.058, rz: 0.058 },
    ],
    [0.365, 1.62, 0.02],
    [-0.20, 0, -0.52],
    charPos,
    charRotY,
    b.pinkBlazer,
    18,
  );
  addSmoothSphere([0.044, 0.054, 0.040], [0.22, 1.38, 0.075], [0.15, 0, -0.35], charPos, charRotY, b.femaleSkin, 14, 10);

  // Left arm: gently angled relaxed presenter pose
  addSmoothLathe(
    [
      { y: -0.31, rx: 0.058, rz: 0.058 },
      { y: -0.15, rx: 0.066, rz: 0.066 },
      { y: 0.0, rx: 0.074, rz: 0.074 },
    ],
    [-0.245, 1.88, 0.0],
    [0.04, 0, -0.18],
    charPos,
    charRotY,
    b.pinkBlazer,
    18,
  );
  addSmoothSphere([0.056, 0.056, 0.056], [-0.305, 1.59, 0.015], [0, 0, 0], charPos, charRotY, b.pinkBlazer, 14, 10);
  addSmoothLathe(
    [
      { y: -0.28, rx: 0.046, rz: 0.046 },
      { y: -0.14, rx: 0.052, rz: 0.052 },
      { y: 0.0, rx: 0.056, rz: 0.056 },
    ],
    [-0.305, 1.59, 0.015],
    [-0.15, 0, 0.08],
    charPos,
    charRotY,
    b.pinkBlazer,
    18,
  );
  addSmoothSphere([0.042, 0.054, 0.038], [-0.285, 1.30, 0.055], [0, 0, 0], charPos, charRotY, b.femaleSkin, 14, 10);

  // Neck + clean smooth feminine oval head
  addSmoothLathe(
    [
      { y: 1.95, rx: 0.066, rz: 0.066 },
      { y: 2.10, rx: 0.058, rz: 0.060 },
    ],
    [0, 0, 0.01],
    [0, 0, 0],
    charPos,
    charRotY,
    b.femaleSkin,
    20,
  );
  addSmoothLathe(
    [
      { y: 2.06, rx: 0.055, rz: 0.062, zOff: 0.016 },
      { y: 2.10, rx: 0.088, rz: 0.098, zOff: 0.016 },
      { y: 2.19, rx: 0.128, rz: 0.140, zOff: 0.014 },
      { y: 2.31, rx: 0.136, rz: 0.148, zOff: 0.010 },
      { y: 2.40, rx: 0.118, rz: 0.130, zOff: 0.004 },
      { y: 2.45, rx: 0.058, rz: 0.064, zOff: 0.0 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.femaleSkin,
    32,
  );

  // Delicate nose, ears, sclera + dark iris, arched brows, pearl necklace & rose lips
  for (const side of [-1, 1] as const) {
    addSmoothSphere(
      [0.020, 0.042, 0.028],
      [side * 0.138, 2.24, 0.0],
      [0, side * -0.12, side * 0.1],
      charPos,
      charRotY,
      b.femaleSkin,
      16,
      12,
    );
    addSmoothSphere(
      [0.019, 0.021, 0.015],
      [side * 0.050, 2.265, 0.142],
      [0, side * 0.12, 0],
      charPos,
      charRotY,
      b.darkHairAndEyes,
      16,
      12,
    );
    addRoundedBox(
      [0.056, 0.014, 0.022],
      0.006,
      [side * 0.052, 2.304, 0.145],
      [0, side * 0.10, side * -0.08],
      charPos,
      charRotY,
      b.darkHairAndEyes,
    );
  }
  for (let pi = -2; pi <= 2; pi++) {
    addSmoothSphere(
      [0.013, 0.013, 0.013],
      [pi * 0.026, 1.985 - Math.abs(pi) * -0.005, 0.095 - Math.abs(pi) * 0.006],
      [0, 0, 0],
      charPos,
      charRotY,
      b.whiteBlouse,
      10,
      8,
    );
  }
  addSmoothSphere(
    [0.018, 0.032, 0.024],
    [0, 2.225, 0.152],
    [-0.15, 0, 0],
    charPos,
    charRotY,
    b.femaleSkin,
    16,
    12,
  );
  addSmileMouth(2.132, 0.132, 0.034, 0.015, charPos, charRotY, b.pinkAccent);

  // Smooth long black hair: top crown + single smooth continuous back hair cascade (zero face/jaw overlap)
  addSmoothLathe(
    [
      { y: 2.31, rx: 0.146, rz: 0.156, zOff: -0.016 },
      { y: 2.39, rx: 0.152, rz: 0.162, zOff: -0.012 },
      { y: 2.46, rx: 0.126, rz: 0.136, zOff: -0.006 },
      { y: 2.49, rx: 0.058, rz: 0.065, zOff: 0.0 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.darkHairAndEyes,
    32,
  );
  // Smooth flowing continuous back hair cascade down to mid-back
  addSmoothLathe(
    [
      { y: 1.56, rx: 0.148, rz: 0.065, zOff: -0.115 },
      { y: 1.72, rx: 0.172, rz: 0.080, zOff: -0.110 },
      { y: 1.96, rx: 0.176, rz: 0.095, zOff: -0.095 },
      { y: 2.22, rx: 0.158, rz: 0.115, zOff: -0.065 },
      { y: 2.40, rx: 0.146, rz: 0.135, zOff: -0.030 },
    ],
    [0, 0, 0],
    [0, 0, 0],
    charPos,
    charRotY,
    b.darkHairAndEyes,
    32,
  );
}

function createContactShadowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size * 0.5,
    size * 0.5,
    size * 0.08,
    size * 0.5,
    size * 0.5,
    size * 0.48,
  );
  g.addColorStop(0.0, "rgba(15, 20, 36, 0.44)");
  g.addColorStop(0.48, "rgba(15, 20, 36, 0.24)");
  g.addColorStop(1.0, "rgba(15, 20, 36, 0.0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasToDataTexture(canvas, "srgb");
}

/**
 * Builds the two motionless smooth stylized studio hosts standing atop the
 * rear top-tier white staircase step (`y = 1.35m`), complete with baked static GI
 * support and soft contact shadow decals.
 */
export function createStudioHosts(_isMobile = false): Group {
  const group = new Group();
  group.name = "studioHosts";

  const b: HostBuckets = {
    elderSuit: [],
    elderShirt: [],
    elderPants: [],
    elderSkin: [],
    whiteHair: [],
    elderLip: [],
    femaleSkin: [],
    darkHairAndEyes: [],
    pinkBlazer: [],
    pinkSkirt: [],
    whiteBlouse: [],
    pinkAccent: [],
  };

  const malePos: [number, number, number] = [-4.85, 1.35, -13.04];
  const femalePos: [number, number, number] = [4.85, 1.35, -13.04];

  buildMaleHost(malePos, 0.24, b);
  buildFemaleHost(femalePos, -0.24, b);

  const addBucketMesh = (
    name: string,
    parts: MergeGeometryPart[],
    colorHex: number,
    roughness: number,
  ) => {
    if (parts.length === 0) return;
    const mat = new MeshStandardMaterial({
      color: colorHex,
      roughness,
      metalness: 0.02,
    });
    mat.name = name;
    const mesh = new Mesh(mergeSceneGeometries(parts, true), mat);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  };

  addBucketMesh("static:host_elder_suit", b.elderSuit, 0xf5f2eb, 0.78);
  addBucketMesh("static:host_elder_shirt", b.elderShirt, 0xd4ccc2, 0.82);
  addBucketMesh("static:host_elder_pants", b.elderPants, 0x7c5c46, 0.82);
  addBucketMesh("static:host_elder_skin", b.elderSkin, 0xe6a886, 0.70);
  addBucketMesh("static:host_white_hair", b.whiteHair, 0xf4f6fa, 0.76);
  addBucketMesh("static:host_elder_lip", b.elderLip, 0xc87f66, 0.72);
  addBucketMesh("static:host_female_skin", b.femaleSkin, 0xf0b89a, 0.68);
  addBucketMesh("static:host_dark_hair_eyes", b.darkHairAndEyes, 0x181a24, 0.62);
  addBucketMesh("static:host_pink_blazer", b.pinkBlazer, 0xf06292, 0.72);
  addBucketMesh("static:host_pink_skirt", b.pinkSkirt, 0xe25182, 0.74);
  addBucketMesh("static:host_white_blouse", b.whiteBlouse, 0xfaf8f6, 0.76);
  addBucketMesh("static:host_pink_accent", b.pinkAccent, 0xc93b6b, 0.55);

  // Soft contact shadow decals beneath each host's shoes on top step (y = 1.353m)
  const contactShadowMat = new MeshBasicMaterial({
    color: 0xffffff,
    map: createContactShadowTexture(),
    transparent: true,
  });
  contactShadowMat.name = "hostContactShadow";

  for (const [hx, hy, hz] of [malePos, femalePos]) {
    const decal = new Mesh(new PlaneGeometry(1.45, 1.15), contactShadowMat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(hx, hy + 0.003, hz);
    group.add(decal);
  }

  return group;
}
