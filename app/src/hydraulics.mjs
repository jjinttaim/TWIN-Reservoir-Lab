/**
 * Small, uncalibrated hydraulic approximations for the 3D presentation layer.
 * The operating model's water balance remains authoritative. These functions
 * are not a Saint-Venant/CFD solver and do not infer measured dam hydraulics.
 * SI units throughout: m, s, m³/s. Rectangular, steady uniform open channels.
 * USACE: https://www.hec.usace.army.mil/confluence/rasdocs/ras1dtechref/6.5/stable-channel-design-functions/uniform-flow-computations
 * TU Delft: https://coastal.ceg.tudelft.nl/book/2a_pre_knowledge_waves.html
 */
export const GRAVITY = 9.80665;
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const bounded = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function manningDischarge({ widthM, depthM, slope, roughnessN }) {
  if (![widthM, depthM, slope, roughnessN].every(Number.isFinite) || widthM <= 0 || depthM <= 0 || slope <= 0 || roughnessN <= 0) return 0;
  const area = widthM * depthM;
  const radius = area / (widthM + 2 * depthM);
  return area / roughnessN * radius ** (2 / 3) * Math.sqrt(slope);
}

/** Solve Manning's equation; never cap depth or velocity in the physical result. */
export function solveChannel({ dischargeCms = 0, widthM = 30, slope = 0.002, roughnessN = 0.035 } = {}) {
  const q = bounded(finite(dischargeCms, 0), 0, 1e7);
  const width = bounded(finite(widthM, 30), 0.1, 10000);
  const s = bounded(finite(slope, 0.002), 1e-6, 1);
  const n = bounded(finite(roughnessN, 0.035), 0.008, 0.2);
  if (q === 0) return { dischargeCms: 0, depthM: 0, areaM2: 0, velocityMs: 0, hydraulicRadiusM: 0, froude: 0, widthM: width, slope: s, roughnessN: n };
  let low = 0, high = 1;
  while (manningDischarge({ widthM: width, depthM: high, slope: s, roughnessN: n }) < q) high *= 2;
  for (let i = 0; i < 72; i++) {
    const depth = (low + high) / 2;
    if (manningDischarge({ widthM: width, depthM: depth, slope: s, roughnessN: n }) < q) low = depth;
    else high = depth;
  }
  const depthM = (low + high) / 2, areaM2 = width * depthM, velocityMs = q / areaM2;
  return { dischargeCms: q, depthM, areaM2, velocityMs, hydraulicRadiusM: areaM2 / (width + 2 * depthM), froude: velocityMs / Math.sqrt(GRAVITY * depthM), widthM: width, slope: s, roughnessN: n };
}

/** Bed slope is only a fallback for unknown energy slope; no surveyed data implied. */
export function channelAssumptions(descriptor = {}) {
  const points = descriptor.points || [];
  let run = 0;
  for (let i = 1; i < points.length; i++) run += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
  const drop = points.length > 1 ? points[0][1] - points.at(-1)[1] : 0;
  return {
    widthM: descriptor.width || 30,
    slope: finite(descriptor.energySlope, run > 0 && drop > 0 ? drop / run : 0.002),
    roughnessN: finite(descriptor.roughnessN, descriptor.kind === 'spill' ? 0.016 : descriptor.kind === 'turbine' ? 0.028 : 0.035),
  };
}

export function gravityWave(wavelengthM, depthM = 45) {
  const wavelength = bounded(finite(wavelengthM, 10), 0.05, 1e6), depth = bounded(finite(depthM, 45), 0.01, 1e5);
  const k = 2 * Math.PI / wavelength;
  const omega = Math.sqrt(GRAVITY * k * Math.tanh(k * depth));
  return { k, omega, phaseVelocityMs: omega / k };
}

/**
 * Four small-amplitude waves obey linear dispersion. Wind→amplitude is an
 * artistic, explicitly capped response, not a fetch/duration wave forecast.
 */
export function windWaves(windMs = 3, depthM = 45) {
  const wind = bounded(finite(windMs, 3), 0, 40);
  const depth = bounded(finite(depthM, 45), 0.01, 1e5);
  const strength = Math.min(0.5, 0.018 + 0.0025 * wind * wind);
  return [
    [18, 0.36, 1], [8.5, 0.9, 0.43], [3.7, -0.31, 0.16], [1.35, 1.23, 0.045],
  ].map(([wavelength, direction, weight]) => {
    const { k, omega } = gravityWave(wavelength, depth);
    return { kx: Math.cos(direction) * k, kz: Math.sin(direction) * k, amplitudeM: Math.min(strength * weight, 0.055 / k, depth * 0.025), omega };
  });
}

/** Ballistic droplet position, with downward gravitational acceleration. */
export function ballisticDrop(origin, velocity, ageS) {
  const t = Math.max(0, finite(ageS, 0));
  return [origin[0] + velocity[0] * t, origin[1] + velocity[1] * t - 0.5 * GRAVITY * t * t, origin[2] + velocity[2] * t];
}
