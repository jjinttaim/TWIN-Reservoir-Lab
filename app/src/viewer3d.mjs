import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { solveChannel, channelAssumptions, windWaves, GRAVITY } from './hydraulics.mjs';
import { createWeather } from './weather3d.mjs';
import { channelNetwork, sampleChannel, channelWaterGeometry, createChannelTerrain } from './channel-terrain.mjs';

/**
 * Presentation layer only. The mass-balance model supplies the displayed state;
 * local Manning and wave-dispersion approximations drive visual motion only.
 * Unknown roughness, bathymetry and slope remain explicit assumptions, not CFD.
 * The exported glTF and manifest use metres and THREE's Y-up coordinates.
 */
const DEFAULT_SCENE = {
  model: 'twin-dam.glb',
  name: '댐 시설 3D 모델',
  reservoir: { center: [0, 30, -105], size: [125, 180], minY: 9, maxY: 42 },
  river: { points: [[0, 2, 28], [0, 2, 80], [5, 2, 135], [-8, 2, 200]], width: 30 },
  channels: [],
  cameras: {
    overview: { position: [150, 115, 195], target: [0, 20, -20] },
    upstream: { position: [-115, 80, -175], target: [0, 27, 5] },
    spillway: { position: [85, 65, 90], target: [0, 18, 15] },
    downstream: { position: [75, 30, 160], target: [0, 25, -10] },
    top: { position: [0, 290, 0.1], target: [0, 0, 0] },
  },
};

const clamp = THREE.MathUtils.clamp;
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
const V3 = (a) => new THREE.Vector3(...a);
const safeTriple = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Pure presentation mapping, exported to check boundary behavior without WebGL. */
export function mapVisualState(row, config, reservoir) {
  let low = config.minLevelM, high = config.maxLevelM;
  const curve = config.stageStorageCurve;
  if (Array.isArray(curve) && curve.length >= 2 && curve.every((p) => p && Number.isFinite(p.storageMcm) && Number.isFinite(p.levelM))) {
    const levelAt = (storage) => {
      for (let i = 1; i < curve.length; i++) if (storage <= curve[i].storageMcm) {
        const a = curve[i - 1], b = curve[i];
        if (b.storageMcm <= a.storageMcm) return NaN;
        return a.levelM + (storage - a.storageMcm) / (b.storageMcm - a.storageMcm) * (b.levelM - a.levelM);
      }
      return curve.at(-1).levelM;
    };
    low = levelAt(config.minStorageMcm); high = levelAt(config.maxStorageMcm);
  }
  const storageRange = config.maxStorageMcm - config.minStorageMcm;
  const fraction = Number.isFinite(row?.levelM) && Number.isFinite(low) && Number.isFinite(high) && high > low
    ? (row.levelM - low) / (high - low)
    : (finite(row?.storageMcm, config.initialStorageMcm) - finite(config.minStorageMcm)) / (storageRange > 0 ? storageRange : 1);
  return {
    level: THREE.MathUtils.lerp(reservoir.minY, reservoir.maxY, clamp(finite(fraction, 0.6), 0, 1)),
    flows: { release: Math.max(0, finite(row?.releaseCms)), spill: Math.max(0, finite(row?.spillCms)), turbine: Math.max(0, finite(row?.turbineCms)) },
    maxRelease: config.maxReleaseCms > 0 ? config.maxReleaseCms : 1,
    maxTurbine: config.maxTurbineCms > 0 ? config.maxTurbineCms : 1,
  };
}

function cleanManifest(source) {
  if (!source || typeof source !== 'object') source = {};
  const m = { ...DEFAULT_SCENE, ...source };
  m.reservoir = { ...DEFAULT_SCENE.reservoir, ...source.reservoir };
  if (!safeTriple(m.reservoir.center)) m.reservoir.center = DEFAULT_SCENE.reservoir.center;
  if (!Array.isArray(m.reservoir.size) || m.reservoir.size.length !== 2 || !m.reservoir.size.every((n) => Number.isFinite(n) && n > 0)) m.reservoir.size = DEFAULT_SCENE.reservoir.size;
  if (!Number.isFinite(m.reservoir.minY) || !Number.isFinite(m.reservoir.maxY) || m.reservoir.minY >= m.reservoir.maxY) {
    m.reservoir.minY = DEFAULT_SCENE.reservoir.minY;
    m.reservoir.maxY = DEFAULT_SCENE.reservoir.maxY;
  }
  m.channels = (Array.isArray(source.channels) ? source.channels : []).filter((c) => c && Array.isArray(c.points) && c.points.length > 1 && c.points.every(safeTriple)).map((c) => ({ ...c, width: clamp(finite(c.width, 8), 0.1, 100) }));
  m.river = source.river && Array.isArray(source.river.points) && source.river.points.length > 1 && source.river.points.every(safeTriple) ? { ...DEFAULT_SCENE.river, ...source.river } : DEFAULT_SCENE.river;
  m.river = { ...m.river, width: clamp(finite(m.river.width, 30), 0.1, 500) };
  m.cameras = { ...DEFAULT_SCENE.cameras };
  m.customCameraNames = [];
  for (const [name, p] of Object.entries(source.cameras || {})) if (p && safeTriple(p.position) && safeTriple(p.target)) { m.cameras[name] = p; m.customCameraNames.push(name); }
  // Model URLs are always local relative assets, never a third-party resource.
  if (typeof m.model !== 'string' || !/^[a-zA-Z0-9_.-]+\.glb$/i.test(m.model)) m.model = DEFAULT_SCENE.model;
  return m;
}

const WATER_VERTEX = /* glsl */`
  uniform float uTime;
  uniform float uWaves;
  uniform float uChannel;
  uniform float uFlowPhase;
  uniform float uDepth;
  uniform float uStartDepth;
  uniform float uEndDepth;
  uniform float uLength;
  uniform float uInletLevel;
  uniform float uInletOverlap;
  uniform float uReservoirInlet;
  attribute vec3 aFlowTangent;
  varying vec3 vFlowTangent;
  uniform vec4 uWave[4];
  uniform mat4 textureMatrix;
  varying vec3 vWorld;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec4 vReflectUv;
  void main() {
    vUv = uv;
    vFlowTangent = normalize(mat3(modelMatrix) * aFlowTangent);
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 n = normalize(mat3(modelMatrix) * normal);
    float height = 0.;
    for (int i = 0; i < 4; i++) {
      vec4 wave = uWave[i];
      float phase = dot(wave.xy, world.xz) - wave.w * uTime + float(i) * 1.72;
      if (i < 2) height += wave.z * sin(phase);
    }
    // Geometric waves are small compared with wavelength; channel depth is
    // solved separately. A visual depth cap protects approximate terrain.
    float waterDepth = uDepth;
    if(uChannel>.5) {
      float transition=min(65.,uLength*.24);
      waterDepth=mix(uStartDepth,waterDepth,smoothstep(0.,transition,uv.y));
      waterDepth=mix(waterDepth,uEndDepth,smoothstep(uLength-transition,uLength,uv.y));
    }
    world.y += waterDepth;
    if(uReservoirInlet>.5) {
      // Keep the overlap with the horizontal lake flat, then descend behind
      // the gate. A depth-only blend leaves a step because the bed slopes.
      world.y=mix(uInletLevel,world.y,smoothstep(uInletOverlap,36.,uv.y));
    }
    world.y += height * uWaves * mix(.22,.06,uChannel);
    // Sub-grid waves affect analytic fragment normals, not under-resolved vertices.
    vNormal = normalize(n);
    vWorld = world;
    vReflectUv = textureMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;
const WATER_FRAGMENT = /* glsl */`
  uniform float uTime;
  uniform float uFlowPhase;
  uniform float uFlow;
  uniform float uChannel;
  uniform float uWidth;
  uniform float uFoamAmount;
  uniform float uWind;
  uniform float uRain;
  uniform float uOvercast;
  uniform float uReflection;
  uniform float uLength;
  uniform float uDepth;
  uniform float uVelocity;
  uniform float uSpill;
  varying vec3 vFlowTangent;
  uniform float uWaves;
  uniform vec4 uWave[4];
  uniform vec3 uDeep;
  uniform vec3 uLight;
  uniform sampler2D tDiffuse;
  varying vec3 vWorld;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec4 vReflectUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y);
  }
  // Filter each octave by its pixel footprint before it reaches a normal or
  // reflection. Unresolved waves should become roughness, not a moire grid.
  float filteredNoise(vec2 p) {
    float footprint=max(length(dFdx(p)),length(dFdy(p)));
    return mix(noise(p),.5,smoothstep(.32,1.1,footprint));
  }
  float fbm(vec2 p) { return filteredNoise(p)*.54 + filteredNoise(p*2.03+7.1)*.29 + filteredNoise(p*4.09-11.3)*.17; }
  void main() {
    // UV.y is actual centreline distance in metres. Advected foam travels at
    // Q / A metres per real second, following the ribbon through bends.
    // A mean-one parabolic profile makes the centre faster than the banks.
    // This visual shear profile is not a resolved velocity field.
    float lateral=abs(vUv.x-.5)*2.;
    float speedProfile=1.225-.675*lateral*lateral;
    float travel=48.;
    float phaseA=fract(uFlowPhase/travel),phaseB=fract(uFlowPhase/travel+.5);
    float phaseBlend=abs(phaseA*2.-1.);
    vec2 flowCoord=vec2(vUv.x*uWidth,vUv.y-phaseA*travel*speedProfile);
    vec2 flowCoordB=vec2(vUv.x*uWidth,vUv.y-phaseB*travel*speedProfile);
    vec2 p=mix(vWorld.xz,flowCoord,uChannel);
    vec2 pB=mix(vWorld.xz,flowCoordB,uChannel);
    float detailSpeed = mix(uTime * 0.28, 0., uChannel);
    vec2 ripple = p * vec2(.37,.43) + vec2(-detailSpeed, detailSpeed*.6);
    float eps = .12;
    float nx = (fbm(ripple+vec2(eps,0.))-fbm(ripple-vec2(eps,0.)));
    float nz = (fbm(ripple+vec2(0.,eps))-fbm(ripple-vec2(0.,eps)));
    if(uChannel>.5) {
      vec2 rippleB=pB*vec2(.37,.43);
      nx=mix(nx,fbm(rippleB+vec2(eps,0.))-fbm(rippleB-vec2(eps,0.)),phaseBlend);
      nz=mix(nz,fbm(rippleB+vec2(0.,eps))-fbm(rippleB-vec2(0.,eps)),phaseBlend);
    }
    float microRoughness = .085 + min(uWind,20.)*.004 + uRain*.065;
    vec2 gradient=vec2(0.);
    for(int i=0;i<4;i++) {
      vec4 wave=uWave[i];
      float phase=dot(wave.xy,vWorld.xz)-wave.w*uTime+float(i)*1.72;
      float resolved=1.-smoothstep(.65,2.8,fwidth(phase));
      gradient+=wave.xy*wave.z*cos(phase)*resolved;
    }
    vec3 flowTangent=normalize(vFlowTangent);
    vec3 flowSide=normalize(vec3(flowTangent.z,0.,-flowTangent.x));
    vec3 rippleNormal=mix(vec3(nx,0.,nz),flowSide*nx+flowTangent*nz,uChannel);
    // Random microstructure dominates. Small long waves stay coherent without
    // turning the reflection into a broad repeated zebra pattern.
    vec3 N = normalize(vNormal+rippleNormal*microRoughness-vec3(gradient.x,0.,gradient.y)*uWaves*.20);
    // Rain impacts have jittered centres and independent start times. At
    // distances where a ring is sub-pixel, retain roughness rather than drawing
    // a repeated cell grid or unstable high-frequency highlights.
    float surfaceFootprint=max(length(dFdx(vWorld.xz)),length(dFdy(vWorld.xz)));
    float rainResolved=1.-smoothstep(.08,.35,surfaceFootprint);
    vec2 rainNormal=vec2(0.);
    if(uRain>.001 && rainResolved>.001) {
      vec2 rainCoord=vWorld.xz*1.4;
      vec2 baseCell=floor(rainCoord);
      for(int ix=-1;ix<=1;ix++) for(int iz=-1;iz<=1;iz++) {
        vec2 cell=baseCell+vec2(float(ix),float(iz));
        vec2 centre=cell+vec2(.1+.8*hash(cell+17.3),.1+.8*hash(cell+83.1));
        vec2 radial=rainCoord-centre;
        float radius=length(radial);
        float rainAge=fract(uTime*1.8+hash(cell+41.));
        float ringPhase=radius*42.-rainAge*18.;
        float ringFilter=1.-smoothstep(.65,2.8,fwidth(ringPhase));
        float ring=sin(ringPhase)*exp(-abs(radius-rainAge*.4)*22.)*(1.-rainAge);
        rainNormal+=radial/max(.001,radius)*ring*ringFilter;
      }
    }
    N.xz += rainNormal*uRain*rainResolved*.012;
    N = normalize(N);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(vec3(-0.45, 0.8, -0.4));
    float facing = max(0.,dot(N,V));
    float fresnel = .0204 + .9796*pow(1.-facing,5.);
    vec3 reflectedDir = reflect(-V,N);
    vec3 skyColor = mix(vec3(.44,.60,.69),vec3(.19,.38,.51),max(0.,reflectedDir.y));
    skyColor = mix(skyColor,vec3(.34,.40,.43),uOvercast*.7);
    vec3 reflection = skyColor;
    if(uReflection>.5 && vReflectUv.w>0.) {
      vec2 mirrorUv = vReflectUv.xy/vReflectUv.w + N.xz*.025;
      mirrorUv=clamp(mirrorUv,vec2(.004),vec2(.996));
      float blur=.00025+uRain*.0012+min(uWind,20.)*.000025;
      reflection=texture2D(tDiffuse,mirrorUv).rgb*.5;
      reflection+=(texture2D(tDiffuse,mirrorUv+vec2(blur,0.)).rgb+texture2D(tDiffuse,mirrorUv-vec2(blur,0.)).rgb
                 +texture2D(tDiffuse,mirrorUv+vec2(0.,blur)).rgb+texture2D(tDiffuse,mirrorUv-vec2(0.,blur)).rgb)*.125;
    }
    float bodyVariation = fbm(vWorld.xz*.035) * .09;
    float edge=abs(vUv.x-.5)*2.;
    float shallow=smoothstep(.55,1.,edge)*uChannel;
    float opticalDepth=1.-exp(-max(.08,uDepth)*.8);
    vec3 body = mix(uDeep,uLight,.12+bodyVariation+shallow*.20);
    body=mix(body,vec3(.17,.22,.16),shallow*.20*(1.-opticalDepth));
    body *= 1.-uOvercast*.2;
    vec3 color = mix(body,reflection,clamp(fresnel,.025,.95));
    vec3 halfVector = normalize(L+V);
    float sun = pow(max(0.,dot(N,halfVector)),200.);
    color += vec3(1.,.91,.70)*sun*.42*pow(max(0.,1.-uOvercast),2.4);
    // Stretched, advecting micro-eddies follow the channel. Aeration appears
    // mainly where fast spillway flow meets the slower receiving reach.
    vec2 warp=vec2(filteredNoise(p*.09+5.),filteredNoise(p*.065+18.))*1.5;
    float foamPattern=0.;
    if(uChannel>.5) {
      vec2 warpB=vec2(filteredNoise(pB*.09+5.),filteredNoise(pB*.065+18.))*1.5;
      foamPattern=mix(fbm(p*vec2(.38,.11)+warp),fbm(pB*vec2(.38,.11)+warpB),phaseBlend);
    }
    float tail=smoothstep(uLength*.68,uLength*.97,vUv.y);
    float toe=exp(-pow((vUv.y-uLength*.93)/max(8.,uLength*.1),2.));
    float shear=smoothstep(.78,.97,edge)*.07;
    float aeration=mix(.025+shear,.035+tail*.17+toe*.15,uSpill);
    float foam=smoothstep(.63,.82,foamPattern)*aeration*uFoamAmount*uChannel*min(1.,uFlow*3.);
    color=mix(color,vec3(.68,.76,.71)*(1.-uOvercast*.12),clamp(foam,0.,.26));
    float alpha=mix(1.,mix(.94,.74,smoothstep(.87,1.,edge)),uChannel);
    gl_FragColor = vec4(color,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function waterMaterial({ channel = false, deep = '#183e37', light = '#47665b', waves = 1, foam = 0, width = 30, length = 1, spill = false } = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uFlowPhase: { value: 0 }, uFlow: { value: 0 }, uChannel: { value: channel ? 1 : 0 },
      uFoamAmount: { value: foam }, uWidth: { value: width }, uDepth: { value: 0 },
      uStartDepth: { value: 0 }, uEndDepth: { value: 0 }, uInletLevel: { value: 0 }, uInletOverlap: { value: 8.2 }, uReservoirInlet: { value: 0 }, uLength: { value: length }, uVelocity: { value: 0 }, uSpill: { value: spill ? 1 : 0 },
      uWind: { value: 3 }, uRain: { value: 0 }, uOvercast: { value: 0 }, uReflection: { value: 0 },
      uDeep: { value: new THREE.Color(deep) }, uLight: { value: new THREE.Color(light) }, uWaves: { value: waves },
      uWave: { value: windWaves().map(w => new THREE.Vector4(w.kx,w.kz,w.amplitudeM,w.omega)) },
      tDiffuse: { value: null }, color: { value: new THREE.Color('#ffffff') }, textureMatrix: { value: new THREE.Matrix4() },
    },
    vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT,
    side: THREE.DoubleSide, transparent: channel, depthWrite: !channel,
  });
  material.defaultAttributeValues.aFlowTangent=[0,0,1];
  return material;
}

/** Clip the illustrative basin outline into a regular wave-resolving grid.
 * ShapeGeometry alone only triangulates the boundary: it has no interior mesh.
 * Each cell is clipped to the polygon, preserving the original shoreline.
 */
function reservoirGeometry(settings) {
  const polygon = settings.polygon;
  if (Array.isArray(polygon) && polygon.length >= 3 && polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
    const minX=Math.min(...polygon.map(p=>p[0])),maxX=Math.max(...polygon.map(p=>p[0]));
    const minZ=Math.min(...polygon.map(p=>p[1])),maxZ=Math.max(...polygon.map(p=>p[1]));
    const spacing=Math.max(3.5,Math.sqrt((maxX-minX)*(maxZ-minZ)/36000));
    const positions=[],uv=[],indices=[];
    const clip=(input,axis,bound,greater)=>{
      const out=[];
      for(let i=0;i<input.length;i++) {
        const a=input[i],b=input[(i+1)%input.length];
        const ai=greater?a[axis]>=bound:a[axis]<=bound,bi=greater?b[axis]>=bound:b[axis]<=bound;
        if(ai) out.push(a);
        if(ai!==bi) { const t=(bound-a[axis])/(b[axis]-a[axis]);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]); }
      }
      return out;
    };
    for(let x=minX;x<maxX;x+=spacing) for(let z=minZ;z<maxZ;z+=spacing) {
      let cell=clip(polygon,0,x,true);cell=clip(cell,0,x+spacing,false);cell=clip(cell,1,z,true);cell=clip(cell,1,z+spacing,false);
      if(cell.length<3) continue;
      // Eliminate adjacent coincident boundary points before ear triangulation.
      cell=cell.filter((p,i)=>Math.hypot(p[0]-cell[(i+1)%cell.length][0],p[1]-cell[(i+1)%cell.length][1])>1e-7);
      if(cell.length<3) continue;
      const contour=cell.map(p=>new THREE.Vector2(p[0],-p[1]));
      const faces=THREE.ShapeUtils.triangulateShape(contour,[]),base=positions.length/3;
      for(const p of cell){positions.push(p[0],0,p[1]);uv.push(p[0],p[1]);}
      for(const f of faces)indices.push(...f.map(i=>base+i));
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);
    const normals=new Float32Array(positions.length);for(let i=1;i<normals.length;i+=3)normals[i]=1;
    g.setAttribute('normal',new THREE.BufferAttribute(normals,3));
    return g;
  }
  const g = new THREE.PlaneGeometry(settings.size[0], settings.size[1], 160, 192);
  g.rotateX(-Math.PI / 2); g.translate(settings.center[0], 0, settings.center[2]);
  return g;
}

function disposeObject(object) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    for (const m of Array.isArray(child.material) ? child.material : child.material ? [child.material] : []) {
      materials.add(m);
      for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
    }
  });
  geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose());
}

function addSky(scene) {
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 16), new THREE.ShaderMaterial({
    uniforms: { top: { value: new THREE.Color('#5b92b1') }, horizon: { value: new THREE.Color('#bdced6') } },
    vertexShader: 'varying vec3 vPosition; void main(){ vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vPosition;
      void main(){float h=normalize(vPosition).y; vec3 c=mix(horizon,top,pow(max(0.,h),0.55));
      gl_FragColor=vec4(c,1.);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false,
  }));
  sky.frustumCulled = false; scene.add(sky); return sky;
}

function seeded(index) { const x = Math.sin(index * 127.13 + 37.3) * 43758.5453; return x - Math.floor(x); }

function makeSpray(channel) {
  const count = 380;
  const positions = new Float32Array(count * 3), sizes = new Float32Array(count), alphas = new Float32Array(count);
  for (let i = 0; i < count; i++) { sizes[i] = 0.5 + seeded(i + 4) * 1.3; alphas[i] = 0; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  g.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: `attribute float aSize; attribute float aAlpha; uniform float uPixelRatio; varying float vAlpha;
      void main(){vAlpha=aAlpha;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=clamp(aSize*155.*uPixelRatio/max(1.,-mv.z),1.,42.);gl_Position=projectionMatrix*mv;}`,
    fragmentShader: `varying float vAlpha;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;
      gl_FragColor=vec4(.84,.91,.90, exp(-r*r*4.)*vAlpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment> }`,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Points(g, material);
  mesh.frustumCulled = false;
  const end = channel.curve.getPointAt(0.985), dir = channel.curve.getTangentAt(0.98);
  const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
  return {
    mesh,
    update(time, hydraulic, intensity, pixelRatio) {
      material.uniforms.uPixelRatio.value = pixelRatio;
      mesh.visible = hydraulic.dischargeCms > 0 && intensity > 0.002;
      if (!mesh.visible) return;
      // Launch energy is a bounded fraction of computed channel velocity;
      // air drag is omitted, gravity is exact, and particles die on return.
      const splashSpeed = Math.min(9, hydraulic.velocityMs * 0.30);
      const visibleDepth = Math.min(2.5,hydraulic.depthM);
      for (let i = 0; i < count; i++) {
        const vy = Math.max(.25,splashSpeed*(.35+seeded(i+232)*.65));
        const flightTime = 2*vy/GRAVITY;
        const age = (time + seeded(i)*flightTime) % flightTime;
        const lateral = (seeded(i + 514) - 0.5) * channel.width;
        const lateralVelocity=(seeded(i+353)-.5)*splashSpeed*.7;
        const alongSpeed = Math.min(18,hydraulic.velocityMs)*(.12+seeded(i+897)*.18);
        positions[i*3] = end.x + side.x*(lateral+lateralVelocity*age) + dir.x*age*alongSpeed;
        positions[i*3+1] = end.y + visibleDepth + vy*age - .5*GRAVITY*age*age;
        positions[i*3+2] = end.z + side.z*(lateral+lateralVelocity*age) + dir.z*age*alongSpeed;
        const life=age/flightTime;
        alphas[i] = Math.min(1,life*8)*Math.min(1,(1-life)*5)*intensity*(.17+seeded(i+75)*.28);
      }
      g.attributes.position.needsUpdate = true; g.attributes.aAlpha.needsUpdate = true;
    },
  };
}

export function createViewer(container, { onStatus = () => {}, onFeatureSelect = () => {} } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('3D 화면을 표시할 요소가 필요합니다.');
  container.classList.add('twin-viewer');
  const canvas = document.createElement('canvas');
  canvas.className = 'twin-viewer-canvas';
  canvas.setAttribute('aria-label', '댐 3D 보기. 마우스로 회전하고 휠로 확대합니다.');
  canvas.setAttribute('role', 'img');
  canvas.tabIndex = 0;
  const message = document.createElement('div');
  message.className = 'twin-viewer-status';
  message.setAttribute('role', 'status');
  const note = document.createElement('div');
  note.className = 'twin-viewer-note';
  note.textContent = '수위 변화는 축약 표현, 흐름은 단순 수리 근사, 관측 보정 전';
  const annotationLayer=document.createElement('div');
  annotationLayer.className='twin-feature-layer twin-feature-labels';
  annotationLayer.setAttribute('aria-label','시설 정보 바로 보기');
  container.append(canvas, message, note, annotationLayer);
  let phase = 'loading', modelLoaded = false, destroyed = false, contextLost = false;
  function status(nextPhase, text) {
    phase = nextPhase;
    message.textContent = text;
    message.dataset.phase = nextPhase;
    message.hidden = nextPhase === 'ready';
    onStatus({ phase, message: text, modelLoaded });
  }
  status('loading', '3D 지형과 댐 모델을 불러오는 중…');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  } catch {
    status('error', '이 환경에서 3D 화면을 시작하지 못했습니다. 브라우저의 그래픽 가속을 확인해 주세요. 계산 결과는 계속 사용할 수 있습니다.');
    return { setState() {}, setView() {}, setWeather() {}, setSelection() {}, setAnnotations() {}, getHydraulicInfo() { return {}; }, setAutoOrbit() {}, setWaterMotion() {}, setQuality() {}, resize() {}, capture: async () => { throw new Error('3D 화면이 준비되지 않았습니다.'); }, dispose() { canvas.remove(); message.remove(); note.remove(); annotationLayer.remove(); } };
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    console.error('TWIN 3D shader:', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment));
    status('error', '물 표현을 위한 그래픽 처리를 시작하지 못했습니다. 브라우저 그래픽 가속을 확인하거나 다른 브라우저에서 열어 주세요.');
  };
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce8e9');
  scene.fog = new THREE.FogExp2('#9fb8c8', 0.001);
  const sky = addSky(scene);
  const camera = new THREE.PerspectiveCamera(43, 1, 0.5, 2400);
  camera.position.copy(V3(DEFAULT_SCENE.cameras.overview.position));
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(V3(DEFAULT_SCENE.cameras.overview.target));
  controls.enableDamping = true; controls.dampingFactor = 0.075;
  controls.minDistance = 14; controls.maxDistance = 700;
  controls.minPolarAngle = 0.025; controls.maxPolarAngle = Math.PI * 0.495;
  controls.autoRotateSpeed = 0.34;
  controls.screenSpacePanning = true;
  controls.listenToKeyEvents(canvas);
  controls.update();
  const hemi = new THREE.HemisphereLight('#d8efff', '#536b56', 1.05); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff7e5', 2.4);
  sun.position.set(-100, 170, -80); sun.target.position.set(0, 8, 0);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -220, right: 220, top: 240, bottom: -220, near: 1, far: 700 });
  sun.shadow.normalBias = 0.8; sun.shadow.bias = -0.00025;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight('#d3efff', 0.35); fill.position.set(150, 75, 150); scene.add(fill);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.06);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.45;
  room.dispose(); pmrem.dispose();

  const modelGroup = new THREE.Group(), waterGroup = new THREE.Group();
  scene.add(modelGroup, waterGroup);
  const waters = [], channels = [], riverReaches = [];
  let manifest = cleanManifest({}), reservoir = null, river = null, riverHydraulics = null;
  let waterMotion = true, quality = 'high', autoOrbit = false, viewTween = null, currentView = 'overview';
  let lastRow = null, lastConfig = null, lastMeta = {}, currentLevel = 30, desiredLevel = 30;
  let desiredFlows = { release: 0, spill: 0, turbine: 0 }, flows = { release: 0, spill: 0, turbine: 0 };
  let maxRelease = 300, maxTurbine = 80, raf = null, lastFrame = performance.now(), time = 0, intersecting = true;
  let renderWidth = 0, renderHeight = 0, pixelRatio = 1;
  let metricStarted=performance.now(), metricFrames=0, metricRenderMs=0;
  let selectedFeature='reservoir', annotationsVisible=true;
  // AI forecast level: a translucent plane at the predicted level (presentation only).
  let forecastPlane=null, forecastEdge=null, forecastLevelM=null;
  const FORECAST_PATCH={x:65,z:-230,size:260}; // in front of the intake tower; manifest polygon front edge is z=4
  function applyForecastPlane() {
    if(!forecastPlane) return;
    const visible=Number.isFinite(forecastLevelM) && lastConfig;
    forecastPlane.visible=visible; forecastEdge.visible=visible;
    if(!visible) return;
    const mapped=mapVisualState({levelM:forecastLevelM},lastConfig,manifest.reservoir);
    forecastPlane.position.y=mapped.level+.3; forecastEdge.position.y=mapped.level+.3;
  }
  let forecastMeta=null;
  function setForecast(levelM, meta) {
    forecastLevelM=Number.isFinite(levelM)?levelM:null;
    forecastMeta=forecastLevelM===null?null:(meta||{});
    if(forecastLabel) {
      if(forecastMeta) {
        const h=forecastMeta.horizonHours, delta=forecastMeta.deltaM;
        forecastLabelName.textContent=`AI 예상 수위${Number.isFinite(h)?` (${h}시간 뒤)`:''}`;
        forecastLabelValue.textContent=`${forecastLevelM.toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2})} m${Number.isFinite(delta)?` (${delta>=0?'+':'−'}${Math.abs(delta).toLocaleString('ko-KR',{minimumFractionDigits:2,maximumFractionDigits:2})})`:''}`;
        forecastLabel.title=forecastMeta.note||'AI 예측 유입량을 현재 저수량에서 목표 저수량 유지 규칙으로 계산한 예상 수위입니다. 실제 수위 예보가 아닙니다.';
      }
      forecastLabel.hidden=!forecastMeta;
    }
    applyForecastPlane();
  }
  const featureNames={reservoir:'저수지',powerhouse:'발전 방류',spillway:'여수로',downstream:'하류 합류'};
  const featureButtons={};
  for(const [id,title] of Object.entries(featureNames)) {
    const button=document.createElement('button');button.type='button';
    button.className='twin-feature-label';button.dataset.feature=id;
    button.setAttribute('aria-label',`${title} 정보`);
    const caption=document.createElement('span');caption.className='twin-feature-name';caption.textContent=title;
    const value=document.createElement('strong');value.className='twin-feature-value';
    button.append(caption,value);button.hidden=true;
    button.addEventListener('click',()=>{setSelection(id);onFeatureSelect(id);});
    annotationLayer.append(button);featureButtons[id]={button,value};
  }
  const forecastLabel=document.createElement('div');
  forecastLabel.className='twin-feature-label twin-forecast-label';
  forecastLabel.setAttribute('role','note');
  const forecastLabelName=document.createElement('span');forecastLabelName.className='twin-feature-name';forecastLabelName.textContent='AI 예상 수위';
  const forecastLabelValue=document.createElement('strong');forecastLabelValue.className='twin-feature-value';
  forecastLabel.append(forecastLabelName,forecastLabelValue);forecastLabel.hidden=true;
  annotationLayer.prepend(forecastLabel);
  function setSelection(id) {
    if(!featureNames[id])return;
    selectedFeature=id;
    for(const [key,{button}] of Object.entries(featureButtons)) {
      button.dataset.selected=String(key===id);button.setAttribute('aria-pressed',String(key===id));
    }
  }
  function setAnnotations(value) { annotationsVisible=Boolean(value);annotationLayer.hidden=!annotationsVisible; }
  function featurePositions() {
    const spill=channels.find(c=>c.kind==='spill'),tail=channels.find(c=>c.kind==='turbine');
    const lower=riverReaches.find(c=>c.kind==='release');
    return {
      reservoir:new THREE.Vector3(manifest.reservoir.center[0],currentLevel+8,manifest.reservoir.center[2]*.6),
      spillway:spill?spill.curve.getPointAt(.42).add(new THREE.Vector3(0,18,0)):V3(manifest.cameras.spillway.target),
      powerhouse:tail?tail.curve.getPointAt(.025).add(new THREE.Vector3(0,28,0)):V3(manifest.cameras.downstream.target),
      downstream:lower?lower.curve.getPointAt(.33).add(new THREE.Vector3(0,16,0)):V3(manifest.cameras.downstream.target),
    };
  }
  function updateAnnotations() {
    if(!annotationsVisible)return;
    const projected=featurePositions(),labels=[];
    for(const [id,position] of Object.entries(projected)) {
      const {button}=featureButtons[id],p=position.project(camera);
      const x=(p.x+1)*.5*renderWidth,y=(1-p.y)*.5*renderHeight;
      button.hidden=!modelLoaded||p.z<-1||p.z>1||x<20||x>renderWidth-20||y<20||y>renderHeight-45;
      if(button.hidden)continue;
      let py=clamp(y,45,renderHeight-60);
      for(const label of labels)if(Math.abs(label.x-x)<120&&Math.abs(label.y-py)<48)py=label.y+52;
      button.style.left=`${clamp(x,65,renderWidth-65)}px`;button.style.top=`${Math.min(renderHeight-58,py)}px`;
      labels.push({x,y:py});
    }
    if(forecastMeta&&forecastPlane) {
      const anchor=new THREE.Vector3(FORECAST_PATCH.x,forecastPlane.position.y+8,FORECAST_PATCH.z).project(camera);
      const x=(anchor.x+1)*.5*renderWidth,y=(1-anchor.y)*.5*renderHeight;
      const hidden=!modelLoaded||anchor.z<-1||anchor.z>1||x<20||x>renderWidth-20||y<20||y>renderHeight-45;
      forecastLabel.hidden=hidden;
      if(!hidden) {
        let py=clamp(y,45,renderHeight-60);
        for(const label of labels)if(Math.abs(label.x-x)<300&&Math.abs(label.y-py)<48)py=label.y+52;
        forecastLabel.style.left=`${clamp(x,80,renderWidth-80)}px`;forecastLabel.style.top=`${Math.min(renderHeight-58,py)}px`;
      }
    } else forecastLabel.hidden=true;
  }
  function getHydraulicInfo() {
    const result={};
    for(const [id,descriptor,flow] of [
      ['spillway',channels.find(c=>c.kind==='spill'),desiredFlows.spill],
      ['powerhouse',channels.find(c=>c.kind==='turbine'),desiredFlows.turbine],
      ['downstream',riverReaches.find(c=>c.kind==='release'),desiredFlows.release],
    ]) if(descriptor)result[id]={...solveChannel({...descriptor.hydraulicAssumptions,dischargeCms:flow}),status:'uncalibrated-visual'};
    return result;
  }
  setSelection(selectedFeature);

  const abort = new AbortController();
  const weather = createWeather({ scene, camera, renderer, sun, hemi, sky, modelGroup, getWaterLevel: () => currentLevel, getWaterPolygon: () => manifest.reservoir.polygon });
  let weatherState = { preset: 'clear', rainMmH: 0, windMs: 3, label: '맑음' };
  function setWeather(value = {}) {
    weatherState = weather.set(value) || { ...weatherState, ...value };
    const waves = windWaves(weatherState.windMs, finite(manifest.reservoir.depthM,45));
    for (const material of waters) {
      material.uniforms.uWind.value = weatherState.windMs;
      material.uniforms.uRain.value = clamp(weatherState.rainMmH / 60,0,1);
      material.uniforms.uOvercast.value = finite(weatherState.cloudCover,weatherState.preset === 'clear' ? 0 : .8);
      waves.forEach((w,i) => material.uniforms.uWave.value[i].set(w.kx,w.kz,w.amplitudeM,w.omega));
    }
  }

  function resize() {
    if (destroyed) return;
    const bounds = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(bounds.width)), h = Math.max(1, Math.round(bounds.height));
    if (w === renderWidth && h === renderHeight) return;
    renderWidth = w; renderHeight = h;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container);
  const intersectionObserver = new IntersectionObserver((entries) => { intersecting = entries[0]?.isIntersecting ?? true; }, { rootMargin: '100px' });
  intersectionObserver.observe(container);

  function setQuality(value) {
    quality = value === 'standard' ? 'standard' : 'high';
    weather.setQuality(quality);
    if (reservoir?.isReflector) reservoir.getRenderTarget().setSize(quality === 'high' ? 768 : 384, quality === 'high' ? 768 : 384);
    pixelRatio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.75 : 1);
    renderer.setPixelRatio(pixelRatio);
    const resolution = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(resolution, resolution);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
    // Ensure drawing buffer size is refreshed even when CSS bounds did not change.
    renderWidth = 0; resize();
  }

  function setView(name = 'overview', immediate = false) {
    currentView = name;
    const entry = manifest.cameras[name] || manifest.cameras.overview;
    if (immediate) {
      // Loading the manifest replaces the provisional camera coordinates. Any
      // earlier transition must be cancelled before applying those coordinates.
      viewTween = null;
      camera.position.copy(V3(entry.position)); controls.target.copy(V3(entry.target)); controls.update(); return;
    }
    viewTween = { started: performance.now(), from: camera.position.clone(), targetFrom: controls.target.clone(), to: V3(entry.position), targetTo: V3(entry.target) };
  }
  const cancelTween = () => { viewTween = null; };
  controls.addEventListener('start', cancelTween);

  function setState(row, config = {}, meta = {}) {
    lastRow = row; lastConfig = config; lastMeta = meta;
    const mapped = mapVisualState(row, config, manifest.reservoir);
    desiredLevel = mapped.level; desiredFlows = mapped.flows;
    applyForecastPlane();
    maxRelease = mapped.maxRelease; maxTurbine = mapped.maxTurbine;
    const format=value=>Number.isFinite(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'';
    featureButtons.reservoir.value.textContent=`${format(row?.levelM)} m`;
    featureButtons.spillway.value.textContent=`${format(mapped.flows.spill)} m³/s`;
    featureButtons.powerhouse.value.textContent=`${format(mapped.flows.turbine)} m³/s`;
    featureButtons.downstream.value.textContent=`${format(mapped.flows.release)} m³/s`;
    note.textContent = `${meta.dataKind === 'synthetic' ? '가상 데이터' : meta.dataKind === 'observed' ? '사용자 제공 자료' : '자료 연동'}, 수위와 유량 연동, 단순 수리 근사, 보정 전`;
  }

  function buildWater() {
    const lakeMaterial = waterMaterial();
    // Reflector expects local +Z as its plane normal. Rotate the geometry back
    // to XY, then orient the object to Y-up; rendered world coordinates agree.
    const lakeGeometry = reservoirGeometry(manifest.reservoir); lakeGeometry.rotateX(Math.PI/2);
    reservoir = new Reflector(lakeGeometry, {
      textureWidth: quality === 'high' ? 768 : 384, textureHeight: quality === 'high' ? 768 : 384,
      clipBias: .001, multisample: 0,
      shader: { uniforms: lakeMaterial.uniforms, vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT },
    });
    reservoir.material.defaultAttributeValues.aFlowTangent=[0,0,1];
    lakeMaterial.dispose(); reservoir.rotation.x = -Math.PI/2;
    reservoir.material.side=THREE.DoubleSide; reservoir.material.uniforms.uReflection.value=1;
    reservoir.position.y = desiredLevel; reservoir.renderOrder = 2;
    const reflect = reservoir.onBeforeRender;
    reservoir.onBeforeRender = function (...args) {
      const hidden = waterGroup.children.filter(child=>child!==reservoir).map(child=>[child,child.visible]);
      hidden.forEach(([child])=>{child.visible=false;});
      try { reflect.apply(this,args); } finally { hidden.forEach(([child,visible])=>{child.visible=visible;}); }
    };
    waterGroup.add(reservoir); waters.push(reservoir.material);
    const riverDescriptors=channelNetwork(manifest), bankPaths=[];
    for(const descriptor of riverDescriptors) {
      const points=descriptor.points.map(p=>[p[0],p[1]+finite(descriptor.bedOffsetM,0),p[2]]);
      const path=sampleChannel(points,descriptor.width,110,descriptor.interpolation||'smooth',true,descriptor.widths);
      const material=waterMaterial({channel:true,deep:'#173d35',light:'#4c6d57',waves:.12,foam:.45,width:descriptor.width,length:path.length});
      const mesh=new THREE.Mesh(channelWaterGeometry(path),material);mesh.renderOrder=3;
      riverReaches.push({...descriptor,...path,mesh,material,hydraulicAssumptions:channelAssumptions(descriptor)});
      bankPaths.push(path);waterGroup.add(mesh);waters.push(material);
      if(descriptor.kind==='release'){river=mesh;riverHydraulics=channelAssumptions(descriptor);}
    }
    for (const descriptor of manifest.channels) {
      const points=(descriptor.bedPoints||descriptor.points).map(p=>[p[0],p[1]+(descriptor.bedPoints?0:finite(descriptor.bedOffsetM,0)),p[2]]);
      const spill = descriptor.kind === 'spill';
      const path=sampleChannel(points,descriptor.width,160,descriptor.interpolation||(spill?'linear':'smooth'),!spill,descriptor.widths);
      const material=waterMaterial({channel:true,deep:spill?'#254944':'#193f37',light:spill?'#688277':'#527060',waves:spill?.035:.10,foam:spill?1:.45,width:descriptor.width,length:path.length,spill});
      const mesh=new THREE.Mesh(channelWaterGeometry(path),material);mesh.renderOrder=3;
      const channel={...descriptor,...path,mesh,material,hydraulicAssumptions:channelAssumptions(descriptor)};
      channel.spray=makeSpray(channel);
      if(!spill)bankPaths.push(path);
      waterGroup.add(mesh,channel.spray.mesh);waters.push(material);channels.push(channel);
    }
    modelGroup.add(createChannelTerrain(bankPaths));
    setWeather(weatherState);
    // A 260 m square marker patch in front of the dam (not the whole lake) shows the AI level; the label carries the number.
    const forecastGeometry=new THREE.PlaneGeometry(FORECAST_PATCH.size,FORECAST_PATCH.size);
    forecastPlane=new THREE.Mesh(forecastGeometry,new THREE.MeshBasicMaterial({color:'#f2c14e',transparent:true,opacity:.42,depthWrite:false,side:THREE.DoubleSide}));
    forecastPlane.rotation.x=-Math.PI/2; forecastPlane.renderOrder=4; forecastPlane.name='AI_Forecast_Level_Plane';
    forecastPlane.position.set(FORECAST_PATCH.x,0,FORECAST_PATCH.z);
    forecastEdge=new THREE.LineSegments(new THREE.EdgesGeometry(forecastGeometry),new THREE.LineBasicMaterial({color:'#b8860b',transparent:true,opacity:.9}));
    forecastEdge.rotation.x=-Math.PI/2; forecastEdge.renderOrder=5; forecastEdge.name='AI_Forecast_Level_Edge';
    forecastEdge.position.set(FORECAST_PATCH.x,0,FORECAST_PATCH.z);
    waterGroup.add(forecastPlane,forecastEdge);
    applyForecastPlane();
  }

  async function loadScene() {
    let manifestAvailable = true;
    const base = new URL('assets/models/', document.baseURI);
    try {
      const response = await fetch(new URL('twin-dam.scene.json', base), { signal: abort.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error('manifest unavailable');
      manifest = cleanManifest(await response.json());
    } catch (error) {
      if (destroyed || error.name === 'AbortError') return;
      manifestAvailable = false;
    }
    if (destroyed) return;
    if (lastRow) setState(lastRow, lastConfig, lastMeta);
    currentLevel = desiredLevel;
    buildWater(); setView(currentView, true);
    const loader = new GLTFLoader();
    try {
      const revision = String(manifest.assetRevision ?? manifest.version ?? 1).slice(0,120);
      let gltf;
      if (Array.isArray(manifest.modelParts) && manifest.modelParts.length) {
        // Hosted edition: the GLB is published as several files; fetch and join them.
        const buffers = [];
        for (const part of manifest.modelParts) {
          if (typeof part !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(part)) throw new Error('model part name rejected');
          const partURL = new URL(part, base); partURL.searchParams.set('v', revision);
          const response = await fetch(partURL.href, { signal: abort.signal });
          if (!response.ok) throw new Error('model part unavailable: ' + part);
          buffers.push(new Uint8Array(await response.arrayBuffer()));
        }
        const joined = new Uint8Array(buffers.reduce((n, b) => n + b.byteLength, 0));
        let offset = 0;
        for (const b of buffers) { joined.set(b, offset); offset += b.byteLength; }
        gltf = await loader.parseAsync(joined.buffer, base.href);
      } else {
        const modelURL = new URL(manifest.model, base);
        modelURL.searchParams.set('v', revision);
        gltf = await loader.loadAsync(modelURL.href);
      }
      if (destroyed) { disposeObject(gltf.scene); return; }
      gltf.scene.traverse((child) => {
        if (child.name.startsWith('WATER_STATIC')) child.visible = false;
        if (!child.isMesh) return;
        child.castShadow = true; child.receiveShadow = true;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          if (material.isMeshStandardMaterial) material.envMapIntensity = 0.58;
        }
      });
      // Continue the actual exported valley material over the new corridor.
      // The GLB exporter flips V: inspected TEXCOORD_0 is (x/32, 1+z/32).
      // Reusing that exact metre-scale PBR mapping avoids a visible grass mat.
      let valleyMaterial=null;
      gltf.scene.traverse(child=>{
        if(child.isMesh&&child.name.includes('Textured_Earth_Valley'))
          valleyMaterial=Array.isArray(child.material)?child.material[0]:child.material;
      });
      const apron=modelGroup.getObjectByName('Continuous_Channel_Valley');
      if(apron&&valleyMaterial) {
        apron.material=valleyMaterial.clone();apron.material.name=`${valleyMaterial.name}_Channel_Continuation`;
        apron.material.vertexColors=true;
        const positions=apron.geometry.attributes.position,uv=apron.geometry.attributes.uv,color=apron.geometry.attributes.color;
        for(let i=0;i<positions.count;i++) {
          const x=positions.getX(i),z=positions.getZ(i),blenderY=-z;
          uv.setXY(i,x/32,1+z/32);
          // Match build_soyang.py's terrain vertex tint, in linear RGB.
          const variation=.85+.15*Math.sin(x*.016+blenderY*.010)+.09*Math.cos(x*.051-blenderY*.013);
          const brightness=clamp(.80*(.083+.108+.056)*variation/(.065+.135+.04),.73,.95);
          color.setXYZ(i,brightness*.98,brightness,brightness*.94);
        }
        uv.needsUpdate=true;color.needsUpdate=true;
      }
      modelGroup.add(gltf.scene); modelLoaded = true;
      // Real facility geometry can be much larger than the initial placeholder.
      // Derive view distances and shadow volume from the actual exported bounds.
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
      const span = Math.max(100, size.x, size.z, size.y * 2);
      if (Number.isFinite(span) && span < 1e7) {
        camera.far = Math.max(2400, span * 12); camera.updateProjectionMatrix();
        controls.maxDistance = span * 3; controls.minDistance = Math.max(8, span * 0.008);
        sky.scale.setScalar(Math.max(1, span * 6 / 1600));
        scene.fog.density = 0.22 / span;
        sun.position.copy(center).add(new THREE.Vector3(-span * 0.45, span * 0.8, -span * 0.4));
        sun.target.position.copy(center);
        const shadowSpan = Number.isFinite(manifest.shadowRadius) ? manifest.shadowRadius : span * 0.6;
        Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: 1, far: span * 3 });
        sun.shadow.camera.updateProjectionMatrix();
        sun.shadow.normalBias = Math.max(0.15, span * 0.001);
        fill.position.copy(center).add(new THREE.Vector3(span * 0.7, span * 0.3, span * 0.7));
        const scale = Math.max(1, span / 350);
        for (const [key, entry] of Object.entries(DEFAULT_SCENE.cameras)) if (!(manifest.customCameraNames || []).includes(key)) manifest.cameras[key] = { position: entry.position.map((n, i) => n * scale + center.getComponent(i)), target: entry.target.map((n, i) => n * scale + center.getComponent(i)) };
        setView(currentView, true);
      }
      weather.setBounds(box); setWeather(weatherState);
      renderer.shadowMap.needsUpdate = true;
      status(manifestAvailable ? 'ready' : 'fallback', manifestAvailable ? `${manifest.name} 준비 완료` : '3D 모델은 열었지만 배치 정보가 없어 기본 카메라와 수면 위치를 표시합니다.');
    } catch (error) {
      if (!destroyed) status('error', '3D 시설 모델을 불러오지 못했습니다. 로컬 실행 주소와 모델 파일을 확인해 주세요. 계산 기능은 계속 사용할 수 있습니다.');
    }
  }

  function renderFrame(now) {
    if (destroyed) return;
    raf = requestAnimationFrame(renderFrame);
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000)); lastFrame = now;
    if (contextLost || document.hidden || !intersecting || !container.isConnected || renderHeight < 2 || renderWidth < 2) {
      metricStarted=now; metricFrames=0; metricRenderMs=0; return;
    }
    if (waterMotion) time += dt;
    const smoothing = 1 - Math.exp(-dt * 4);
    currentLevel = THREE.MathUtils.lerp(currentLevel, desiredLevel, smoothing);
    if (reservoir) reservoir.position.y = currentLevel;
    for (const key of Object.keys(flows)) flows[key] = THREE.MathUtils.lerp(flows[key], desiredFlows[key], smoothing);
    for (const material of waters) material.uniforms.uTime.value = time;
    const hydraulics={};
    for(const channel of [...channels,...riverReaches]) {
      const kind=channel.kind==='turbine'?'turbine':channel.kind==='release'?'release':'spill';
      const value=desiredFlows[kind]>0?flows[kind]:0;
      const h=solveChannel({...channel.hydraulicAssumptions,dischargeCms:value});
      hydraulics[channel.name||channel.id]=h;
      channel.hydraulic=h;
    }
    const downstream=riverReaches.find(c=>c.kind==='release');
    const upstream=riverReaches.find(c=>c.kind==='spill');
    const spillway=channels.find(c=>c.kind==='spill');
    for(const channel of [...channels,...riverReaches]) {
      const h=channel.hydraulic,kind=channel.kind==='turbine'?'turbine':channel.kind==='release'?'release':'spill';
      const intensity=clamp(h.dischargeCms/(kind==='turbine'?maxTurbine:maxRelease),0,1);
      const depth=Math.min(channel.kind==='release'?3:2.5,h.depthM);
      // The last few metres blend into the receiving surface; a height seam
      // must never look like water flowing uphill at a confluence.
      let startDepth=depth,endDepth=depth;
      if(channel===upstream&&spillway)startDepth=Math.min(2.5,spillway.hydraulic.depthM);
      if(channel===spillway&&upstream)endDepth=Math.min(2.5,spillway.hydraulic.depthM);
      if((channel===upstream||kind==='turbine')&&downstream)endDepth=Math.min(3,downstream.hydraulic.depthM);
      channel.mesh.visible=h.dischargeCms>0 || kind==='release';
      Object.assign(channel.material.uniforms.uDepth,{value:depth});
      channel.material.uniforms.uStartDepth.value=startDepth;
      channel.material.uniforms.uReservoirInlet.value=channel===spillway&&manifest.boundaryContract?1:0;
      channel.material.uniforms.uInletLevel.value=currentLevel;
      channel.material.uniforms.uEndDepth.value=endDepth;
      channel.material.uniforms.uFlow.value=intensity;
      channel.material.uniforms.uVelocity.value=h.velocityMs;
      if(waterMotion)channel.material.uniforms.uFlowPhase.value+=dt*h.velocityMs;
      if(channel.spray)channel.spray.update(time,h,intensity*.45,pixelRatio);
    }
    weather.update(dt,time);
    if (viewTween) {
      const t = clamp((now - viewTween.started) / 1350, 0, 1), e = t * t * (3 - 2 * t);
      camera.position.lerpVectors(viewTween.from, viewTween.to, e);
      controls.target.lerpVectors(viewTween.targetFrom, viewTween.targetTo, e);
      if (t >= 1) viewTween = null;
    }
    controls.autoRotate = autoOrbit && !viewTween;
    controls.update(dt);
    updateAnnotations();
    const renderStarted=performance.now();
    renderer.render(scene, camera);
    metricRenderMs+=performance.now()-renderStarted; metricFrames++;
    if(now-metricStarted>=1000) {
      // Local development diagnostics; no telemetry leaves the browser.
      canvas.dataset.renderFps=(metricFrames*1000/(now-metricStarted)).toFixed(1);
      canvas.dataset.renderMs=(metricRenderMs/metricFrames).toFixed(1);
      metricStarted=now; metricFrames=0; metricRenderMs=0;
    }
    // Terrain, structures and lights are static; reuse their shadow map while
    // camera and water animate. Quality/model changes request a fresh map.
    renderer.shadowMap.autoUpdate = false;
  }

  function onLost(event) {
    event.preventDefault(); contextLost = true;
    status('error', '그래픽 연결이 일시 중단되었습니다. 잠시 후 자동 복구합니다. 복구되지 않으면 새로고침해 주세요.');
  }
  function onRestored() {
    contextLost = false; renderer.shadowMap.needsUpdate = true;
    status(modelLoaded ? 'ready' : 'loading', modelLoaded ? '3D 화면 복구 완료' : '3D 모델을 불러오는 중…');
  }
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);
  setQuality(quality); resize(); loadScene(); raf = requestAnimationFrame(renderFrame);

  return {
    setState, setView, setWeather, setSelection, setAnnotations, getHydraulicInfo, setForecast,
    setAutoOrbit(value) { autoOrbit = Boolean(value); },
    setWaterMotion(value) { waterMotion = Boolean(value); },
    setQuality, resize,
    async capture({ information } = {}) {
      if (destroyed || contextLost || !modelLoaded) throw new Error('3D 모델을 불러온 다음 화면을 저장해 주세요.');
      renderer.render(scene, camera);
      const output = document.createElement('canvas');
      const hasInformation=information && typeof information==='object';
      const infoWidth=hasInformation?Math.round(canvas.width*.32):0;
      output.width = canvas.width+infoWidth; output.height = canvas.height;
      const ctx = output.getContext('2d');
      if (!ctx) throw new Error('이미지 저장을 시작하지 못했습니다.');
      ctx.drawImage(canvas, 0, 0);
      const footer = Math.max(46, Math.round(canvas.width / 27));
      ctx.fillStyle = 'rgba(16, 45, 50, 0.88)'; ctx.fillRect(0, output.height - footer, output.width, footer);
      ctx.font = `500 ${Math.max(11, Math.round(footer * 0.25))}px sans-serif`; ctx.fillStyle = '#eff9f7';
      ctx.fillText(`TWIN | ${manifest.name} | ${lastMeta.dataKind === 'synthetic' ? '가상 자료' : '사용자 제공 자료'} | ${weatherState.label || weatherState.preset} | 단순 수리 근사`, footer * 0.35, output.height - footer * 0.43, output.width - footer);
      if(hasInformation) {
        // Keep the original 3D view intact and append a separate information
        // column, with the selected facility's quantities before common ones.
        const scale=Math.min(canvas.width/1600,canvas.height/750),pad=24*scale,panel=infoWidth,left=canvas.width;
        ctx.fillStyle='rgba(12,34,38,.94)';ctx.fillRect(left,0,panel,output.height-footer);
        let y=pad;
        const write=(text,size=14,color='#c5dbd8',maxLines=3)=>{
          ctx.font=`${size>=20?600:400} ${size*scale}px sans-serif`;ctx.fillStyle=color;
          const chars=Array.from(String(text??''));let line='',lines=0;
          for(const ch of chars){if(ctx.measureText(line+ch).width>panel-pad*2&&line){ctx.fillText(line,left+pad,y);y+=(size+7)*scale;line='';if(++lines>=maxLines)return;}line+=ch;}
          if(line){ctx.fillText(line,left+pad,y);y+=(size+7)*scale;}
        };
        y+=20*scale;write(information.featureTitle||information.title||'시설 정보',25,'#effaf7');
        write(information.interval||'',12);write(information.sourceLabel||information.dataKind||'',12,'#84c7b5');y+=9*scale;
        const seenLabels=new Set();
        const candidates=[...(information.featureMetrics||[]),...(information.common||[])];
        const selectedMetrics=(candidates.length?candidates:(information.metrics||[])).filter(metric=>{
          if(seenLabels.has(metric.label))return false;seenLabels.add(metric.label);return true;
        }).slice(0,6);
        for(const metric of selectedMetrics) {
          if(y>output.height-footer-75*scale)break;
          write(metric.label,12);write(`${Number.isFinite(metric.value)?metric.value.toLocaleString('ko-KR',{maximumFractionDigits:metric.digits??1}):metric.value??'미제공'}${metric.unit?' '+metric.unit:''}`,22,'#ffffff');
          if(metric.source)write(metric.source,10,'#8facac',1);y+=7*scale;
        }
        if(y<output.height-footer-60*scale)write(information.explanation||'',12,'#d3e4df',3);
        for(const note of (information.notes||[]).slice(0,2))if(y<output.height-footer-25*scale)write(note,10,'#95b1af',2);
      }
      const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('이미지를 만들지 못했습니다. 다시 시도해 주세요.');
      return blob;
    },
    dispose() {
      if (destroyed) return;
      destroyed = true; abort.abort(); cancelAnimationFrame(raf);
      resizeObserver.disconnect(); intersectionObserver.disconnect();
      controls.removeEventListener('start', cancelTween); controls.dispose();
      canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored);
      weather.dispose();
      if(reservoir?.isReflector)reservoir.dispose();
      disposeObject(scene); envTarget.dispose(); renderer.dispose(); renderer.forceContextLoss();
      canvas.remove(); message.remove(); note.remove(); annotationLayer.remove();
    },
  };
}
