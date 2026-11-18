import {
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PointLight,
  SpotLight,
  TorusGeometry,
} from "@threert/scene";
import {
  canvasToDataTexture,
  createCurvedCycloramaGeometry,
  createCurvedStepArcGeometry,
  MergeGeometryPart,
  mergeSceneGeometries,
} from "../utils/procedural";
import { createCurvedWallSignageGeometry } from "./studioSignage";

export interface StudioBuildResult {
  group: Group;
  washerLights: PointLight[];
}

function createStudioBackdropTexture(isMobile = false) {
  const canvas = document.createElement("canvas");
  const size = isMobile ? 512 : 1024;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const w = canvas.width;
  const h = canvas.height;

  // Clean pearl-silver broadcast cyclorama into soft cool-slate bottom wash
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0.0, "#e4e7ee");
  bg.addColorStop(0.38, "#dfe3ec");
  bg.addColorStop(0.70, "#d7dde9");
  bg.addColorStop(0.88, "#cdd6ea");
  bg.addColorStop(1.0, "#c2cdea");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Subtle architectural studio wall plaster grain & faint vertical seam lines
  const grainCount = isMobile ? 400 : 1600;
  for (let i = 0; i < grainCount; i++) {
    const x = (i * 97) % w;
    const y = (i * 211) % h;
    const rad = 2 + (i % 5);
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.018)" : "rgba(40,38,56,0.018)";
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(95, 92, 110, 0.08)";
  ctx.lineWidth = 2;
  for (const sx of [w * 0.25, w * 0.5, w * 0.75]) {
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }

  // Soft cool-slate bottom wash bloom
  const washGrad = ctx.createLinearGradient(0, h, 0, h * 0.54);
  washGrad.addColorStop(0.0, "rgba(168, 184, 240, 0.22)");
  washGrad.addColorStop(0.48, "rgba(180, 194, 245, 0.08)");
  washGrad.addColorStop(1.0, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = washGrad;
  ctx.fillRect(0, h * 0.54, w, h * 0.46);

  // Subtle cool-blue LED seam line at wall base
  const bottomStrip = ctx.createLinearGradient(0, h - 18, 0, h);
  bottomStrip.addColorStop(0, "rgba(129, 140, 248, 0)");
  bottomStrip.addColorStop(1, "rgba(165, 180, 245, 0.45)");
  ctx.fillStyle = bottomStrip;
  ctx.fillRect(0, h - 20, w, 20);

  const tex = canvasToDataTexture(canvas, "srgb");
  tex.wrap = "repeat";
  tex.repeat = [4, 1];
  return tex;
}

function createWashGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  const g = ctx.createLinearGradient(0, canvas.height, 0, 0);
  g.addColorStop(0, "rgba(165, 180, 252, 0.28)");
  g.addColorStop(0.38, "rgba(147, 165, 255, 0.12)");
  g.addColorStop(0.75, "rgba(165, 180, 252, 0.03)");
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  return canvasToDataTexture(canvas, "srgb");
}

function createStudioFloorTextures(isMobile = false) {
  const size = isMobile ? 256 : 512;
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = size;
  colorCanvas.height = size;
  const cCtx = colorCanvas.getContext("2d")!;

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext("2d")!;

  // Base muted slate-lavender polished studio epoxy panel tone
  cCtx.fillStyle = "#625e78";
  cCtx.fillRect(0, 0, size, size);

  rCtx.fillStyle = "rgb(52, 52, 52)";
  rCtx.fillRect(0, 0, size, size);

  // Subtle multi-tile micro variation & micro-sheen flecks (deterministic PRNG look)
  const tile = size / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const shade = (tx + ty) % 2 === 0 ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.025)";
      cCtx.fillStyle = shade;
      cCtx.fillRect(tx * tile, ty * tile, tile, tile);

      const rVal = (tx + ty) % 2 === 0 ? 46 : 58;
      rCtx.fillStyle = `rgb(${rVal}, ${rVal}, ${rVal})`;
      rCtx.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }

  // Fine architectural studio panel seams
  cCtx.strokeStyle = "rgba(38, 35, 52, 0.36)";
  cCtx.lineWidth = isMobile ? 1.5 : 2;
  rCtx.strokeStyle = "rgb(145, 145, 145)";
  rCtx.lineWidth = isMobile ? 1.5 : 2;
  for (const offset of [0, tile]) {
    cCtx.beginPath();
    cCtx.moveTo(offset, 0);
    cCtx.lineTo(offset, size);
    cCtx.moveTo(0, offset);
    cCtx.lineTo(size, offset);
    cCtx.stroke();

    rCtx.beginPath();
    rCtx.moveTo(offset, 0);
    rCtx.lineTo(offset, size);
    rCtx.moveTo(0, offset);
    rCtx.lineTo(size, offset);
    rCtx.stroke();
  }

  // Soft organic studio buffing grain
  const grainCount = isMobile ? 120 : 420;
  for (let i = 0; i < grainCount; i++) {
    const x = ((i * 73) % size);
    const y = ((i * 197) % size);
    const rad = 6 + (i % 14);
    const alpha = 0.016;
    cCtx.fillStyle = i % 2 === 0 ? `rgba(255,255,255,${alpha})` : `rgba(20,18,35,${alpha})`;
    cCtx.beginPath();
    cCtx.arc(x, y, rad, 0, Math.PI * 2);
    cCtx.fill();

    const rv = 42 + (i % 24);
    rCtx.fillStyle = `rgba(${rv},${rv},${rv},0.22)`;
    rCtx.beginPath();
    rCtx.arc(x, y, rad, 0, Math.PI * 2);
    rCtx.fill();
  }

  const map = canvasToDataTexture(colorCanvas, "srgb");
  map.wrap = "repeat";
  map.repeat = [9, 9];

  const roughnessMap = canvasToDataTexture(roughCanvas, "linear");
  roughnessMap.wrap = "repeat";
  roughnessMap.repeat = [9, 9];

  return { map, roughnessMap };
}

export function createStudio(isMobile = false): StudioBuildResult {
  const group = new Group();
  group.name = "broadcastStudio";

  // 360-degree studio arena centered around the Halogen III machine (x=0, z=0)
  const arcCenterZ = 0;
  const wallRadius = 14.5;
  const wallHeight = 9.2;
  const fullCircleArc = Math.PI * 2;

  // 1. Soft glossy studio floor with subtle architectural panel seams & micro-roughness
  const { map: floorMap, roughnessMap: floorRoughMap } =
    createStudioFloorTextures(isMobile);
  const floorMat = new MeshPhysicalMaterial({
    color: 0xffffff,
    map: floorMap,
    roughnessMap: floorRoughMap,
    roughness: 0.72,
    metalness: 0.12,
    clearcoat: 0.85,
    clearcoatRoughness: 0.09,
  });
  floorMat.name = "studioFloor";

  const floorMesh = new Mesh(new CylinderGeometry(wallRadius + 0.4, wallRadius + 0.4, 0.1, 72), floorMat);
  floorMesh.name = "static:studio_floor";
  floorMesh.position.set(0, -0.05, 0);
  floorMesh.castShadow = false;
  floorMesh.receiveShadow = true;
  group.add(floorMesh);

  // Sleek recessed satin-chrome studio stage trim rings around center machine
  const stageTrimMat = new MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.82,
    roughness: 0.28,
  });
  const stageRingParts: MergeGeometryPart[] = [2.15, 4.45].map((ringRadius) => ({
    geo: new TorusGeometry(ringRadius, 0.012, 8, 72),
    pos: [0, 0.004, 0],
    rot: [Math.PI / 2, 0, 0],
  }));
  const stageRings = new Mesh(mergeSceneGeometries(stageRingParts, true), stageTrimMat);
  stageRings.name = "static:stage_rings_all";
  stageRings.castShadow = false;
  group.add(stageRings);

  // Subtle floor turntable disc pad beneath the white cone
  const podiumMat = new MeshStandardMaterial({
    color: 0x2a2730,
    metalness: 0.45,
    roughness: 0.3,
  });
  const podiumDisc = new Mesh(new CylinderGeometry(1.38, 1.44, 0.02, 56), podiumMat);
  podiumDisc.name = "static:podium_disc";
  podiumDisc.position.set(0, 0.01, 0);
  podiumDisc.castShadow = false;
  podiumDisc.receiveShadow = true;
  group.add(podiumDisc);

  // 2. Full 360-Degree Concave Circular Studio Cyclorama Wall (no side walls, seamless 360 orbit!)
  const backdropTex = createStudioBackdropTexture(isMobile);
  const backdropMat = new MeshStandardMaterial({
    color: 0xffffff,
    map: backdropTex,
    emissive: 0xffffff,
    emissiveMap: backdropTex,
    emissiveIntensity: 0.02,
    roughness: 0.86,
    metalness: 0.02,
    side: DoubleSide,
  });
  backdropMat.name = "studioBackdropWall";

  const backdropGeo = createCurvedCycloramaGeometry(
    wallRadius,
    wallHeight,
    fullCircleArc,
    arcCenterZ,
    72,
  );
  const backdropMesh = new Mesh(backdropGeo, backdropMat);
  backdropMesh.name = "static:backdrop_wall";
  backdropMesh.position.set(0, 1.35, 0);
  backdropMesh.castShadow = false;
  backdropMesh.receiveShadow = true;
  group.add(backdropMesh);

  // 2b. 3D Extruded Beveled Architectural Wall Signage (Chocolate Classical Sans)
  const signMat = new MeshPhysicalMaterial({
    color: 0x484a56,
    roughness: 0.36,
    metalness: 0.22,
    clearcoat: 0.32,
    clearcoatRoughness: 0.22,
  });
  signMat.name = "studioSignage3D";

  // Staggered studio typography matching HKJC backdrop composition around 360° cyclorama
  const baseSignPattern: Array<{
    text: string;
    dTheta: number;
    y: number;
    h: number;
    spacing: number;
  }> = [
    { text: "M A R K  S I X", dTheta: 0.0, y: 7.65, h: 0.82, spacing: 0.16 },
    { text: "六 合 彩", dTheta: -0.56, y: 6.35, h: 0.46, spacing: 0.14 },
    { text: "六 合 彩", dTheta: 0.44, y: 7.45, h: 0.42, spacing: 0.14 },
    { text: "M A R K  S I X", dTheta: -0.16, y: 6.05, h: 0.40, spacing: 0.13 },
    { text: "M A R K  S I X", dTheta: 0.62, y: 5.35, h: 0.42, spacing: 0.13 },
    { text: "六 合 彩", dTheta: 0.58, y: 3.95, h: 0.46, spacing: 0.14 },
    { text: "M A R K  S I X", dTheta: -0.62, y: 3.35, h: 0.36, spacing: 0.12 },
  ];

  const signParts: MergeGeometryPart[] = [];
  const signQuadrants = isMobile ? 1 : 4;
  for (let q = 0; q < signQuadrants; q++) {
    const baseTheta = q * (Math.PI * 0.5);
    for (const s of baseSignPattern) {
      signParts.push({
        geo: createCurvedWallSignageGeometry(
          s.text,
          s.h,
          s.spacing,
          0.055,
          wallRadius - 0.005,
          arcCenterZ,
          baseTheta + s.dTheta,
          s.y,
        ),
      });
    }
  }
  const signMesh = new Mesh(mergeSceneGeometries(signParts, true), signMat);
  signMesh.name = "static:signs_all";
  signMesh.castShadow = false;
  signMesh.receiveShadow = true;
  group.add(signMesh);

  // 2c. Upper Perimeter Studio Lighting Truss & Downward Wall Spotlight Cans
  const trussMat = new MeshStandardMaterial({
    color: 0x1e2028,
    roughness: 0.38,
    metalness: 0.75,
  });
  const spotLensMat = new MeshStandardMaterial({
    color: 0xfff8eb,
    emissive: 0xfff3d6,
    emissiveIntensity: 1.5,
    roughness: 0.15,
  });
  spotLensMat.name = "emitter:ceilingSpotLens";

  const trussRadius = 12.35;
  const trussY = 9.05;
  const lightingRail = new Mesh(
    new TorusGeometry(trussRadius, 0.045, 10, 72),
    trussMat,
  );
  lightingRail.name = "static:ceiling_light_rail";
  lightingRail.rotation.x = Math.PI / 2;
  lightingRail.position.set(0, trussY, 0);
  lightingRail.castShadow = false;
  group.add(lightingRail);

  const spotCanParts: MergeGeometryPart[] = [];
  const spotLensParts: MergeGeometryPart[] = [];
  for (let i = 0; i < 12; i++) {
    const theta = (i / 12) * Math.PI * 2;
    const sx = Math.sin(theta) * trussRadius;
    const sz = -Math.cos(theta) * trussRadius;
    const aimTarget: [number, number, number] = [
      Math.sin(theta) * wallRadius,
      4.9,
      -Math.cos(theta) * wallRadius,
    ];

    spotCanParts.push({
      geo: new CylinderGeometry(0.085, 0.11, 0.26, 14),
      pos: [sx, trussY - 0.16, sz],
      lookAt: aimTarget,
      preRotateX: Math.PI / 2,
    });
    spotLensParts.push({
      geo: new CylinderGeometry(0.078, 0.078, 0.02, 12),
      pos: [sx + Math.sin(theta) * 0.08, trussY - 0.25, sz - Math.cos(theta) * 0.08],
      lookAt: aimTarget,
      preRotateX: Math.PI / 2,
    });
  }
  const spotCansAll = new Mesh(mergeSceneGeometries(spotCanParts, true), trussMat);
  spotCansAll.name = "static:ceiling_cans_all";
  spotCansAll.castShadow = false;
  group.add(spotCansAll);

  const spotLensesAll = new Mesh(mergeSceneGeometries(spotLensParts), spotLensMat);
  spotLensesAll.castShadow = false;
  group.add(spotLensesAll);

  // Full 360-degree pastel periwinkle-blue wall-washer strip + upward additive beam
  const washerStripMat = new MeshStandardMaterial({
    color: 0x8f9ff0,
    emissive: 0x7688ea,
    emissiveIntensity: 1.65,
    roughness: 0.2,
    side: DoubleSide,
  });
  washerStripMat.name = "emitter:washerLed";
  const washerGeo = createCurvedCycloramaGeometry(
    wallRadius - 0.06,
    0.08,
    fullCircleArc,
    arcCenterZ,
    72,
  );
  const washerBar = new Mesh(washerGeo, washerStripMat);
  washerBar.position.set(0, 1.35, 0);
  washerBar.castShadow = false;
  group.add(washerBar);

  const washGlowMat = new MeshBasicMaterial({
    color: 0x8f9eff,
    map: createWashGlowTexture(),
    transparent: true,
    opacity: 0.36,
    side: DoubleSide,
  });
  washGlowMat.name = "additive:wallWashGlow";
  const washArcGeo = createCurvedCycloramaGeometry(
    wallRadius - 0.10,
    2.4,
    fullCircleArc,
    arcCenterZ,
    72,
  );
  const washArc = new Mesh(washArcGeo, washGlowMat);
  washArc.position.set(0, 1.36, 0);
  washArc.castShadow = false;
  group.add(washArc);

  // 3. Full 360-Degree Concentric 3-Tier Black & White Illuminated Stepped Risers
  const blackRecessMat = new MeshPhysicalMaterial({
    color: 0x1e2028,
    roughness: 0.45,
    metalness: 0.22,
    side: DoubleSide,
  });
  const whiteStepMat = new MeshPhysicalMaterial({
    color: 0xd9d7d5,
    roughness: 0.26,
    metalness: 0.04,
    clearcoat: 0.45,
    emissive: 0xcbd5e1,
    emissiveIntensity: 0.05,
    side: DoubleSide,
  });
  const stepLedMat = new MeshStandardMaterial({
    color: 0xf4f2ef,
    emissive: 0xe6e4e2,
    emissiveIntensity: 0.65,
    roughness: 0.2,
    side: DoubleSide,
  });
  stepLedMat.name = "emitter:stepLed";

  const circularTiers = [
    { rInner: 11.45, rOuter: 12.50, yBottom: 0.00, yTop: 0.45 },
    { rInner: 12.46, rOuter: 13.52, yBottom: 0.45, yTop: 0.90 },
    { rInner: 13.48, rOuter: 14.55, yBottom: 0.90, yTop: 1.35 },
  ];

  const blackTierParts: MergeGeometryPart[] = [];
  const whiteTierParts: MergeGeometryPart[] = [];
  const ledArcParts: MergeGeometryPart[] = [];
  circularTiers.forEach((t) => {
    const h = t.yTop - t.yBottom;
    blackTierParts.push({
      geo: createCurvedStepArcGeometry(t.rInner + 0.03, t.rOuter, h * 0.50, fullCircleArc, arcCenterZ, 64),
      pos: [0, t.yBottom, 0],
    });
    whiteTierParts.push({
      geo: createCurvedStepArcGeometry(t.rInner, t.rOuter, h * 0.50, fullCircleArc, arcCenterZ, 64),
      pos: [0, t.yBottom + h * 0.50, 0],
    });
    ledArcParts.push({
      geo: createCurvedCycloramaGeometry(t.rInner - 0.015, 0.028, fullCircleArc, arcCenterZ, 64),
      pos: [0, t.yBottom + h * 0.50, 0],
    });
  });

  const blackTiersAll = new Mesh(mergeSceneGeometries(blackTierParts, true), blackRecessMat);
  blackTiersAll.name = "static:tier_black_all";
  blackTiersAll.castShadow = false;
  blackTiersAll.receiveShadow = true;
  group.add(blackTiersAll);

  const whiteTiersAll = new Mesh(mergeSceneGeometries(whiteTierParts, true), whiteStepMat);
  whiteTiersAll.name = "static:tier_white_all";
  whiteTiersAll.castShadow = false;
  whiteTiersAll.receiveShadow = true;
  group.add(whiteTiersAll);

  const ledArcsAll = new Mesh(mergeSceneGeometries(ledArcParts), stepLedMat);
  ledArcsAll.castShadow = false;
  group.add(ledArcsAll);

  // 4. Sculpted High-FPS Lighting Rig (relying on baked GI lightmap for wall spotlights & perimeter wash)
  const keyLight = new DirectionalLight(0xfff8f0, 1.92);
  keyLight.position.set(3.4, 8.6, 7.8);
  keyLight.lookAt(0, 2.8, 0);
  keyLight.castShadow = !isMobile;
  group.add(keyLight);

  const fillLight = new DirectionalLight(0xf1f5ff, 0.95);
  fillLight.position.set(-5.0, 5.4, -5.8);
  fillLight.lookAt(0, 2.8, 0);
  fillLight.castShadow = false;
  group.add(fillLight);

  // Overhead hero machine spotlight illuminating top rack, acrylic globe & 49 balls cleanly
  const rackOverheadSpot = new SpotLight(0xfffcf7, 62, 12.0, Math.PI / 3.8, 0.65);
  rackOverheadSpot.position.set(0.35, 8.25, 2.85);
  rackOverheadSpot.lookAt(0, 3.25, -0.25);
  rackOverheadSpot.castShadow = false;
  group.add(rackOverheadSpot);

  return { group, washerLights: [] };
}
