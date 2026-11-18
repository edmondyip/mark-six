import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type {
  AnimationDesc,
  CameraDesc,
  Engine,
  EnvironmentDesc,
  LightDesc,
  MaterialDesc,
  ObjectDesc,
  SettingsDesc,
  SwayDesc,
  TextureDesc,
} from "@threert/scene";
import { createReflectiveStudioEnv } from "./sky";
import {
  buildNeutralUv1,
  buildStaticChartUv1,
  StaticGiLayout,
} from "../gi/lightmapAtlas";

interface MeshEntry {
  mesh: THREE.Mesh;
  materialId: number;
}

interface GeomMeta {
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: Uint32Array | null;
}

function flipRgbaTopDownToBottomUp(
  src: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const srcOffset = y * stride;
    const dstOffset = (height - 1 - y) * stride;
    out.set(src.subarray(srcOffset, srcOffset + stride), dstOffset);
  }
  return out;
}

function linearColor(rgb: readonly [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);
}

function computeRenderOrder(materialName: string, mat: THREE.Material): number {
  const lower = materialName.toLowerCase();
  if (lower.startsWith("additive:") && !lower.includes("softbox")) return 1;
  if (mat.transparent) {
    if (lower.includes("fresnel") || lower.includes("softbox")) {
      return 5;
    }
    if (lower.includes("outer") || lower === "drumouterglass") {
      return 4;
    }
    if (lower.includes("drum")) {
      return 3;
    }
    return 2;
  }
  return 0;
}

function isForegroundMachineTransparent(
  materialName: string,
  mat: THREE.Material,
): boolean {
  if (!mat.transparent) return false;
  const lower = materialName.toLowerCase();
  return (
    !lower.startsWith("host") &&
    lower !== "additive:wallwashglow" &&
    lower !== "additive:orangerimhalo"
  );
}

/**
 * Browser WebGL2 implementation of @threert/scene's Engine interface,
 * customized for HDR broadcast studio softbox reflections, transparent
 * layered acrylic/glass ordering, and interactive CameraDirector control.
 */
export class ThreeEngine implements Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly defaultCamera: THREE.PerspectiveCamera;

  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly geomMeta = new Map<number, GeomMeta>();
  private readonly textures = new Map<number, THREE.Texture>();
  private readonly materials = new Map<number, THREE.Material>();
  private readonly materialDescs = new Map<number, MaterialDesc>();
  private readonly objects = new Map<number, THREE.Object3D>();
  private readonly cameras = new Map<number, THREE.PerspectiveCamera>();
  private readonly lights = new Map<number, THREE.Light>();
  private readonly meshesByObj = new Map<number, MeshEntry>();

  private activeCamera: THREE.PerspectiveCamera;
  private studioEnvTexture: THREE.Texture;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly isMobile: boolean;
  private externalCameraOverride = false;
  private staticGiLayout: StaticGiLayout | null = null;
  private bakedAoTexture: THREE.Texture | null = null;
  private bakedLightMapTexture: THREE.Texture | null = null;

  private readonly dofFocusPoint = new THREE.Vector3(0, 2.85, 0);
  private readonly dofSceneTarget: THREE.WebGLRenderTarget;
  private readonly dofScene: THREE.Scene;
  private readonly dofOrthoCamera: THREE.OrthographicCamera;
  private readonly dofMaterial: THREE.ShaderMaterial;
  private readonly dofQuad: THREE.Mesh;
  private readonly hostStandees: THREE.Group[] = [];

  constructor(container: HTMLElement, options?: { isMobile?: boolean }) {
    this.isMobile = Boolean(options?.isMobile);
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isMobile,
      powerPreference: "high-performance",
      alpha: false,
    });
    const dpr = Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.0 : 1.25);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.00;
    this.renderer.shadowMap.enabled = !this.isMobile;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe4e7ee);

    this.hemiLight = new THREE.HemisphereLight(
      0xf1f5f9,
      0x7b82ad,
      this.isMobile ? 0.68 : 0.42,
    );
    this.hemiLight.layers.enableAll();
    this.scene.add(this.hemiLight);

    try {
      this.studioEnvTexture = createReflectiveStudioEnv(this.renderer);
    } catch {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.studioEnvTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    this.scene.environment = this.studioEnvTexture;

    this.defaultCamera = new THREE.PerspectiveCamera(
      38,
      width / Math.max(1, height),
      0.1,
      160,
    );
    this.defaultCamera.position.set(0, 3.8, 10.6);
    this.activeCamera = this.defaultCamera;

    const rtW = Math.max(1, Math.round(width * dpr));
    const rtH = Math.max(1, Math.round(height * dpr));
    const depthTexture = new THREE.DepthTexture(rtW, rtH, THREE.UnsignedIntType);
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.dofSceneTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.dofSceneTarget.depthTexture = depthTexture;

    this.dofOrthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.dofScene = new THREE.Scene();
    this.dofMaterial = new THREE.ShaderMaterial({
      toneMapped: true,
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      defines: {
        TAP_COUNT: this.isMobile ? 12 : 20,
      },
      uniforms: {
        tColor: { value: this.dofSceneTarget.texture },
        tDepth: { value: depthTexture },
        uNear: { value: this.defaultCamera.near },
        uFar: { value: this.defaultCamera.far },
        uFocusDist: { value: 10.6 },
        uFocalDepth: { value: 2.2 },
        uFarRange: { value: 9.5 },
        uMaxBlur: { value: 0.0065 },
        uAspect: { value: width / Math.max(1, height) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        uniform float uFocusDist;
        uniform float uFocalDepth;
        uniform float uFarRange;
        uniform float uMaxBlur;
        uniform float uAspect;
        varying vec2 vUv;

        float rawDepthToDist(float rawDepth) {
          float zNdc = rawDepth * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - zNdc * (uFar - uNear));
        }

        float computeCoc(float dist) {
          return smoothstep(
            uFocusDist + uFocalDepth,
            uFocusDist + uFocalDepth + uFarRange,
            dist
          );
        }

        void main() {
          float centerRawDepth = texture2D(tDepth, vUv).r;
          float centerDist = rawDepthToDist(centerRawDepth);
          float centerCoc = computeCoc(centerDist);
          vec3 centerColor = texture2D(tColor, vUv).rgb;
          vec3 accumColor = centerColor;

          if (uMaxBlur > 0.0002 && centerCoc > 0.004) {
            float blurRadius = centerCoc * uMaxBlur;
            vec3 sumColor = centerColor;
            float sumWeight = 1.0;
            const float GOLDEN_ANGLE = 2.39996323;

            for (int i = 1; i <= TAP_COUNT; i++) {
              float fi = float(i);
              float r = sqrt(fi / float(TAP_COUNT)) * blurRadius;
              float theta = fi * GOLDEN_ANGLE;
              vec2 offset = vec2(cos(theta) / max(uAspect, 0.001), sin(theta)) * r;
              vec2 sampleUv = clamp(vUv + offset, vec2(0.001), vec2(0.999));

              float sampleRawDepth = texture2D(tDepth, sampleUv).r;
              float sampleDist = rawDepthToDist(sampleRawDepth);
              float sampleCoc = computeCoc(sampleDist);
              float w = smoothstep(0.02, 0.25, sampleCoc);

              sumColor += texture2D(tColor, sampleUv).rgb * w;
              sumWeight += w;
            }

            accumColor = sumColor / sumWeight;
          }

          gl_FragColor = vec4(accumColor, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragDepth = centerRawDepth;
        }
      `,
    });
    this.dofQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.dofMaterial);
    this.dofQuad.frustumCulled = false;
    this.dofScene.add(this.dofQuad);
  }

  get renderCamera(): THREE.PerspectiveCamera {
    return this.activeCamera;
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setExternalCameraControl(enabled: boolean): void {
    this.externalCameraOverride = enabled;
  }

  /**
   * Registers offline three-mesh-bvh baked AO & multi-bounce GI maps for static geometry.
   * Must be called before node.setup() so static meshes receive non-overlapping uv1 charts.
   */
  setBakedStaticGI(
    layout: StaticGiLayout,
    aoTexture: THREE.Texture,
    lightMapTexture: THREE.Texture,
  ): void {
    aoTexture.channel = 1;
    aoTexture.colorSpace = THREE.NoColorSpace;
    aoTexture.minFilter = THREE.LinearFilter;
    aoTexture.magFilter = THREE.LinearFilter;
    aoTexture.generateMipmaps = false;
    aoTexture.needsUpdate = true;

    lightMapTexture.channel = 1;
    lightMapTexture.colorSpace = THREE.SRGBColorSpace;
    lightMapTexture.minFilter = THREE.LinearFilter;
    lightMapTexture.magFilter = THREE.LinearFilter;
    lightMapTexture.generateMipmaps = false;
    lightMapTexture.needsUpdate = true;

    this.staticGiLayout = layout;
    this.bakedAoTexture = aoTexture;
    this.bakedLightMapTexture = lightMapTexture;
    // Lower uniform hemisphere ambient fill since baked BVH lightmap supplies true bounce GI
    this.hemiLight.intensity = 0.24;
  }

  /**
   * Mounts photographic alpha-feathered studio host standees on the studio floor
   * with vertical lighting gradient, glossy floor reflection, and Y-axis billboarding.
   */
  setHostStandees(maleTex: THREE.Texture, femaleTex: THREE.Texture): void {
    const specs: Array<{
      name: string;
      tex: THREE.Texture;
      pos: [number, number, number];
      height: number;
      aspect: number;
    }> = [
      {
        name: "hostStandeeMale",
        tex: maleTex,
        pos: [-3.80, 0, -7.8],
        height: 4.65,
        aspect: 369 / 960,
      },
      {
        name: "hostStandeeFemale",
        tex: femaleTex,
        pos: [3.80, 0, -7.8],
        height: 4.42,
        aspect: 239 / 929,
      },
    ];

    for (const spec of specs) {
      spec.tex.colorSpace = THREE.SRGBColorSpace;
      spec.tex.anisotropy = this.isMobile
        ? 1
        : Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      spec.tex.needsUpdate = true;

      const width = spec.height * spec.aspect;
      const hostGroup = new THREE.Group();
      hostGroup.name = spec.name;
      hostGroup.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);

      // Upright photographic standee with rich contrast, directional 3-point shading & feathered alpha
      const standeeMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        uniforms: {
          uMap: { value: spec.tex },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          varying vec2 vUv;
          void main() {
            vec4 tex = texture2D(uMap, vUv);
            if (tex.a < 0.04) discard;
            // Deepen contrast/saturation so photographic hosts match dark studio contrast
            vec3 richCol = pow(max(tex.rgb, vec3(0.0001)), vec3(1.18)) * 0.66;
            // Directional shading matching keyLight from front-right (+x, +y)
            float vGrad = mix(0.72, 1.04, smoothstep(0.0, 0.78, vUv.y));
            float hGrad = mix(0.80, 1.06, smoothstep(0.15, 0.85, vUv.x));
            vec3 studioTint = vec3(0.96, 0.97, 1.02) * vGrad * hGrad;
            gl_FragColor = vec4(richCol * studioTint, tex.a);
          }
        `,
      });
      standeeMat.name = "hostStandeeMat";
      const standeeMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, spec.height),
        standeeMat,
      );
      standeeMesh.position.set(0, spec.height * 0.5, 0);
      // Cast real-time directional keyLight human-silhouette shadow onto both the studio floor and rear staircase steps
      standeeMesh.castShadow = !this.isMobile;
      standeeMesh.customDepthMaterial = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
          uMap: { value: spec.tex },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying vec2 vHighPrecisionZW;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            vHighPrecisionZW = gl_Position.zw;
          }
        `,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D uMap;
          varying vec2 vUv;
          varying vec2 vHighPrecisionZW;
          void main() {
            if (texture2D(uMap, vUv).a < 0.35) discard;
            float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;
            gl_FragColor = packDepthToRGBA(fragCoordZ);
          }
        `,
      });
      standeeMesh.receiveShadow = false;
      standeeMesh.layers.set(0);
      hostGroup.add(standeeMesh);

      // Glossy epoxy floor mirror reflection fading smoothly behind the host's shoes
      const reflLen = spec.height * 0.56;
      const reflMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uMap: { value: spec.tex },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          varying vec2 vUv;
          void main() {
            // Sample near bottom of host texture (feet -> knees) mirrored onto floor
            vec2 sampleUv = vec2(vUv.x, (1.0 - vUv.y) * 0.65);
            vec4 tex = texture2D(uMap, sampleUv);
            float fade = pow(vUv.y, 2.2) * 0.22;
            float a = tex.a * fade;
            if (a < 0.005) discard;
            gl_FragColor = vec4(tex.rgb * vec3(0.75, 0.78, 0.88), a);
          }
        `,
      });
      reflMat.name = "hostFloorReflectionMat";
      const reflMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, reflLen),
        reflMat,
      );
      reflMesh.rotation.x = -Math.PI / 2;
      reflMesh.position.set(0, 0.004, -reflLen * 0.5);
      reflMesh.castShadow = false;
      reflMesh.receiveShadow = false;
      reflMesh.layers.set(0);
      hostGroup.add(reflMesh);

      this.scene.add(hostGroup);
      this.hostStandees.push(hostGroup);
    }
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const dpr = Math.min(window.devicePixelRatio || 1, this.isMobile ? 1.0 : 1.25);
    const aspect = w / h;
    this.defaultCamera.aspect = aspect;
    this.defaultCamera.updateProjectionMatrix();
    for (const cam of this.cameras.values()) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    const rtW = Math.max(1, Math.round(w * dpr));
    const rtH = Math.max(1, Math.round(h * dpr));
    this.dofSceneTarget.setSize(rtW, rtH);
    this.dofMaterial.uniforms.uAspect.value = aspect;
  }

  render(): void {
    const camPos = this.activeCamera.position;
    for (const standee of this.hostStandees) {
      standee.rotation.y = Math.atan2(
        camPos.x - standee.position.x,
        camPos.z - standee.position.z,
      );
    }

    const focusDist = camPos.distanceTo(this.dofFocusPoint);
    const wideT = THREE.MathUtils.smoothstep(focusDist, 6.8, 9.6);
    const focalDepth = THREE.MathUtils.lerp(2.2, 8.4, wideT);
    const farRange = THREE.MathUtils.lerp(9.5, 7.5, wideT);
    const maxBlur = THREE.MathUtils.lerp(
      THREE.MathUtils.clamp(0.068 / Math.max(3.8, focusDist), 0.0064, 0.0115),
      0.0028,
      wideT,
    );
    this.dofMaterial.uniforms.uFocusDist.value = focusDist;
    this.dofMaterial.uniforms.uFocalDepth.value = focalDepth;
    this.dofMaterial.uniforms.uFarRange.value = farRange;
    this.dofMaterial.uniforms.uNear.value = this.activeCamera.near;
    this.dofMaterial.uniforms.uFar.value = this.activeCamera.far;
    this.dofMaterial.uniforms.uMaxBlur.value = maxBlur;

    // Pass 1: Render Layer 0 (studio, hosts, signage, opaque balls & machine body) into linear HDR target + depth
    this.activeCamera.layers.set(0);
    this.renderer.setRenderTarget(this.dofSceneTarget);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.activeCamera);

    // Pass 2: Screen-space Bokeh DoF composite + AgX tone mapping + preserve Layer 0 hardware depth via gl_FragDepth
    this.renderer.setRenderTarget(null);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.dofScene, this.dofOrthoCamera);

    // Pass 3: Render Layer 1 (razor-sharp foreground machine acrylic rack, tracks & glass drum) directly over depth buffer
    const prevBg = this.scene.background;
    const prevAutoClear = this.renderer.autoClear;
    const prevShadowAuto = this.renderer.shadowMap.autoUpdate;
    this.scene.background = null;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.autoUpdate = false;
    this.activeCamera.layers.set(1);
    this.renderer.render(this.scene, this.activeCamera);
    this.scene.background = prevBg;
    this.renderer.autoClear = prevAutoClear;
    this.renderer.shadowMap.autoUpdate = prevShadowAuto;
    this.activeCamera.layers.enableAll();
  }

  getRenderStats() {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
      pixelRatio: this.renderer.getPixelRatio(),
    };
  }

  geometry(
    id: number,
    positions: Float32Array,
    normals: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    groups?: Uint32Array | null,
    colors?: Float32Array | null,
  ): void {
    this.geometries.get(id)?.dispose();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (normals.length > 0) {
      geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    }
    if (uvs.length > 0) {
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    }
    if (colors && colors.length > 0) {
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    if (groups && groups.length >= 3) {
      for (let i = 0; i < groups.length; i += 3) {
        geo.addGroup(groups[i], groups[i + 1], groups[i + 2]);
      }
    }
    if (normals.length === 0) {
      geo.computeVertexNormals();
    }

    const vertCount = positions.length / 3;
    const neutralUv = this.staticGiLayout?.neutralUv ?? [0.002, 0.002];
    geo.setAttribute(
      "uv1",
      new THREE.BufferAttribute(buildNeutralUv1(vertCount, neutralUv), 2),
    );

    if (this.staticGiLayout) {
      this.geomMeta.set(id, {
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
        groups: groups ? new Uint32Array(groups) : null,
      });
    }

    this.geometries.set(id, geo);
  }

  texture(id: number, desc: TextureDesc, data: Uint8Array | null): void {
    this.textures.get(id)?.dispose();

    if (!data || !desc.size) {
      // Procedural runtime does not load external files
      const fallback = new Uint8Array([255, 255, 255, 255]);
      const tex = new THREE.DataTexture(fallback, 1, 1, THREE.RGBAFormat);
      tex.needsUpdate = true;
      this.textures.set(id, tex);
      return;
    }

    const w = Math.max(1, Math.round(desc.size[0]));
    const h = Math.max(1, Math.round(desc.size[1]));
    const flipped = flipRgbaTopDownToBottomUp(data, w, h);

    const tex = new THREE.DataTexture(flipped, w, h, THREE.RGBAFormat);
    tex.colorSpace = desc.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.flipY = false;
    tex.wrapS = desc.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.wrapT = desc.wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.repeat.set(desc.repeat[0], desc.repeat[1]);
    tex.offset.set(desc.offset[0], desc.offset[1]);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.isMobile
      ? 1
      : Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;

    this.textures.set(id, tex);
  }

  material(id: number, desc: MaterialDesc): void {
    const prevMat = this.materials.get(id);
    this.materialDescs.set(id, desc);

    const lowerName = (desc.name || "").toLowerCase();
    const isAdditive =
      lowerName.startsWith("additive:") || lowerName === "drumouterglass";
    const isTransparent =
      isAdditive || Boolean(desc.transparent) || desc.opacity < 1;

    // Fast in-place update when only scalar/color properties changed (avoids per-frame dispose/recompile)
    if (
      prevMat instanceof THREE.MeshPhysicalMaterial &&
      !desc.unlit &&
      lowerName !== "drumfresnelrim" &&
      lowerName !== "druminneracrylicwall" &&
      lowerName !== "drumouterglass" &&
      prevMat.transparent === isTransparent
    ) {
      prevMat.color.setRGB(
        desc.color[0],
        desc.color[1],
        desc.color[2],
        THREE.LinearSRGBColorSpace,
      );
      prevMat.emissive.setRGB(
        desc.emissive[0],
        desc.emissive[1],
        desc.emissive[2],
        THREE.LinearSRGBColorSpace,
      );
      prevMat.emissiveIntensity = desc.emissiveIntensity;
      prevMat.metalness = desc.metalness;
      prevMat.roughness = desc.roughness;
      prevMat.opacity = desc.opacity;
      return;
    }

    prevMat?.dispose();

    const mapTex = desc.map !== undefined ? this.textures.get(desc.map) ?? null : null;
    const emissiveMapTex =
      desc.emissiveMap !== undefined
        ? this.textures.get(desc.emissiveMap) ?? null
        : null;
    const normalMapTex =
      desc.normalMap !== undefined
        ? this.textures.get(desc.normalMap) ?? null
        : null;
    const roughnessMapTex =
      desc.roughnessMap !== undefined
        ? this.textures.get(desc.roughnessMap) ?? null
        : null;
    const metalnessMapTex =
      desc.metalnessMap !== undefined
        ? this.textures.get(desc.metalnessMap) ?? null
        : null;
    const aoMapTex =
      desc.aoMap !== undefined ? this.textures.get(desc.aoMap) ?? null : null;

    let mat: THREE.Material;
    if (lowerName === "drumfresnelrim" || lowerName === "druminneracrylicwall") {
      const isInner = lowerName === "druminneracrylicwall";
      // Dual-shell physical Fresnel shader integrated with studio bounce (warm platter bottom + studio crown)
      mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: isInner ? THREE.BackSide : THREE.FrontSide,
        vertexShader: /* glsl */ `
          varying vec3 vNormalView;
          varying vec3 vViewPos;
          varying vec3 vWorldPos;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vWorldPos = worldPos.xyz;
            vec4 mvPos = viewMatrix * worldPos;
            vViewPos = -mvPos.xyz;
            vNormalView = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: isInner
          ? /* glsl */ `
            varying vec3 vNormalView;
            varying vec3 vViewPos;
            varying vec3 vWorldPos;
            void main() {
              vec3 N = normalize(vNormalView);
              vec3 V = normalize(vViewPos);
              float ndotv = clamp(abs(dot(N, V)), 0.0, 1.0);
              float innerEdge = pow(1.0 - ndotv, 5.2);
              float crispLip = smoothstep(0.72, 0.98, 1.0 - ndotv);
              float heightFrac = clamp((vWorldPos.y - 1.82) / 2.80, 0.0, 1.0);
              float bottomGlow = pow(1.0 - heightFrac, 2.6);
              float topCatch = pow(heightFrac, 2.2);
              vec3 coolTint = vec3(0.76, 0.90, 0.98);
              vec3 warmBounce = vec3(1.0, 0.56, 0.24);
              vec3 innerTint = mix(coolTint, warmBounce, bottomGlow * 0.45);
              innerTint = mix(innerTint, vec3(1.0, 0.98, 0.94), topCatch * crispLip * 0.42);
              float alpha = clamp(innerEdge * (0.34 + bottomGlow * 0.14) + crispLip * 0.18, 0.0, 0.52);
              gl_FragColor = vec4(innerTint, alpha);
            }
          `
          : /* glsl */ `
            varying vec3 vNormalView;
            varying vec3 vViewPos;
            varying vec3 vWorldPos;
            void main() {
              vec3 N = normalize(vNormalView);
              vec3 V = normalize(vViewPos);
              float ndotv = clamp(abs(dot(N, V)), 0.0, 1.0);
              float rim = pow(1.0 - ndotv, 5.4);
              float outerEdgeBand = smoothstep(0.76, 0.99, 1.0 - ndotv);
              float heightFrac = clamp((vWorldPos.y - 1.82) / 2.80, 0.0, 1.0);
              float bottomGlow = pow(1.0 - heightFrac, 2.8);
              float topCatch = pow(heightFrac, 2.0);
              vec3 baseGlass = mix(vec3(0.80, 0.93, 0.98), vec3(1.0, 0.64, 0.30), bottomGlow * 0.38);
              vec3 glassTint = mix(baseGlass, vec3(1.0, 0.99, 0.97), outerEdgeBand * (0.72 + 0.28 * topCatch));
              float alpha = clamp(rim * (0.44 + bottomGlow * 0.12) + outerEdgeBand * 0.36, 0.0, 0.74);
              gl_FragColor = vec4(glassTint, alpha);
            }
          `,
      });
    } else if (desc.unlit) {
      const basic = new THREE.MeshBasicMaterial({
        color: linearColor(desc.color),
        map: mapTex,
        opacity: desc.opacity,
        transparent: isTransparent,
        depthWrite: !isTransparent,
        side: desc.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        vertexColors: Boolean(desc.vertexColors),
      });
      if (isAdditive) {
        basic.blending = THREE.AdditiveBlending;
        basic.depthWrite = false;
        basic.transparent = true;
      }
      if (desc.alphaTest !== undefined) {
        basic.alphaTest = desc.alphaTest;
      }
      mat = basic;
    } else {
      const phys = new THREE.MeshPhysicalMaterial({
        color: linearColor(desc.color),
        emissive: linearColor(desc.emissive),
        emissiveIntensity: desc.emissiveIntensity,
        metalness: desc.metalness,
        roughness: desc.roughness,
        opacity: desc.opacity,
        transparent: isTransparent,
        depthWrite: !isTransparent,
        side: desc.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        vertexColors: Boolean(desc.vertexColors),
        map: mapTex,
        emissiveMap: emissiveMapTex,
        normalMap: normalMapTex,
        roughnessMap: roughnessMapTex,
        metalnessMap: metalnessMapTex,
        aoMap:
          aoMapTex ??
          (!isTransparent && !lowerName.startsWith("emitter:")
            ? this.bakedAoTexture
            : null),
        aoMapIntensity: aoMapTex ? 1.0 : 0.78,
        lightMap:
          !isTransparent && !lowerName.startsWith("emitter:")
            ? this.bakedLightMapTexture
            : null,
        lightMapIntensity: 1.42,
        clearcoat: desc.clearcoat ?? 0,
        clearcoatRoughness: desc.clearcoatRoughness ?? 0.08,
        ior: desc.ior ?? 1.5,
        reflectivity: lowerName.includes("glass") || lowerName.includes("track") || lowerName.includes("rack") || lowerName.includes("tube") ? 1.0 : 0.85,
        transmission: desc.transmission ?? 0,
        specularIntensity: desc.specularIntensity ?? 1.0,
        envMapIntensity:
          lowerName === "drumouterglass"
            ? 1.12
            : lowerName.includes("track") || lowerName.includes("tube") || lowerName.includes("rack") || lowerName.includes("agitator")
              ? 1.25
              : 1.05,
      });
      const isClearAcrylic =
        isTransparent &&
        !isAdditive &&
        (lowerName.includes("track") ||
          lowerName.includes("tube") ||
          lowerName.includes("rack") ||
          lowerName.includes("agitator"));
      if (isClearAcrylic) {
        phys.premultipliedAlpha = true;
        phys.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader
            .replace(
              "#include <opaque_fragment>",
              `
              float acrylicNdotV = clamp(abs(dot(normal, geometryViewDir)), 0.0, 1.0);
              float acrylicFresnel = 0.04 + 0.96 * pow(1.0 - acrylicNdotV, 4.8);
              float edgeLip = smoothstep(0.58, 0.98, 1.0 - acrylicNdotV);
              float faceScale = gl_FrontFacing ? 1.0 : 0.42;
              vec3 specRaw = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
              vec3 specCrisp = specRaw / (vec3(1.0) + specRaw * 0.42);
              vec3 edgeGlassTint = vec3(0.78, 0.91, 0.99) * edgeLip * 0.24 * faceScale;
              outgoingLight = specCrisp * (0.28 + 1.15 * acrylicFresnel) * faceScale + edgeGlassTint;
              float acrylicEdgeAlpha = clamp((0.02 + acrylicFresnel * 0.52 + edgeLip * 0.24) * faceScale, 0.015, 0.68);
              gl_FragColor = vec4( outgoingLight, acrylicEdgeAlpha );
              `,
            )
            .replace(
              "#include <premultiplied_alpha_fragment>",
              "// specular-preserving premultiplied alpha handled above",
            );
        };
        phys.customProgramCacheKey = () => "clear-acrylic-fresnel-v3";
      } else if (
        lowerName === "emitter:orangeled" ||
        lowerName === "additive:orangerimhalo"
      ) {
        const isHalo = lowerName === "additive:orangerimhalo";
        phys.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <emissivemap_fragment>",
            isHalo
              ? `
              #include <emissivemap_fragment>
              float haloFacing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
              float haloCenterGrad = mix(0.10, 1.45, pow(haloFacing, 2.2));
              totalEmissiveRadiance *= haloCenterGrad;
              diffuseColor.a *= haloCenterGrad;
              `
              : `
              #include <emissivemap_fragment>
              float ledFacing = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
              float ledCenterFalloff = mix(0.28, 1.72, pow(ledFacing, 1.85));
              totalEmissiveRadiance *= ledCenterFalloff;
              totalEmissiveRadiance += vec3(0.28, 0.12, 0.02) * pow(ledFacing, 3.0) * length(totalEmissiveRadiance);
              `,
          );
        };
        phys.customProgramCacheKey = () =>
          isHalo ? "orange-rim-halo-grad-v1" : "orange-led-center-grad-v1";
      }
      if (desc.normalScale && normalMapTex) {
        phys.normalScale.set(desc.normalScale[0], desc.normalScale[1]);
      }
      if (isAdditive) {
        phys.blending = THREE.AdditiveBlending;
        phys.depthWrite = false;
        phys.transparent = true;
      }
      if (desc.alphaTest !== undefined) {
        phys.alphaTest = desc.alphaTest;
      }
      mat = phys;
    }

    mat.name = desc.name;
    this.materials.set(id, mat);

    for (const entry of this.meshesByObj.values()) {
      if (entry.materialId === id) {
        entry.mesh.material = mat;
        entry.mesh.renderOrder = computeRenderOrder(desc.name, mat);
        entry.mesh.layers.set(isForegroundMachineTransparent(desc.name, mat) ? 1 : 0);
      }
    }
  }

  object(id: number, desc: ObjectDesc): void {
    const existing = this.objects.get(id);
    if (existing) {
      existing.parent?.remove(existing);
    }

    let obj: THREE.Object3D;
    if (desc.kind === "group") {
      obj = new THREE.Group();
    } else if (desc.kind === "mesh") {
      const geo = this.geometries.get(desc.geometry);
      const mat = this.materials.get(desc.material);
      if (!geo || !mat) {
        obj = new THREE.Group();
      } else {
        const chart = this.staticGiLayout?.charts[desc.name];
        const meta = this.geomMeta.get(desc.geometry);
        const posAttr = geo.getAttribute("position");
        if (chart && meta && posAttr && posAttr.count === chart.vertexCount) {
          const chartUv1 = buildStaticChartUv1(
            meta.normals,
            meta.uvs,
            meta.indices,
            chart.rect,
            chart.unpackMode,
            meta.groups,
          );
          geo.setAttribute("uv1", new THREE.BufferAttribute(chartUv1, 2));
        }

        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = desc.castShadow && !mat.transparent;
        mesh.receiveShadow = !mat.transparent;
        const matName = this.materialDescs.get(desc.material)?.name ?? "";
        mesh.renderOrder = computeRenderOrder(matName, mat);
        mesh.layers.set(isForegroundMachineTransparent(matName, mat) ? 1 : 0);
        this.meshesByObj.set(id, { mesh, materialId: desc.material });
        obj = mesh;
      }
    } else if (desc.kind === "light") {
      const lightObj = this.buildLightObject(desc.light);
      this.lights.set(id, lightObj);
      obj = lightObj;
    } else if (desc.kind === "camera") {
      const aspect =
        this.renderer.domElement.width /
        Math.max(1, this.renderer.domElement.height);
      const cam = new THREE.PerspectiveCamera(
        desc.camera.fov,
        aspect,
        desc.camera.near,
        desc.camera.far,
      );
      this.cameras.set(id, cam);
      obj = cam;
    } else {
      obj = new THREE.Group();
    }

    obj.name = desc.name;
    this.objects.set(id, obj);

    if (desc.parent !== null) {
      const parentObj = this.objects.get(desc.parent);
      if (parentObj) {
        parentObj.add(obj);
      } else {
        this.scene.add(obj);
      }
    } else {
      this.scene.add(obj);
    }
  }

  transform(id: number, trs: Float32Array): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    if (this.externalCameraOverride && obj === this.activeCamera) {
      return;
    }
    obj.position.set(trs[0], trs[1], trs[2]);
    obj.quaternion.set(trs[3], trs[4], trs[5], trs[6]);
    obj.scale.set(trs[7], trs[8], trs[9]);
  }

  visible(id: number, visible: boolean): void {
    const obj = this.objects.get(id);
    if (obj) obj.visible = visible;
  }

  power(id: number, power: number): void {
    const light = this.lights.get(id);
    if (light) {
      light.visible = power > 0;
    }
  }

  light(id: number, desc: LightDesc): void {
    const prev = this.lights.get(id);

    // Fast in-place update for live light intensity/color pulsing without dispose/rebuild
    if (
      prev &&
      prev.castShadow === desc.castShadow &&
      ((desc.type === "point" && prev instanceof THREE.PointLight) ||
        (desc.type === "directional" && prev instanceof THREE.DirectionalLight) ||
        (desc.type === "spot" && prev instanceof THREE.SpotLight))
    ) {
      prev.color.setRGB(
        desc.color[0],
        desc.color[1],
        desc.color[2],
        THREE.LinearSRGBColorSpace,
      );
      prev.intensity = desc.intensity;
      if (desc.type === "point" && prev instanceof THREE.PointLight) {
        prev.distance = desc.range || 0;
      } else if (desc.type === "spot" && prev instanceof THREE.SpotLight) {
        prev.distance = desc.range || 0;
        prev.angle = desc.angle;
        prev.penumbra = desc.penumbra;
      }
      return;
    }

    const parent = prev?.parent ?? this.scene;
    const pos = prev?.position.clone() ?? new THREE.Vector3();
    const quat = prev?.quaternion.clone() ?? new THREE.Quaternion();
    const vis = prev?.visible ?? true;

    if (prev) {
      parent.remove(prev);
      prev.dispose();
    }

    const next = this.buildLightObject(desc);
    next.position.copy(pos);
    next.quaternion.copy(quat);
    next.visible = vis;
    parent.add(next);
    this.lights.set(id, next);
    this.objects.set(id, next);
  }

  camera(id: number, desc: CameraDesc): void {
    const cam = this.cameras.get(id);
    if (!cam) return;
    cam.fov = desc.fov;
    cam.near = desc.near;
    cam.far = desc.far;
    cam.updateProjectionMatrix();

    if (desc.exposure.mode === "manual") {
      this.renderer.toneMappingExposure =
        1.16 * Math.pow(2, -desc.exposure.ev100 * 0.25);
    }
  }

  environment(desc: EnvironmentDesc): void {
    this.scene.background = new THREE.Color(0xe4e7ee);
    if (desc.fog) {
      const fogColor = linearColor(desc.fog.color);
      this.scene.fog = new THREE.FogExp2(fogColor.getHex(), desc.fog.density);
    }
    // Keep softbox studio PMREM reflections active
    this.scene.environment = this.studioEnvTexture;
  }

  settings(desc: SettingsDesc): void {
    const cam = this.cameras.get(desc.camera);
    if (cam) {
      this.activeCamera = cam;
    }
  }

  remove(id: number): void {
    const obj = this.objects.get(id);
    if (obj) {
      obj.parent?.remove(obj);
      this.objects.delete(id);
    }
    this.meshesByObj.delete(id);
    this.cameras.delete(id);
    const light = this.lights.get(id);
    if (light) {
      light.dispose();
      this.lights.delete(id);
    }
  }

  // Required Engine stubs for WASM-only shader/particle/physics ops
  shader(): void {}
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
  sway(_id: number, _desc: SwayDesc | null): void {}
  animation(_id: number, _desc: AnimationDesc | null): void {}
  instances(): void {}

  destroy(): void {
    for (const hostGroup of this.hostStandees) {
      hostGroup.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (child.customDepthMaterial) {
            child.customDepthMaterial.dispose();
          }
          child.geometry.dispose();
          const mat = child.material as THREE.ShaderMaterial;
          if (mat.uniforms?.uMap?.value instanceof THREE.Texture) {
            mat.uniforms.uMap.value.dispose();
          }
          mat.dispose();
        }
      });
    }
    this.hostStandees.length = 0;
    this.dofSceneTarget.depthTexture?.dispose();
    this.dofSceneTarget.dispose();
    this.dofQuad.geometry.dispose();
    this.dofMaterial.dispose();
    this.bakedAoTexture?.dispose();
    this.bakedLightMapTexture?.dispose();
    this.studioEnvTexture.dispose();
    this.geometries.forEach((g) => g.dispose());
    this.textures.forEach((t) => t.dispose());
    this.materials.forEach((m) => m.dispose());
    this.lights.forEach((l) => l.dispose());
    this.renderer.dispose();
  }

  private buildLightObject(desc: LightDesc): THREE.Light {
    const lightObj = this.createLightObject(desc);
    lightObj.layers.enableAll();
    return lightObj;
  }

  private createLightObject(desc: LightDesc): THREE.Light {
    const color = linearColor(desc.color);
    switch (desc.type) {
      case "directional": {
        const dir = new THREE.DirectionalLight(color, desc.intensity);
        dir.castShadow = desc.castShadow;
        dir.target.position.set(0, 0, -1);
        dir.add(dir.target);
        if (dir.castShadow) {
          dir.shadow.mapSize.set(2048, 2048);
          dir.shadow.camera.near = 0.5;
          dir.shadow.camera.far = 35;
          const b = 10.5;
          dir.shadow.camera.left = -b;
          dir.shadow.camera.right = b;
          dir.shadow.camera.top = b;
          dir.shadow.camera.bottom = -b;
          dir.shadow.bias = -0.0005;
        }
        return dir;
      }
      case "point": {
        const pt = new THREE.PointLight(
          color,
          desc.intensity,
          desc.range || 0,
          2,
        );
        pt.castShadow = desc.castShadow;
        if (pt.castShadow) {
          pt.shadow.mapSize.set(1024, 1024);
          pt.shadow.bias = -0.0005;
        }
        return pt;
      }
      case "spot": {
        const sp = new THREE.SpotLight(
          color,
          desc.intensity,
          desc.range || 0,
          desc.angle,
          desc.penumbra,
          2,
        );
        sp.castShadow = desc.castShadow;
        sp.target.position.set(0, 0, -1);
        sp.add(sp.target);
        if (sp.castShadow) {
          sp.shadow.mapSize.set(1024, 1024);
          sp.shadow.bias = -0.0005;
        }
        return sp;
      }
      case "rect": {
        const rect = new THREE.RectAreaLight(
          color,
          desc.intensity,
          desc.width,
          desc.height,
        );
        return rect;
      }
    }
  }
}
