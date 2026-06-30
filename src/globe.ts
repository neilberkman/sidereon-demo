// The hero: an inertial-frame WebGL scene. Satellites are propagated by the
// engine's SGP4 in TEME and plotted directly; the Earth mesh spins under them by
// GMST, lit by the engine's Sun direction so the terminator is physical.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import {
  EARTH_RADIUS_KM,
  gmstRad,
  sunDirEci,
  propAt,
  orbitRing,
  orbitTrail,
  llToEcefUnit,
  ecefUnitToLL,
  groundTrackEcefUnits,
  nowMicros,
  type Sat,
} from "./engine";
import { CONSTELLATION, turbo, type Constellation } from "./colors";
import type { TecField } from "./engine";

const SCALE = 1 / EARTH_RADIUS_KM; // km -> scene units (Earth radius = 1)
const DEG = Math.PI / 180;

interface RenderProfile {
  antialias: boolean;
  coarsePointer: boolean;
  powerPreference: WebGLPowerPreference;
  pixelRatioMax: number;
  earthSegments: [number, number];
  atmosphereSegments: [number, number];
  starCount: number;
  orbitSamples: number;
  markerSegments: number;
  terminatorSegments: number;
  tecSegments: [number, number];
}

function renderProfile(): RenderProfile {
  const coarsePointer = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;
  const lowMemory = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
  const compactViewport = window.innerWidth <= 760;
  const mobileTier = coarsePointer || lowMemory || compactViewport;
  if (mobileTier) {
    return {
      antialias: false,
      coarsePointer,
      powerPreference: "low-power",
      // Cap the device pixel ratio hard on touch devices: iOS/Android panels are
      // commonly DPR 3, and a continuously-repainting WebGL globe at 3x is the
      // main cause of the "tuggy" feel. 1.25 still reads crisp on a high-DPR panel
      // while cutting fragment work to ~1/6 of native. Non-coarse compact/low-mem
      // tiers (e.g. a small laptop window) keep 1.5.
      pixelRatioMax: coarsePointer ? 1.25 : 1.5,
      earthSegments: [72, 48],
      atmosphereSegments: [48, 32],
      starCount: 900,
      orbitSamples: 48,
      markerSegments: 20,
      terminatorSegments: 96,
      tecSegments: [80, 54],
    };
  }
  return {
    antialias: true,
    coarsePointer,
    powerPreference: "high-performance",
    pixelRatioMax: 2,
    earthSegments: [96, 64],
    atmosphereSegments: [64, 48],
    starCount: 1800,
    orbitSamples: 64,
    markerSegments: 32,
    terminatorSegments: 160,
    tecSegments: [120, 80],
  };
}

export class Globe {
  readonly scene = new THREE.Scene();
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private earth: THREE.Group; // spins by GMST (ECEF content lives inside)
  private satPoints!: THREE.Points;
  private satColors!: Float32Array;
  private satSizes!: Float32Array;
  private satPos!: Float32Array;
  private satMat!: THREE.ShaderMaterial;
  private orbitGroup = new THREE.Group();
  private trailGroup = new THREE.Group(); // comet tails behind each satellite
  private trailTick = 0;
  private trackGroup = new THREE.Group();
  // Ground tracks live in trackGroup. A click crossfades a fresh set in OVER the
  // old one (the globe never contracts to empty while the worker computes), while
  // a periodic live refresh swaps at full opacity with NO fade (so the steady-
  // state constellation advance never blinks).
  private readonly trackBaseOpacity = 0.95;
  private trackLines: Line2[] = []; // active set (fading in / steady)
  private trackMats: LineMaterial[] = []; // their materials (need resolution on resize)
  private fadeLines: Line2[] = []; // outgoing set during a click crossfade
  private fadeMats: LineMaterial[] = [];
  private trackFade = 1; // 0..1 crossfade progress (1 = settled)
  // Observer marker pulse while a click's worker result is pending.
  private observerRing?: THREE.Mesh;
  private observerPulsing = false;
  private observerGroup = new THREE.Group();
  // Day-night terminator + sub-solar marker, Earth-fixed (so they register with
  // the coastlines). Rebuilt from the engine's sub-solar point on demand.
  private subSolarGroup = new THREE.Group();
  // Smooth one-shot camera move (auto-center on click / reset-view button).
  private camTween: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  // Default camera distance (set from the initial position); the user's +/- dolly
  // eases back to this while the page scrolls, so a zoom never rides into the next
  // section "huge" — the globe docks at its intended framing size.
  private defaultDistance = 8.45;
  private tecMesh?: THREE.Mesh;
  private earthMat: THREE.ShaderMaterial;
  private sunDir = new THREE.Vector3(1, 0, 0);
  private sats: Sat[] = [];
  private raycaster = new THREE.Raycaster();
  private earthSphere!: THREE.Mesh;
  private host: HTMLElement;
  private pickDown: { x: number; y: number } | null = null;
  // Framing: the on-screen rect (CSS px) the centered globe is mapped into, and
  // how much of that rect's height the globe should fill relative to how it fills
  // the full canvas. null rect = no offset (centered, full-canvas).
  private frameRect: DOMRect | null = null;
  private frameFill = 1;
  private readonly profile = renderProfile();
  private resizeRaf = 0;
  private resizeObserver?: ResizeObserver;
  private pixelRatio = 1;
  private contextLost = false;
  onPick?: (lat: number, lon: number) => void;

  constructor(host: HTMLElement) {
    this.host = host;
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.profile.antialias,
      alpha: true,
      powerPreference: this.profile.powerPreference,
      stencil: false,
    });
    this.pixelRatio = this.targetPixelRatio();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(46, w / h, 0.01, 200);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(5.0, -5.9, 3.4);
    this.defaultDistance = this.camera.position.length();

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.55;
    this.controls.minDistance = 2.0;
    this.controls.maxDistance = 40;
    // Never capture the wheel/trackpad: the globe is full-bleed behind a
    // scrolling page, so scroll-to-zoom would hijack page scroll. Drag orbits,
    // click drops an observer, and the wheel always scrolls the page.
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.18;
    // Touch handling. The canvas is a full-bleed fixed scene behind a scrolling
    // page. The earlier `pan-y` compromise (reserve vertical gestures for native
    // page scroll, give horizontal-dominant drags to OrbitControls) made the
    // globe nearly un-rotatable on iOS: a one-finger drag is the rotate gesture,
    // but every vertical component was stolen by the page scroller, so elevation
    // could not be dragged at all and azimuth drags fought the scroller. Claim
    // the gesture with `touch-action: none` so a one-finger drag rotates freely
    // on touch. The page stays scrollable because pointer-events route only the
    // live globe STAGE box through to this canvas (CSS, gated on pointer:coarse);
    // every other surface keeps its own touch-action and scrolls the page, so a
    // scroll simply starts outside the docked globe. Desktop (fine pointer) keeps
    // native scroll over the fixed canvas with `auto`; mouse drag-to-rotate uses
    // pointer events and is unaffected either way.
    this.renderer.domElement.style.touchAction = this.profile.coarsePointer ? "none" : "auto";
    // WebKit-specific scroll "tug": OrbitControls registers a NON-PASSIVE `wheel`
    // listener (`{ passive: false }`) on the canvas for zoom. WebKit decides the
    // scroll path purely on the PRESENCE of a non-passive wheel listener on the
    // hit-test path — it must assume the handler might preventDefault — so it
    // drops off the fast (off-main-thread) scroll path onto the slow main-thread
    // path. With the WebGL globe repainting every rAF, that main thread is busy,
    // so the first wheel events are held back ("resist") and the page then
    // lurches to catch up ("break through with force"). Chrome async-scrolls
    // regardless, which is why it was unaffected. We have zoom disabled, so the
    // handler is dead weight (it early-returns without preventDefault) — remove
    // the listener entirely so WebKit keeps the fast scroll path. Drag-to-orbit
    // uses pointer events and is untouched.
    const wheelHandler = (this.controls as unknown as { _onMouseWheel?: EventListener })._onMouseWheel;
    if (wheelHandler) this.renderer.domElement.removeEventListener("wheel", wheelHandler);

    this.earth = new THREE.Group();
    this.scene.add(this.earth);

    this.earthMat = this.makeEarthMaterial();
    this.buildEarth();
    this.buildAtmosphere();
    this.buildStars();
    // Orbits + comet trails are inertial (scene frame); ground tracks + observer
    // are Earth-fixed.
    this.scene.add(this.orbitGroup, this.trailGroup);
    this.earth.add(this.trackGroup, this.observerGroup, this.subSolarGroup);

    // Set the observer on a click, not a drag: record the press, and only pick
    // if the pointer barely moved (so orbiting the camera never moves the pin).
    const el = this.renderer.domElement;
    el.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn("[globe] WebGL context lost");
    });
    el.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.scheduleResize();
      console.info("[globe] WebGL context restored");
    });
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      this.pickDown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e: PointerEvent) => {
      const d = this.pickDown;
      this.pickDown = null;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // a drag
      this.handlePick(e);
    });

    window.addEventListener("resize", this.scheduleResize, { passive: true });
    window.addEventListener("orientationchange", this.scheduleResize, { passive: true });
    window.visualViewport?.addEventListener("resize", this.scheduleResize, { passive: true });
    this.resizeObserver = new ResizeObserver(this.scheduleResize);
    this.resizeObserver.observe(host);
  }

  private makeEarthMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: new THREE.Vector3(1, 0, 0) }, // world-space sun dir
        uDay: { value: new THREE.Color(0x113041) },
        uNight: { value: new THREE.Color(0x03060c) },
        uTerm: { value: new THREE.Color(0x35e0d8) },
      },
      vertexShader: `
        varying vec3 vWorldN;
        varying vec3 vViewN;
        void main() {
          vWorldN = normalize(mat3(modelMatrix) * normal);
          vViewN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uSun; uniform vec3 uDay; uniform vec3 uNight; uniform vec3 uTerm;
        varying vec3 vWorldN;
        varying vec3 vViewN;
        void main() {
          vec3 n = normalize(vWorldN);
          float d = dot(n, normalize(uSun));
          float day = smoothstep(-0.10, 0.34, d);
          // soft daylight falloff so the lit hemisphere reads with relief
          float lambert = clamp(d, 0.0, 1.0);
          vec3 col = mix(uNight, uDay, day) + uDay * lambert * 0.45;
          // glowing terminator band, a touch wider + brighter than before
          float term = exp(-pow(d / 0.085, 2.0)) * 0.85;
          col += uTerm * term;
          // faint limb rim toward the camera for depth
          float rim = pow(1.0 - abs(vViewN.z), 3.0);
          col += uTerm * rim * 0.10;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
  }

  private buildEarth(): void {
    const [segW, segH] = this.profile.earthSegments;
    const geo = new THREE.SphereGeometry(1, segW, segH);
    this.earthSphere = new THREE.Mesh(geo, this.earthMat);
    this.earth.add(this.earthSphere);

    // graticule every 30 degrees
    const grat = new THREE.Group();
    const gmat = new THREE.LineBasicMaterial({ color: 0x16414a, transparent: true, opacity: 0.5 });
    for (let lat = -60; lat <= 60; lat += 30) grat.add(this.latCircle(lat, gmat));
    for (let lon = 0; lon < 360; lon += 30) grat.add(this.lonCircle(lon, gmat));
    this.earth.add(grat);
  }

  private latCircle(latDeg: number, mat: THREE.Material): THREE.Line {
    const pts: THREE.Vector3[] = [];
    const r = Math.cos(latDeg * DEG);
    const z = Math.sin(latDeg * DEG);
    for (let a = 0; a <= 360; a += 4) pts.push(new THREE.Vector3(r * Math.cos(a * DEG), r * Math.sin(a * DEG), z).multiplyScalar(1.001));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  }

  private lonCircle(lonDeg: number, mat: THREE.Material): THREE.Line {
    const pts: THREE.Vector3[] = [];
    const lo = lonDeg * DEG;
    for (let a = -90; a <= 90; a += 4) {
      const la = a * DEG;
      pts.push(new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)).multiplyScalar(1.001));
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  }

  // Coastlines from bundled Natural Earth land polygons, as glowing outlines.
  addCoastlines(geojson: any): void {
    const positions: number[] = [];
    const pushRing = (ring: number[][]) => {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = llToEcefUnit(ring[i][1], ring[i][0]);
        const b = llToEcefUnit(ring[i + 1][1], ring[i + 1][0]);
        positions.push(a[0] * 1.002, a[1] * 1.002, a[2] * 1.002);
        positions.push(b[0] * 1.002, b[1] * 1.002, b[2] * 1.002);
      }
    };
    for (const f of geojson.features) {
      const g = f.geometry;
      if (g.type === "Polygon") g.coordinates.forEach(pushRing);
      else if (g.type === "MultiPolygon") g.coordinates.forEach((poly: number[][][]) => poly.forEach(pushRing));
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x5cc8c2, transparent: true, opacity: 0.8 });
    this.earth.add(new THREE.LineSegments(bg, mat));
  }

  private buildAtmosphere(): void {
    const [segW, segH] = this.profile.atmosphereSegments;
    const geo = new THREE.SphereGeometry(1.06, segW, segH);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0x2bb6d6) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vP;
        void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `
        uniform vec3 uColor; varying vec3 vN; varying vec3 vP;
        void main(){ float i=pow(1.0-abs(dot(normalize(vN),normalize(-vP))),3.0); gl_FragColor=vec4(uColor, i*0.9); }`,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  private buildStars(): void {
    const n = this.profile.starCount;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 20);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: 0x8899bb, size: 0.06, sizeAttenuation: true, transparent: true, opacity: 0.5 });
    this.scene.add(new THREE.Points(g, m));
  }

  // ---- constellation ----
  setSats(sats: Sat[], micros: bigint): void {
    this.sats = sats;
    const n = sats.length;
    this.satPos = new Float32Array(n * 3);
    this.satColors = new Float32Array(n * 3);
    this.satSizes = new Float32Array(n);
    const c = new THREE.Color();
    // Subtle size differentiation by constellation so the field reads as four
    // distinct systems rather than one uniform dust.
    const sizeFor: Record<Constellation, number> = { GPS: 0.072, GAL: 0.066, GLO: 0.060, BDS: 0.066 };
    sats.forEach((s, i) => {
      c.setHex(CONSTELLATION[s.constellation].hex);
      this.satColors.set([c.r, c.g, c.b], i * 3);
      this.satSizes[i] = sizeFor[s.constellation];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.satPos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.satColors, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(this.satSizes, 1));
    this.satMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: this.host.clientHeight } },
      vertexShader: `
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / -mv.z, 2.6, 26.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          if (d > 0.5) discard;
          float core = smoothstep(0.5, 0.0, d);
          float a = pow(core, 2.2);
          vec3 col = mix(vColor, vec3(1.0), pow(core, 7.0) * 0.85);
          gl_FragColor = vec4(col, a);
        }`,
    });
    (this.satMat as any).vertexColors = true;
    this.satMat.defines = { USE_COLOR: "" };
    this.satPoints = new THREE.Points(g, this.satMat);
    this.satPoints.frustumCulled = false;
    this.scene.add(this.satPoints);

    // Static inertial orbit rings are built once here (boot-time, never in the
    // loop). The animated dot positions and comet trails are computed off-thread
    // and applied via setSatPositions / setTrailsFromBuffers, so no SGP4 runs on
    // the main thread per tick — the caller seeds the first frame from the worker
    // right after setSats.
    this.buildOrbits(micros);
  }

  // Comet tails: a short, fading arc of the real orbit just behind each
  // satellite, rebuilt periodically as the constellation advances. Grouped by
  // constellation into one additive line each, with per-vertex alpha.
  private buildTrails(micros: bigint): void {
    disposeGroup(this.trailGroup);
    const N = 18;
    const byC: Record<Constellation, { pos: number[]; a: number[] }> = {
      GPS: { pos: [], a: [] }, GAL: { pos: [], a: [] }, GLO: { pos: [], a: [] }, BDS: { pos: [], a: [] },
    };
    for (const s of this.sats) {
      let trail: Float64Array;
      try {
        trail = orbitTrail(s.tle, micros, N, 120_000);
      } catch {
        continue;
      }
      const bucket = byC[s.constellation];
      for (let i = 0; i < N - 1; i++) {
        const a0 = i / (N - 1);
        const a1 = (i + 1) / (N - 1);
        bucket.pos.push(trail[i * 3] * SCALE, trail[i * 3 + 1] * SCALE, trail[i * 3 + 2] * SCALE);
        bucket.pos.push(trail[(i + 1) * 3] * SCALE, trail[(i + 1) * 3 + 1] * SCALE, trail[(i + 1) * 3 + 2] * SCALE);
        bucket.a.push(a0 * a0 * 0.95, a1 * a1 * 0.95);
      }
    }
    (Object.keys(byC) as Constellation[]).forEach((cn) => {
      const b = byC[cn];
      if (!b.pos.length) return;
      this.addTrailSegment(cn, b.pos, b.a);
    });
  }

  // Build one constellation's comet-trail LineSegments from a flat (3*v) scene-
  // space position buffer and a matching per-vertex alpha buffer. Shared by the
  // (reference) main-thread buildTrails and by setTrailsFromBuffers, which feeds
  // it the worker's precomputed buffers so the visuals are identical.
  private addTrailSegment(cn: Constellation, pos: ArrayLike<number>, alpha: ArrayLike<number>): void {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(pos as never, 3));
    bg.setAttribute("aA", new THREE.Float32BufferAttribute(alpha as never, 1));
    const col = new THREE.Color(CONSTELLATION[cn].hex);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: col } },
      vertexShader: `
        attribute float aA; varying float vA;
        void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main() { gl_FragColor = vec4(uColor, vA); }`,
    });
    const seg = new THREE.LineSegments(bg, mat);
    seg.frustumCulled = false;
    this.trailGroup.add(seg);
  }

  // Apply precomputed constellation dot positions from the worker (scene units,
  // n*3, same index order as setSats) straight into the satPoints buffer. No SGP4
  // runs on the main thread — this is the animation path the render loop uses.
  setSatPositions(pos: Float32Array): void {
    if (!this.satPoints) return;
    this.satPos.set(pos);
    (this.satPoints.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  // Rebuild the comet trails from the worker's precomputed per-constellation
  // buffers, identical to buildTrails but with zero main-thread propagation.
  setTrailsFromBuffers(data: Record<Constellation, { pos: Float32Array; alpha: Float32Array }>): void {
    disposeGroup(this.trailGroup);
    (Object.keys(data) as Constellation[]).forEach((cn) => {
      const b = data[cn];
      if (!b || !b.pos.length) return;
      this.addTrailSegment(cn, b.pos, b.alpha);
    });
  }

  private buildOrbits(micros: bigint): void {
    this.orbitGroup.clear();
    const byC: Record<Constellation, number[]> = { GPS: [], GAL: [], GLO: [], BDS: [] };
    for (const s of this.sats) {
      const ring = orbitRing(s.tle, micros, this.profile.orbitSamples);
      const arr = byC[s.constellation];
      for (let i = 0; i < ring.length; i += 3) {
        arr.push(ring[i] * SCALE, ring[i + 1] * SCALE, ring[i + 2] * SCALE);
        if (i + 3 < ring.length) arr.push(ring[i + 3] * SCALE, ring[i + 4] * SCALE, ring[i + 5] * SCALE);
      }
      // close loop
      arr.push(ring[ring.length - 3] * SCALE, ring[ring.length - 2] * SCALE, ring[ring.length - 1] * SCALE);
      arr.push(ring[0] * SCALE, ring[1] * SCALE, ring[2] * SCALE);
    }
    (Object.keys(byC) as Constellation[]).forEach((cn) => {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute("position", new THREE.Float32BufferAttribute(byC[cn], 3));
      const mat = new THREE.LineBasicMaterial({
        color: CONSTELLATION[cn].hex,
        transparent: true,
        opacity: 0.16, // present (live constellation), but below the fat ground tracks
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.orbitGroup.add(new THREE.LineSegments(bg, mat));
    });
  }

  updateSats(micros: bigint): void {
    if (!this.satPoints) return;
    this.sats.forEach((s, i) => {
      try {
        const p = propAt(s.tle, micros);
        this.satPos.set([p[0] * SCALE, p[1] * SCALE, p[2] * SCALE], i * 3);
      } catch {
        this.satPos.set([0, 0, 0], i * 3);
      }
    });
    (this.satPoints.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    // Re-anchor the comet tails to the advancing constellation every ~2 s. The
    // trail shape barely changes second to second, so this stays cheap.
    if (this.trailTick++ % 8 === 0) this.buildTrails(micros);
  }

  setTime(date: Date): void {
    this.earth.rotation.z = gmstRad(date);
    const s = sunDirEci(date);
    this.sunDir.set(s[0], s[1], s[2]);
    (this.earthMat.uniforms.uSun.value as THREE.Vector3).copy(this.sunDir);
  }

  // ---- observer marker + ground tracks ----
  setObserver(latDeg: number, lonDeg: number): void {
    disposeGroup(this.observerGroup);
    const u = llToEcefUnit(latDeg, lonDeg);
    const p = new THREE.Vector3(u[0], u[1], u[2]).multiplyScalar(1.003);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.035, 0.05, this.profile.markerSegments),
      new THREE.MeshBasicMaterial({ color: 0xffb347, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
    );
    ring.position.copy(p);
    ring.lookAt(p.clone().multiplyScalar(2));
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, Math.max(12, this.profile.markerSegments / 2), Math.max(10, this.profile.markerSegments / 2)),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }),
    );
    dot.position.copy(p);
    this.observerGroup.add(ring, dot);
    this.observerRing = ring;
    // Carry an in-flight pulse onto the new ring, or rest it if idle.
    if (!this.observerPulsing) {
      ring.scale.setScalar(1);
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.95;
    }
  }

  // Day-night terminator overlay: a gold sub-solar marker at the geographic point
  // beneath the Sun, and the great circle 90 deg away from it — the day-night
  // boundary. Both are placed in the Earth-fixed group from the engine's sub-solar
  // point (lat/lon), so they ride the rotating Earth in lockstep with the
  // coastlines. Pass show=false to clear it.
  setSubSolar(latDeg: number, lonDeg: number, show: boolean): void {
    disposeGroup(this.subSolarGroup);
    if (!show) return;
    const u = llToEcefUnit(latDeg, lonDeg);
    const S = new THREE.Vector3(u[0], u[1], u[2]).normalize();

    // Sub-solar marker: a bright gold dot with a soft additive halo.
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, Math.max(12, this.profile.markerSegments / 2), Math.max(10, this.profile.markerSegments / 2)),
      new THREE.MeshBasicMaterial({ color: 0xffd66b }),
    );
    dot.position.copy(S.clone().multiplyScalar(1.01));
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, Math.max(14, this.profile.markerSegments), Math.max(12, this.profile.markerSegments / 2)),
      new THREE.MeshBasicMaterial({
        color: 0xffd66b,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.position.copy(dot.position);
    this.subSolarGroup.add(dot, halo);

    // Terminator great circle: the locus of unit vectors perpendicular to S.
    // Build an orthonormal pair (a, b) spanning that plane and sweep a full turn.
    const seed = Math.abs(S.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const a = new THREE.Vector3().crossVectors(S, seed).normalize();
    const b = new THREE.Vector3().crossVectors(S, a).normalize();
    const N = this.profile.terminatorSegments;
    const pts: number[] = [];
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const x = a.x * Math.cos(ang) + b.x * Math.sin(ang);
      const y = a.y * Math.cos(ang) + b.y * Math.sin(ang);
      const z = a.z * Math.cos(ang) + b.z * Math.sin(ang);
      pts.push(x * 1.006, y * 1.006, z * 1.006);
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const ringMat = new THREE.LineBasicMaterial({
      color: 0xffc24d,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.subSolarGroup.add(new THREE.Line(ringGeo, ringMat));
  }

  // Pulse the observer ring while a click's heavy result is pending — set true on
  // click, false when the worker's fast result is applied. The pulse animation is
  // driven from render(); this toggles it and restores the resting ring on stop.
  setObserverPending(pending: boolean): void {
    this.observerPulsing = pending;
    if (!pending && this.observerRing) {
      this.observerRing.scale.setScalar(1);
      (this.observerRing.material as THREE.MeshBasicMaterial).opacity = 0.95;
    }
  }

  // Ground tracks (ECEF subpoints) for given satellites over +/- a time window,
  // run through the engine's validated frame pipeline (TEME -> GCRS -> ITRS),
  // not a GMST approximation. The track lives in the Earth-fixed group with the
  // coastlines, so the two register exactly.
  //
  // `fadeIn` (click path) crossfades the new set in over the still-visible old
  // set so the globe never contracts; left false (periodic live refresh) the new
  // set replaces the old at full opacity with no fade, so periodic advances never
  // blink.
  setGroundTracks(sats: Sat[], center: Date, fadeIn = false): void {
    const half = 50 * 60 * 1000; // 50 minutes
    const step = 2 * 60 * 1000;
    const epochs: bigint[] = [];
    for (let dt = -half; dt <= half; dt += step) {
      epochs.push(nowMicros(new Date(center.getTime() + dt)));
    }
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const newLines: Line2[] = [];
    const newMats: LineMaterial[] = [];
    for (const s of sats) {
      const units = groundTrackEcefUnits(s.tle, epochs);
      const flat: number[] = [];
      for (let i = 0; i < units.length; i += 3) {
        const x = units[i];
        if (!Number.isFinite(x)) continue;
        flat.push(x * 1.004, units[i + 1] * 1.004, units[i + 2] * 1.004);
      }
      if (flat.length < 6) continue;
      // FAT, glowing tracks: real screen-space thickness (Line2) + additive blending
      // so the observer's tracks read as bright emitted light and clearly pop out of
      // the dimmed ambient orbit rings.
      const geom = new LineGeometry();
      geom.setPositions(flat);
      const mat = new LineMaterial({
        color: CONSTELLATION[s.constellation].hex,
        linewidth: 3,
        transparent: true,
        // click: start invisible and fade in over the old set; periodic: full now.
        opacity: fadeIn ? 0 : this.trackBaseOpacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      mat.resolution.set(w, h);
      newMats.push(mat);
      const line = new Line2(geom, mat);
      line.computeLineDistances();
      this.trackGroup.add(line);
      newLines.push(line);
    }

    if (fadeIn) {
      // Crossfade: the previously-active set becomes the outgoing set and stays
      // visible while the new set ramps up, so the globe never drops to empty.
      this.clearFadeLines();
      this.fadeLines = this.trackLines;
      this.fadeMats = this.trackMats;
      this.trackLines = newLines;
      this.trackMats = newMats;
      this.trackFade = 0; // render() ramps the new set in / the old set out
    } else {
      // Periodic refresh: drop the old set immediately and show the new at full
      // opacity — no fade, no blink as the constellation advances.
      this.removeLines(this.trackLines);
      this.clearFadeLines();
      this.trackLines = newLines;
      this.trackMats = newMats;
      this.trackFade = 1;
    }
  }

  // Remove a set of track lines from the scene and free their GPU resources.
  private removeLines(lines: Line2[]): void {
    for (const line of lines) {
      this.trackGroup.remove(line);
      line.geometry.dispose();
      (line.material as LineMaterial).dispose();
    }
  }

  // Drop the outgoing crossfade set, if any.
  private clearFadeLines(): void {
    if (this.fadeLines.length) this.removeLines(this.fadeLines);
    this.fadeLines = [];
    this.fadeMats = [];
  }

  // ---- TEC overlay ----
  setTec(field: TecField, visible: boolean): void {
    if (this.tecMesh) {
      this.earth.remove(this.tecMesh);
      this.tecMesh.geometry.dispose();
      const mat = this.tecMesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose(); // the CanvasTexture built per toggle
      mat.dispose();
      this.tecMesh = undefined;
    }
    if (!visible) return;
    const tex = tecTexture(field);
    const [segW, segH] = this.profile.tecSegments;
    const geo = zUpUvSphere(1.02, segW, segH);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.tecMesh = new THREE.Mesh(geo, mat);
    this.earth.add(this.tecMesh);
  }

  toggleAutoRotate(on: boolean): void {
    this.controls.autoRotate = on;
  }

  // Zoom via an explicit control instead of the wheel (the wheel scrolls the
  // page). factor < 1 moves the camera closer, > 1 further; clamped to the
  // controls' min/max distance.
  dolly(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.max(
      this.controls.minDistance,
      Math.min(this.controls.maxDistance, offset.length() * factor),
    );
    offset.setLength(dist);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  // Ease the camera distance back toward the default by fraction `t` (0..1).
  // Called while the page scrolls so a manual +/- zoom unwinds to the framing
  // size by the time the globe docks in the next section. Holds at rest (only
  // invoked on scroll) and never fights an active auto-center/reset tween.
  easeZoomToDefault(t: number): void {
    if (this.camTween) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dist = offset.length();
    if (Math.abs(dist - this.defaultDistance) < 1e-3) return;
    offset.setLength(THREE.MathUtils.lerp(dist, this.defaultDistance, t));
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  // Start a smooth one-shot move of the camera to `goal` (world position).
  // Orbit input is suspended for the duration; render() drives the lerp and
  // re-enables the controls (which resync from the final position) when done.
  private startCamTween(goal: THREE.Vector3): void {
    this.camTween = { from: this.camera.position.clone(), to: goal.clone(), t: 0 };
    this.controls.enabled = false;
  }

  // Auto-center: rotate the camera so the clicked lat/lon faces the viewer, at
  // the current zoom distance. The observer lives inside the GMST-spun earth
  // group, so face its WORLD direction. Idle auto-rotate stops so the point
  // stays put once centered.
  faceObserver(latDeg: number, lonDeg: number): void {
    const u = llToEcefUnit(latDeg, lonDeg);
    const world = new THREE.Vector3(u[0], u[1], u[2])
      .applyQuaternion(this.earth.quaternion)
      .normalize();
    const dist = this.camera.position.distanceTo(this.controls.target);
    const goal = this.controls.target.clone().add(world.multiplyScalar(dist));
    this.controls.autoRotate = false;
    this.startCamTween(goal);
  }

  // Reset-view control: ease back to the default framing and resume idle spin.
  resetView(): void {
    this.controls.autoRotate = true;
    this.startCamTween(new THREE.Vector3(5.0, -5.9, 3.4));
  }

  isContextLost(): boolean {
    return this.contextLost;
  }

  // Frame the one shared, centered globe into an on-screen rectangle (a stage
  // box), so it lands centered in that box and fills it nicely while remaining a
  // single full-viewport scene. Pass null to clear the offset (centered on the
  // full canvas). `fill` scales how much of the rect the globe fills relative to
  // how it fills the full canvas (1 = same fraction, >1 = larger).
  //
  // The globe is `position: fixed`, so the stage rect moves as the page scrolls;
  // call this every frame with a fresh getBoundingClientRect so the framing
  // tracks scroll and resize.
  frameIntoRect(rect: DOMRect | null, fill = 1): void {
    this.frameRect = rect;
    this.frameFill = fill;
    this.applyFraming();
  }

  // Radius (CSS px) the docked globe renders at when framed into `rect` with `fill`.
  // Same magnification as applyFraming: the offset magnifies by f = (rect.height / H)
  // * fill, and the globe (2 scene units across) spans `diamFrac` of the full-canvas
  // height at the current camera distance, so its on-screen diameter is
  // diamFrac * rect.height * fill (the canvas height H cancels). Lets the caller tuck
  // UI right under the sphere.
  globeRadiusForRect(rect: DOMRect, fill = 1): number {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const fovV = (this.camera.fov * Math.PI) / 180;
    const diamFrac = 1 / (dist * Math.tan(fovV / 2));
    return (diamFrac * rect.height * fill) / 2;
  }

  // Map the centered globe into `frameRect` via the camera's view offset.
  //
  // With no offset the camera frustum maps 1:1 onto the full canvas (W x H, CSS
  // px), so frustum/"full-image" units equal canvas pixels. setViewOffset(W, H,
  // x, y, w, h) instead stretches the sub-window [x, x+w] x [y, y+h] of that full
  // image across the whole canvas. Choosing a window LARGER than W x H shrinks
  // the globe into a sub-rect: the centered full image lands inside the rect.
  //
  // Let f be the apparent scale (canvas px per full-image px). The window maps to
  // the canvas as screen = (P - x) / w * W, so W/w = f -> w = W/f, h = H/f, kept
  // uniform (w/W = h/H) so the sphere stays round. The full image's center
  // (W/2, H/2) must land at the rect center (cx, cy): (W/2 - x) * f = cx ->
  // x = W/2 - cx/f, and y = H/2 - cy/f. We pick f = (rectHeight / H) * fill so
  // the globe fills the rect by the same fraction it fills the canvas (times the
  // fill boost), which keeps the user's +/- dolly meaningful instead of fighting
  // it.
  private applyFraming(): void {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    const r = this.frameRect;
    if (!r || W === 0 || H === 0) {
      this.camera.clearViewOffset();
      return;
    }
    const f = (r.height / H) * this.frameFill;
    if (f <= 0) {
      this.camera.clearViewOffset();
      return;
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const w = W / f;
    const h = H / f;
    const x = W / 2 - cx / f;
    const y = H / 2 - cy / f;
    this.camera.setViewOffset(W, H, x, y, w, h);
  }

  private handlePick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(mx, my), this.camera);
    const hits = this.raycaster.intersectObject(this.earthSphere, false);
    if (!hits.length) return;
    const local = this.earth.worldToLocal(hits[0].point.clone());
    const { lat, lon } = ecefUnitToLL(local.x, local.y, local.z);
    this.onPick?.(lat, lon);
  }

  private targetPixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.profile.pixelRatioMax);
  }

  private scheduleResize = (): void => {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.resize();
    });
  };

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const nextPixelRatio = this.targetPixelRatio();
    if (Math.abs(nextPixelRatio - this.pixelRatio) > 0.001) {
      this.pixelRatio = nextPixelRatio;
      this.renderer.setPixelRatio(this.pixelRatio);
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.satMat) this.satMat.uniforms.uScale.value = h; // keep glyph px stable
    for (const m of this.trackMats) m.resolution.set(w, h); // fat ground-track lines
    for (const m of this.fadeMats) m.resolution.set(w, h); // outgoing crossfade lines
    this.applyFraming(); // re-anchor the stage framing to the new size
  }

  render(): void {
    if (this.contextLost) return;
    if (this.camTween) {
      // Auto-center / reset tween: ease the camera to the goal (easeInOutQuad),
      // keep it aimed at the target, and skip controls.update() so damping never
      // fights the lerp. On completion the controls resync from the final pose.
      const tw = this.camTween;
      tw.t = Math.min(1, tw.t + 0.045);
      const e = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.camera.lookAt(this.controls.target);
      if (tw.t >= 1) {
        this.camTween = null;
        this.controls.enabled = true;
      }
    } else {
      this.controls.update();
    }
    // Crossfade a freshly-clicked ground-track set in while the old set fades out
    // (quick but smooth); periodic refreshes swap instantly and never enter here.
    if (this.trackFade < 1) {
      this.trackFade = Math.min(1, this.trackFade + 0.08);
      const o = this.trackBaseOpacity;
      for (const m of this.trackMats) m.opacity = o * this.trackFade;
      for (const m of this.fadeMats) m.opacity = o * (1 - this.trackFade);
      if (this.trackFade >= 1) {
        this.clearFadeLines();
        for (const m of this.trackMats) m.opacity = o;
      }
    }
    // Pulse the observer ring while a click's result is pending (activity cue).
    if (this.observerPulsing && this.observerRing) {
      const ph = 0.5 + 0.5 * Math.sin((performance.now() / 1000) * 6);
      this.observerRing.scale.setScalar(1 + 0.22 * ph);
      (this.observerRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * ph;
    }
    this.renderer.render(this.scene, this.camera);
  }
}

// Remove and free every child of a group: geometries, materials, and any
// texture a material carries. Three.js does not do this on .clear(), so without
// it each observer move / track refresh / TEC redraw leaks GPU memory.
function disposeGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => disposeMaterial(m));
    else if (mat) disposeMaterial(mat);
  });
  group.clear();
}

function disposeMaterial(mat: THREE.Material): void {
  const m = mat as THREE.MeshBasicMaterial;
  m.map?.dispose();
  mat.dispose();
}

// A Z-up UV sphere whose u = lon/360 (lon = atan2(y,x)) and v = (lat+90)/180,
// so an equirectangular canvas aligns with the ECEF-built coastlines exactly.
function zUpUvSphere(radius: number, segW: number, segH: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= segH; j++) {
    const v = j / segH;
    const lat = (v - 0.5) * Math.PI; // -90..+90
    for (let i = 0; i <= segW; i++) {
      const u = i / segW;
      const lon = u * 2 * Math.PI; // 0..360
      const cl = Math.cos(lat);
      pos.push(radius * cl * Math.cos(lon), radius * cl * Math.sin(lon), radius * Math.sin(lat));
      uv.push(u, v);
    }
  }
  const row = segW + 1;
  for (let j = 0; j < segH; j++) {
    for (let i = 0; i < segW; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function tecTexture(field: TecField): THREE.CanvasTexture {
  const W = field.lon.length;
  const H = field.lat.length;
  const c = document.createElement("canvas");
  c.width = 720;
  c.height = 360;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  const span = field.max - field.min || 1;
  const cellW = c.width / W + 1.5;
  const cellH = c.height / H + 1.5;
  for (let j = 0; j < H; j++) {
    // field.lat descends from +; canvas y=0 is top. flipY maps top -> v=1 -> +lat.
    const lat = field.lat[j];
    const y = ((90 - lat) / 180) * c.height;
    for (let i = 0; i < W; i++) {
      const val = field.vtec[j][i];
      if (!Number.isFinite(val)) continue;
      const t = (val - field.min) / span;
      const [r, g, b] = turbo(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const lon = ((field.lon[i] % 360) + 360) % 360;
      const x = (lon / 360) * c.width;
      ctx.fillRect(x - cellW / 2, y - cellH / 2, cellW, cellH);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
