import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const CAR_LENGTH = 4.6;

// Shared by every patched material, so one write updates the whole car.
export const dirtUniforms = {
  uWash: { value: 10 },   // world z of the wash front; z above it is clean
  uFoam: { value: 0 },    // suds visibility, fades out after the rinse
  uSwirl: { value: 0 },   // polish defects on clean paint
  uCarH: { value: 1.2 },
  uCarMinZ: { value: -3 },
  uNoiseTex: { value: null },
};

// Tileable random values in a small 3D texture: hardware trilinear filtering
// turns one texture fetch into one octave of value noise.
function createNoiseTexture(size = 32) {
  const data = new Uint8Array(size * size * size);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 255;
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
dirtUniforms.uNoiseTex.value = createNoiseTexture();

const NOISE_GLSL = /* glsl */ `
uniform float uWash;
uniform float uFoam;
uniform float uSwirl;
uniform float uCarH;
uniform float uDirtStrength;
varying vec3 vDirtPos;
varying vec3 vDirtNrm;

float dHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
uniform float uCarMinZ;
uniform highp sampler3D uNoiseTex;

// value noise from the 32^3 texture, smoothstep weights so the grid does not show
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoiseTex, (i + f + 0.5) / 32.0).r;
}
// octaves are rotated against each other to hide axis-aligned artefacts
const mat3 octRot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = octRot * p * 2.03; a *= 0.5; }
  return s / 0.9375;
}
float fbm3(vec3 p) {
  float s = vnoise(p) * 0.5;
  p = octRot * p * 2.03;
  s += vnoise(p) * 0.25;
  p = octRot * p * 2.03;
  s += vnoise(p) * 0.125;
  return s / 0.875;
}
`;

const DIRT_MASK_GLSL = /* glsl */ `
  vec3 dp = vDirtPos;
  float dirt = 0.0;
  float foam = 0.0;
  float n2 = 0.5;
  float streak = 0.5;

  // Skip every noise lookup once the wash front has passed the whole car and the suds are gone,
  // and on parts that never get dirty (interior). Uniform-only, so it never diverges.
  bool dirtActive = uDirtStrength > 0.0 && (uWash > uCarMinZ - 0.6 || uFoam > 0.0);
  if (dirtActive) {
    // ragged wash front
    float edgeN = (fbm3(dp * 3.0 + 7.0) - 0.5) * 0.45 + (vnoise(dp * 20.0) - 0.5) * 0.06;
    float e = dp.z - uWash + edgeN;

    if (e < 0.02) {
      float n1 = fbm(dp * 1.6);
      n2 = fbm3(dp * 5.0 + 3.1);
      // vertical drip streaks plus heavier mud low on the body
      streak = fbm3(vec3(dp.x * 6.0, dp.y * 0.8, dp.z * 6.0));
      float low = 1.0 - smoothstep(uCarH * 0.1, uCarH * 0.95, dp.y);
      float dirtBase = 0.55 + 0.5 * low + (n1 - 0.5) * 0.9 + (streak - 0.5) * 0.5;
      dirtBase = smoothstep(0.15, 0.55, dirtBase);
      dirt = dirtBase * (1.0 - smoothstep(-0.015, 0.015, e)) * uDirtStrength;
    }

    if (uFoam > 0.0 && e > -0.3 && e < 0.75) {
      float suds = smoothstep(0.55, 0.8, vnoise(dp * 34.0)) * 0.6 + smoothstep(0.45, 0.85, fbm3(dp * 9.0)) * 0.7;
      foam = exp(-abs(e) * 16.0) * 0.95 + suds * step(0.0, e) * smoothstep(0.7, 0.0, e);
      foam = clamp(foam * uFoam, 0.0, 1.0) * uDirtStrength;
    }
  }

  // swirl marks: scratch arcs around random centres, on the plane facing the camera most
  float swirl = 0.0;
  if (uSwirl > 0.001) {
    vec2 q = mix(dp.zy, dp.xz, step(0.6, abs(vDirtNrm.y)));
    vec2 cell = floor(q * 2.0);
    vec2 c = (cell + 0.5 + (vec2(dHash(vec3(cell, 1.0)), dHash(vec3(cell, 2.0))) - 0.5) * 0.6) / 2.0;
    vec2 d = q - c;
    float r = length(d);
    float ang = atan(d.y, d.x);
    float rings = vnoise(vec3(r * 260.0, ang * 1.5, cell.x + cell.y * 7.0));
    swirl = smoothstep(0.8, 0.96, rings) * smoothstep(0.01, 0.08, r) * uSwirl * (1.0 - dirt) * uDirtStrength;
  }
`;

function patchMaterial(material, strength) {
  material.userData.dirtStrength = { value: strength };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, dirtUniforms, { uDirtStrength: material.userData.dirtStrength });

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDirtPos;\nvarying vec3 vDirtNrm;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vDirtPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vDirtNrm = normalize(mat3(modelMatrix) * objectNormal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE_GLSL)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n' + DIRT_MASK_GLSL)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (dirt > 0.001) {
          vec3 mud = mix(vec3(0.12, 0.1, 0.078), vec3(0.26, 0.225, 0.18), smoothstep(0.25, 0.75, n2));
          mud = mix(mud, vec3(0.38, 0.34, 0.28), smoothstep(0.62, 0.82, fbm3(dp * 11.0)) * 0.45);
          mud = mix(mud, mud * 0.55, smoothstep(0.5, 0.8, streak) * 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, mud, dirt);
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85), foam * 0.85);
        diffuseColor.rgb += swirl * 0.012;
        diffuseColor.a = max(diffuseColor.a, max(dirt * 0.97, foam));`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.9, dirt);
        roughnessFactor = mix(roughnessFactor, 0.4, foam);
        roughnessFactor = min(1.0, roughnessFactor + swirl * 0.15);`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.0, max(dirt, foam));`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (dirtActive) {
          // crusty mud relief, bump mapping from a procedural height
          // fade the relief out with distance: screen derivatives are per 2x2 quad and turn blocky when far
          float px = length(fwidth(dp));
          float near = 1.0 - smoothstep(0.0015, 0.006, px);
          float hb = fbm3(dp * 14.0) + foam * vnoise(dp * 30.0) * 0.5;
          vec2 dH = vec2(dFdx(hb), dFdy(hb)) * max(dirt, foam * 0.6) * 0.35 * near;
          vec3 sx = dFdx(-vViewPosition);
          vec3 sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal);
          vec3 r2 = cross(normal, sx);
          float det = dot(sx, r1) * faceDirection;
          vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
          normal = normalize(abs(det) * normal - grad);
        }`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(foam * 0.18);`
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= (1.0 - max(dirt, foam));
          material.clearcoatRoughness = clamp(material.clearcoatRoughness + swirl * 0.22 + uSwirl * 0.04, 0.0, 1.0);
        #endif`
      );
  };
  material.customProgramCacheKey = () => 'dirt';
  material.needsUpdate = true;
}

/* ---------- Studio ---------- */

function stripMaterial(intensity) {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  m.color.multiplyScalar(intensity);
  return m;
}

// Emissive-only room used to bake reflections. warm adds the open garage door.
function buildEnvScene(warm) {
  const s = new THREE.Scene();
  s.background = new THREE.Color(warm ? 0x120a05 : 0x050506);
  const strip = new THREE.BoxGeometry(0.22, 0.05, 16);
  const cool = stripMaterial(warm ? 1.2 : 7);
  for (let i = -3; i <= 3; i++) {
    const m = new THREE.Mesh(strip, cool);
    m.position.set(i * 2.2, 3.4, 0);
    m.rotation.y = 0.42;
    s.add(m);
  }
  // long softboxes either side give the horizontal streak along the doors
  const box = new THREE.PlaneGeometry(14, 1.2);
  const soft = stripMaterial(warm ? 0.6 : 3.2);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(box, soft);
    m.position.set(side * 9, 2.4, 0);
    m.rotation.y = -side * Math.PI / 2;
    s.add(m);
  }
  const front = new THREE.Mesh(new THREE.PlaneGeometry(6, 2), stripMaterial(warm ? 0.3 : 1.4));
  front.position.set(0, 3, 10);
  front.rotation.y = Math.PI;
  s.add(front);

  if (warm) {
    const sun = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.45, 0.14).multiplyScalar(3.5), toneMapped: false });
    const door = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), sun);
    door.position.set(0, 2.25, -11);
    s.add(door);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(30, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.2, 0.06).multiplyScalar(0.6), toneMapped: false }));
    glow.position.set(0, 0.5, 11);
    glow.rotation.y = Math.PI;
    s.add(glow);
  }
  return s;
}

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 128, 10, 64, 128, 128);
  grd.addColorStop(0, 'rgba(0,0,0,0.95)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 256);
  return new THREE.CanvasTexture(c);
}

function sunsetTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#3a1206');
  grd.addColorStop(0.45, '#c2410c');
  grd.addColorStop(0.72, '#fb923c');
  grd.addColorStop(0.8, '#fed7aa');
  grd.addColorStop(0.84, '#2a1408');
  grd.addColorStop(1, '#140a04');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Light curtain for the wash line: soft at both ends, fades out towards the top
function sheetTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  const h = g.createLinearGradient(0, 0, 256, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  h.addColorStop(0.85, 'rgba(255,255,255,0.8)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(0.25, 'rgba(0,0,0,1)');
  v.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = v;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/* ---------- Public API ---------- */

export async function createScene(canvas, { onProgress } = {}) {
  const isMobile = matchMedia('(max-width: 767px)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  // Resolution starts high and steps down while frames run slow; it never climbs back,
  // so it can't oscillate between two levels.
  const minDpr = isMobile ? 0.6 : 0.75;
  let dpr = Math.min(window.devicePixelRatio, isMobile ? 1.25 : 1.5);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const coolBg = new THREE.Color(0x0b0b0d);
  const warmBg = new THREE.Color(0x1a0e06);
  scene.background = coolBg.clone();
  scene.fog = new THREE.Fog(scene.background, 14, 30);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envCool = pmrem.fromScene(buildEnvScene(false), 0.02).texture;
  const envWarm = pmrem.fromScene(buildEnvScene(true), 0.02).texture;
  scene.environment = envCool;

  /* Visible studio: dark walls, ceiling light bars, polished floor */
  const room = new THREE.Group();
  scene.add(room);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.85, metalness: 0, side: THREE.BackSide, envMapIntensity: 0.35 });
  const walls = new THREE.Mesh(new THREE.BoxGeometry(26, 7, 26), wallMat);
  walls.position.y = 3.5;
  room.add(walls);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.07 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  room.add(floor);

  const barMat = stripMaterial(4);
  const barGeo = new THREE.BoxGeometry(0.12, 0.04, 14);
  const bars = [];
  for (let i = -3; i <= 3; i++) {
    const b = new THREE.Mesh(barGeo, barMat);
    b.position.set(i * 2.2, 3.4, 0);
    b.rotation.y = 0.42;
    room.add(b);
    bars.push(b);
  }

  // Warm stage: open garage door glowing behind the car
  const doorMat = new THREE.MeshBasicMaterial({ map: sunsetTexture(), transparent: true, opacity: 0, fog: false });
  doorMat.color.setScalar(2.4);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.2), doorMat);
  door.position.set(-2.5, 1.6, -12.9);
  room.add(door);

  // The baked environment does most of the lighting; the key light gives the mud its relief.
  // Light count stays constant so nothing recompiles mid-scroll.
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  key.position.set(3, 8, 4);
  scene.add(key);
  const sunLight = new THREE.DirectionalLight(0xff8a3a, 0);
  sunLight.position.set(-1, 1.5, -8);
  scene.add(sunLight);

  /* Car */
  const draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const gltf = await loader.loadAsync(import.meta.env.BASE_URL + 'models/car.glb', (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  const car = gltf.scene;
  car.rotation.y = Math.PI;
  car.updateMatrixWorld(true);

  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0x050506, metalness: 0.6, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.025, envMapIntensity: 1.3 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0d0f, metalness: 0.1, roughness: 0.02, transparent: true, opacity: 0.6, clearcoat: 1, envMapIntensity: 1.4 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, metalness: 1, roughness: 0.22 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.4, roughness: 0.35 });

  const interior = /leather|interior|carpet|steering|lights_red|blue|yellow/i;
  const patched = new Map();
  const bodyMeshes = [];
  car.traverse((o) => {
    if (!o.isMesh) return;
    const name = (o.name + ' ' + (o.parent?.name || '')).toLowerCase();
    if (o.name === 'body') { o.material = bodyMat; bodyMeshes.push(o); }
    else if (o.name === 'glass') o.material = glassMat;
    else if (name.startsWith('rim_') || o.parent?.name?.startsWith('rim_')) o.material = rimMat;
    else if (o.name === 'trim' || o.name === 'yellow_trim' || o.name === 'blue') o.material = trimMat;

    let strength = 1;
    if (interior.test(name)) strength = 0;
    else if (/tire/.test(name)) strength = 0.85;
    else if (/lights|leds/.test(name)) strength = 0.6;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = mats.map((m) => {
      if (!m.isMeshStandardMaterial) return m;
      const k = m.uuid + ':' + strength;
      if (!patched.has(k)) {
        const pm = strength === 1 && (m === bodyMat || m === glassMat || m === rimMat || m === trimMat) ? m : m.clone();
        patchMaterial(pm, strength);
        patched.set(k, pm);
      }
      return patched.get(k);
    });
    if (o.material.length === 1) o.material = o.material[0];
  });

  // Normalise: length along z, sitting on the floor, centred
  const box = new THREE.Box3().setFromObject(car);
  const size = box.getSize(new THREE.Vector3());
  const s = CAR_LENGTH / size.z;
  car.scale.setScalar(s);
  box.setFromObject(car);
  const center = box.getCenter(new THREE.Vector3());
  car.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  scene.add(car);
  car.updateMatrixWorld(true);
  box.setFromObject(car);
  const dims = { minZ: box.min.z, maxZ: box.max.z, width: box.max.x - box.min.x, height: box.max.y };
  dirtUniforms.uCarH.value = dims.height;
  dirtUniforms.uCarMinZ.value = dims.minZ;
  dirtUniforms.uWash.value = dims.maxZ + 0.8;

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(dims.width * 1.5, CAR_LENGTH * 1.25),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.003;
  scene.add(shadow);

  /* Wash spray: a falling sheet of droplets on the wash front */
  const SPRAY = isMobile ? 700 : 1800;
  const sprayGeo = new THREE.BufferGeometry();
  const sprayPos = new Float32Array(SPRAY * 3);
  const sprayVel = new Float32Array(SPRAY);
  const spanX = dims.width + 1.2;
  const spanY = dims.height + 0.7;
  for (let i = 0; i < SPRAY; i++) {
    sprayPos[i * 3] = (Math.random() - 0.5) * spanX;
    sprayPos[i * 3 + 1] = Math.random() * spanY;
    sprayPos[i * 3 + 2] = (Math.random() - 0.5) * 0.16;
    sprayVel[i] = 1.5 + Math.random() * 2.5;
  }
  sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
  const sprayMat = new THREE.PointsMaterial({ size: 0.028, map: softDotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xe8f4ff });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  scene.add(spray);

  const sheetMat = new THREE.MeshBasicMaterial({ map: sheetTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, side: THREE.DoubleSide, toneMapped: false });
  sheetMat.color.setScalar(1.6);
  // a glowing curtain across the car on the wash front
  const sheetGroup = new THREE.Mesh(new THREE.PlaneGeometry(spanX, spanY + 0.5), sheetMat);
  sheetGroup.geometry.translate(0, (spanY + 0.5) / 2, 0);
  scene.add(sheetGroup);

  /* Water beads that appear once the ceramic layer is on */
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const beads = [];
  const BEADS = isMobile ? 500 : 1100;
  let tries = 0;
  while (beads.length < BEADS && tries < BEADS * 12) {
    tries++;
    const x = (Math.random() - 0.5) * dims.width * 0.85;
    const z = THREE.MathUtils.lerp(dims.minZ, dims.maxZ, Math.random() * 0.95);
    raycaster.set(new THREE.Vector3(x, 5, z), down);
    const hit = raycaster.intersectObjects(bodyMeshes, false)[0];
    if (!hit || !hit.face) continue;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.y < 0.75) continue;
    const r = 0.003 + Math.pow(Math.random(), 3) * 0.012;
    beads.push({ p: hit.point.clone().addScaledVector(n, r * 0.1), n, r, delay: Math.random() * 0.6 });
  }
  // clearcoat instead of transmission: transmission re-renders the whole scene every frame
  const beadMat = new THREE.MeshPhysicalMaterial({ color: 0x0c0d0f, metalness: 0, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 2.6 });
  const beadMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), beadMat, beads.length);
  beadMesh.frustumCulled = false;
  scene.add(beadMesh);
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let lastBeads = -1;
  function setBeads(p) {
    if (Math.abs(p - lastBeads) < 0.001) return;
    lastBeads = p;
    beadMesh.visible = p > 0.001;
    beads.forEach((b, i) => {
      const k = THREE.MathUtils.clamp((p - b.delay) / 0.4, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      tmpQ.setFromUnitVectors(up, b.n);
      tmpS.set(b.r * e, b.r * 0.55 * e, b.r * e);
      tmpM.compose(b.p, tmpQ, tmpS);
      beadMesh.setMatrixAt(i, tmpM);
    });
    beadMesh.instanceMatrix.needsUpdate = true;
  }
  setBeads(0);

  // Points of interest for the close-ups, found on the real geometry
  function probe(x, z) {
    raycaster.set(new THREE.Vector3(x, 5, z), down);
    const hit = raycaster.intersectObjects(bodyMeshes, false)[0];
    return hit ? hit.point.clone() : new THREE.Vector3(x, dims.height * 0.7, z);
  }
  const hood = probe(dims.width * 0.12, dims.maxZ - CAR_LENGTH * 0.24);
  raycaster.set(new THREE.Vector3(5, dims.height * 0.42, 0.2), new THREE.Vector3(-1, 0, 0));
  const doorHit = raycaster.intersectObjects(bodyMeshes, false)[0];
  const door2 = doorHit ? doorHit.point.clone() : new THREE.Vector3(dims.width / 2, dims.height * 0.42, 0.2);

  // envMapIntensity only applies to a material's own envMap, not to scene.environment
  const envMats = new Set();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    [].concat(o.material).forEach((m) => { if (m.isMeshStandardMaterial) envMats.add(m); });
  });
  const setEnv = (tex) => envMats.forEach((m) => { m.envMap = tex; });
  setEnv(envCool);

  /* State driven by the scroll timeline */
  const state = { warm: 0, sprayOpacity: 0 };
  const camPos = new THREE.Vector3();
  const camTarget = new THREE.Vector3();

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep the car in frame on portrait screens
    camera.fov = camera.aspect < 1 ? 52 : 32;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  let lastFrame = 0;
  let slowFrames = 0;
  function adaptResolution(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (dt > 100) return; // idle gap between on-demand renders, not a measurement
    if (dt > 26) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 12 && dpr > minDpr) {
      dpr = Math.max(minDpr, dpr - 0.25);
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      slowFrames = 0;
    }
  }

  const clock = new THREE.Clock();
  let envIsWarm = false;
  function render() {
    adaptResolution(performance.now());
    const dt = Math.min(clock.getDelta(), 0.05);

    // spray falls and respawns at the top, following the wash front
    if (state.sprayOpacity > 0.01) {
      for (let i = 0; i < SPRAY; i++) {
        let y = sprayPos[i * 3 + 1] - sprayVel[i] * dt;
        if (y < 0) {
          y = spanY;
          sprayPos[i * 3] = (Math.random() - 0.5) * spanX;
        }
        sprayPos[i * 3 + 1] = y;
      }
      sprayGeo.attributes.position.needsUpdate = true;
    }
    spray.position.z = dirtUniforms.uWash.value;
    sheetGroup.position.z = dirtUniforms.uWash.value;
    sprayMat.opacity = state.sprayOpacity * 0.85;
    sheetMat.opacity = state.sprayOpacity * 0.5;
    spray.visible = sheetGroup.visible = state.sprayOpacity > 0.01;

    // warm stage
    const w = state.warm;
    scene.background.copy(coolBg).lerp(warmBg, w);
    scene.fog.color.copy(scene.background);
    doorMat.opacity = w;
    sunLight.intensity = w * 1.1;
    barMat.color.setRGB(4, 4 - w * 2.6, 4 - w * 3.4).multiplyScalar(1 - w * 0.7);
    wallMat.color.setHex(0x1c1d21).lerp(new THREE.Color(0x2a1a10), w);
    const wantWarm = w > 0.5;
    if (wantWarm !== envIsWarm) {
      envIsWarm = wantWarm;
      scene.environment = wantWarm ? envWarm : envCool;
      setEnv(scene.environment);
    }

    camera.position.copy(camPos);
    camera.lookAt(camTarget);
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, dims, hood, door: door2, state, camPos, camTarget, setBeads, render, resize };
}
