import * as THREE from 'three';

/** Illustrative local weather, deliberately independent of reservoir inflow. */
export const WEATHER_PRESETS = Object.freeze({
  clear: { preset: 'clear', label: '맑음', rainMmH: 0, windMs: 2.5 },
  rain: { preset: 'rain', label: '비', rainMmH: 8, windMs: 5 },
  monsoon: { preset: 'monsoon', label: '장마', rainMmH: 45, windMs: 11 },
});
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const noise = (i) => { const x = Math.sin(i * 132.137 + 19.41) * 43758.5453; return x - Math.floor(x); };

export function normalizeWeather(value = {}) {
  const preset = Object.hasOwn(WEATHER_PRESETS, value.preset) ? value.preset : 'clear';
  const base = WEATHER_PRESETS[preset];
  const rainMmH = clamp(finite(value.rainMmH, base.rainMmH), 0, 80);
  const windMs = clamp(finite(value.windMs, base.windMs), 0, 20);
  const wetness = rainMmH > 0 ? clamp(Math.pow(rainMmH / 45, 0.48), 0, 1) : 0;
  return { preset, rainMmH, windMs, wetness,
    cloudCover: preset === 'monsoon' ? 0.96 : rainMmH > 0 ? 0.72 + Math.min(0.2, rainMmH / 200) : 0.28,
    label: base.label };
}

const cloudFragment = `
  uniform vec3 top; uniform vec3 horizon; uniform float uTime;
  uniform float uCover; uniform float uWet; uniform float uWind;
  varying vec3 vPosition;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float n2(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
    return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y); }
  float fbm(vec2 p){ float a=.5,v=0.; for(int i=0;i<5;i++){v+=a*n2(p);p=mat2(1.6,1.2,-1.2,1.6)*p;a*=.5;}return v; }
  void main(){
    vec3 d=normalize(vPosition); float h=max(0.,d.y);
    vec3 base=mix(horizon,top,pow(h,.55));
    // Flat cloud strata viewed in perspective, with a second, slower layer.
    vec2 p=d.xz/max(.115,d.y+.14)*1.65 + vec2(uTime*uWind*.00055,uTime*uWind*.00024);
    float f=fbm(p), fine=fbm(p*2.45+vec2(13.1,7.8));
    float cloud=smoothstep(.68-uCover*.42,.82-uCover*.32,f*.8+fine*.2);
    cloud=max(cloud,uWet*.62);
    float light=clamp(fbm(p+vec2(-.12,.07)) - f + .45,0.,1.);
    vec3 cLight=mix(vec3(.94,.97,1.),vec3(.43,.49,.56),uWet*.72);
    vec3 cShade=mix(vec3(.64,.72,.79),vec3(.21,.27,.33),uWet*.80);
    vec3 cloudColor=mix(cShade,cLight,smoothstep(.23,.61,light));
    cloud*=smoothstep(-.07,.11,d.y);
    vec3 color=mix(base,cloudColor,clamp(cloud,0.,1.));
    float sunGlow=pow(max(0.,dot(d,normalize(vec3(-.45,.8,-.4)))),24.);
    color+=vec3(.12,.105,.075)*sunGlow*(1.-uWet)*(.6+.4*(1.-cloud));
    gl_FragColor=vec4(color,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export function createWeather({ scene, camera, renderer, sun, hemi, sky, modelGroup }) {
  let state = normalizeWeather(), quality = 'high', span = 1400, disposed = false;
  let motion = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let elapsed = 0, radius = 70, halfHeight = 75;
  const originalSkyMaterial = sky.material;
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: { top: { value: new THREE.Color('#5f97b7') }, horizon: { value: new THREE.Color('#ccdce0') },
      uTime: { value: 0 }, uCover: { value: .28 }, uWet: { value: 0 }, uWind: { value: 2.5 } },
    vertexShader: originalSkyMaterial.vertexShader, fragmentShader: cloudFragment,
    side: THREE.BackSide, depthWrite: false,
  });
  sky.material = skyMaterial;
  const initial = { exposure: renderer.toneMappingExposure, sunIntensity: sun.intensity,
    sunColor: sun.color.clone(), hemiIntensity: hemi?.intensity ?? 1.05,
    hemiColor: hemi?.color.clone(), hemiGround: hemi?.groundColor.clone(), environment: scene.environmentIntensity ?? 1 };
  const rainCount = 3000, drops = [], positions = new Float32Array(rainCount * 6), opacity = new Float32Array(rainCount * 2);
  const lastCamera = camera.position.clone();
  for (let i = 0; i < rainCount; i++) {
    const terminal = 4.1 + noise(i + 4400) * 4.7;
    drops.push({ x: (noise(i * 7) - .5) * radius * 2, y: (noise(i * 7 + 1) - .5) * halfHeight * 2,
      z: (noise(i * 7 + 2) - .5) * radius * 2, vx: 0, vz: 0, vy: terminal, terminal,
      shutter: .13 + noise(i + 6100) * .11 });
    opacity[i * 2] = .6 + noise(i + 7500) * .4; opacity[i * 2 + 1] = .04;
  }
  const rainGeometry = new THREE.BufferGeometry();
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  rainGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1));
  rainGeometry.setDrawRange(0, 0);
  const rainMaterial = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: .24 }, uRadius: { value: radius }, uCenter: { value: camera.position.clone() } },
    vertexShader: `attribute float aOpacity; uniform vec3 uCenter; uniform float uRadius; varying float vAlpha;
      void main(){vec3 rel=position-uCenter; float distanceToCamera=length(rel);
      vAlpha=aOpacity*(1.-smoothstep(uRadius*.65,uRadius,length(rel.xz)))*smoothstep(1.5,5.,distanceToCamera);
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float uOpacity;varying float vAlpha;void main(){gl_FragColor=vec4(.76,.85,.9,vAlpha*uOpacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
  });
  const rain = new THREE.LineSegments(rainGeometry, rainMaterial);
  rain.name = 'TWIN_Weather_Rain'; rain.frustumCulled = false; rain.renderOrder = 6; rain.visible = false; scene.add(rain);
  const surfaces = new Map();
  function collectSurfaces() {
    modelGroup?.traverse((object) => {
      for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
        if (!material.isMeshStandardMaterial || surfaces.has(material)) continue;
        surfaces.set(material, { roughness: material.roughness, color: material.color.clone(), envMapIntensity: material.envMapIntensity });
      }
    });
  }
  function applyEnvironment() {
    const wet = state.wetness;
    skyMaterial.uniforms.uCover.value = state.cloudCover;
    skyMaterial.uniforms.uWet.value = wet;
    skyMaterial.uniforms.uWind.value = state.windMs;
    skyMaterial.uniforms.top.value.set('#5f97b7').lerp(new THREE.Color('#566570'), wet);
    skyMaterial.uniforms.horizon.value.set('#ccdce0').lerp(new THREE.Color('#88979f'), wet);
    scene.background?.set?.(wet > .1 ? '#85969f' : '#ccdde3');
    if (scene.fog) {
      scene.fog.color.set('#bbd0d9').lerp(new THREE.Color('#879aa5'), wet);
      scene.fog.density = (.19 + wet * .88) / Math.max(450, span);
    }
    sun.intensity = initial.sunIntensity * (1 - wet * .77);
    sun.color.copy(initial.sunColor).lerp(new THREE.Color('#cedbe7'), wet);
    sun.shadow.radius = 3 + wet * 3;
    if (hemi) {
      hemi.intensity = initial.hemiIntensity * (1 - wet * .10);
      hemi.color.copy(initial.hemiColor).lerp(new THREE.Color('#bbc9d6'), wet * .62);
      hemi.groundColor.copy(initial.hemiGround).lerp(new THREE.Color('#485955'), wet * .45);
    }
    renderer.toneMappingExposure = initial.exposure * (1 - wet * .09);
    scene.environmentIntensity = initial.environment * (1 - wet * .18);
    for (const [material, base] of surfaces) {
      material.roughness = Math.max(.15, base.roughness * (1 - wet * .30));
      material.color.copy(base.color).multiplyScalar(1 - wet * .10);
      material.envMapIntensity = base.envMapIntensity * (1 + wet * .22);
    }
    const active = state.rainMmH === 0 ? 0 : Math.round((quality === 'high' ? rainCount : 1350) * Math.min(1, Math.sqrt(state.rainMmH / 60)));
    rain.visible = active > 0; rainGeometry.setDrawRange(0, active * 2);
    rainMaterial.uniforms.uOpacity.value = .33 + wet * .17;
    renderer.shadowMap.needsUpdate = true;
  }
  function update(dt = 0, _time = 0) {
    if (disposed) return;
    const step = motion ? clamp(dt, 0, .08) : 0;
    elapsed += step; skyMaterial.uniforms.uTime.value = elapsed;
    if (!rain.visible) { lastCamera.copy(camera.position); return; }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const dx = cx-lastCamera.x, dy = cy-lastCamera.y, dz = cz-lastCamera.z;
    lastCamera.copy(camera.position); rainMaterial.uniforms.uCenter.value.copy(camera.position);
    const total = rainGeometry.drawRange.count / 2;
    for (let i = 0; i < total; i++) {
      const d = drops[i]; d.x-=dx; d.y-=dy; d.z-=dz;
      // g - quadratic drag reaches the diameter-dependent terminal velocity.
      d.vy += 9.81 * (1 - (d.vy*d.vy)/(d.terminal*d.terminal)) * step;
      const drag = 1-Math.exp(-step*1.9);
      d.vx += (state.windMs*.81-d.vx)*drag; d.vz += (state.windMs*.39-d.vz)*drag;
      d.x+=d.vx*step; d.y-=d.vy*step; d.z+=d.vz*step;
      d.x = ((d.x+radius)%(radius*2)+radius*2)%(radius*2)-radius;
      d.z = ((d.z+radius)%(radius*2)+radius*2)%(radius*2)-radius;
      d.y = ((d.y+halfHeight)%(halfHeight*2)+halfHeight*2)%(halfHeight*2)-halfHeight;
      const j = i*6;
      positions[j]=d.x+cx; positions[j+1]=d.y+cy; positions[j+2]=d.z+cz;
      positions[j+3]=positions[j]-d.vx*d.shutter;
      positions[j+4]=positions[j+1]+d.vy*d.shutter;
      positions[j+5]=positions[j+2]-d.vz*d.shutter;
    }
    rainGeometry.attributes.position.needsUpdate = true;
  }
  applyEnvironment();
  return {
    set(value) { state = normalizeWeather(value); collectSurfaces(); applyEnvironment(); update(0); return { ...state }; },
    getState() { return { ...state }; },
    update,
    setMotion(value) { motion = Boolean(value); },
    setQuality(value) { quality = value === 'standard' ? 'standard' : 'high'; applyEnvironment(); },
    setBounds(box) {
      const size = box.getSize(new THREE.Vector3()); span = Math.max(size.x,size.y,size.z,450);
      // Concentrate the same finite particle budget around the observer. Drop
      // velocity still uses metres/seconds; legibility comes from density and
      // camera exposure, not accelerated gravity or oversized water drops.
      radius = clamp(span*.04,55,85); halfHeight = clamp(span*.045,60,95);
      rainMaterial.uniforms.uRadius.value=radius; collectSurfaces(); applyEnvironment();
    },
    dispose() {
      if (disposed) return; disposed = true;
      rain.removeFromParent(); rainGeometry.dispose(); rainMaterial.dispose();
      if (sky.material===skyMaterial) sky.material=originalSkyMaterial;
      skyMaterial.dispose(); surfaces.clear();
    },
  };
}
