import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAVITY, manningDischarge, solveChannel, channelAssumptions, gravityWave, windWaves, ballisticDrop } from '../src/hydraulics.mjs';
const close = (a,b,rtol=1e-9) => assert.ok(Math.abs(a-b) <= rtol*Math.max(1,Math.abs(a),Math.abs(b)), `${a} != ${b}`);

test('Manning inversion conserves discharge Q=A v over flow regimes', () => {
  for (const q of [0.0001,0.01,1,80,300,5000]) for (const slope of [0.0002,0.008,0.32]) {
    const r=solveChannel({dischargeCms:q,widthM:61,slope,roughnessN:0.016});
    close(r.areaM2*r.velocityMs,q); close(manningDischarge(r),q);
    assert.ok(Object.values(r).every(Number.isFinite));
  }
});
test('zero or negative flow has exactly zero depth and velocity', () => {
  for(const q of [0,-12,NaN,Infinity]) {
    const r=solveChannel({dischargeCms:q});
    assert.equal(r.depthM,0);assert.equal(r.velocityMs,0);assert.equal(r.areaM2,0);
  }
});
test('greater flow raises normal depth; greater slope reduces depth and increases velocity', () => {
  const a=solveChannel({dischargeCms:100,slope:0.001});
  const b=solveChannel({dischargeCms:300,slope:0.001});
  const c=solveChannel({dischargeCms:100,slope:0.01});
  assert.ok(b.depthM>a.depthM);assert.ok(c.depthM<a.depthM);assert.ok(c.velocityMs>a.velocityMs);
});
test('greater roughness increases depth and reduces velocity', () => {
  const a=solveChannel({dischargeCms:100,roughnessN:0.016});
  const b=solveChannel({dischargeCms:100,roughnessN:0.045});
  assert.ok(b.depthM>a.depthM);assert.ok(b.velocityMs<a.velocityMs);
});
test('invalid assumptions are normalized to finite positive values', () => {
  for(const r of [solveChannel({dischargeCms:25,widthM:NaN,slope:Infinity,roughnessN:-5}),solveChannel({dischargeCms:1e9,widthM:0,slope:0,roughnessN:0})]) assert.ok(Object.values(r).every(Number.isFinite));
  assert.equal(channelAssumptions({points:[[0,4,0],[0,2,100]],energySlope:0.007}).slope,0.007);
  close(channelAssumptions({points:[[0,4,0],[0,2,100]]}).slope,0.02);
});
test('wave dispersion agrees with shallow and deep limits', () => {
  const deep=gravityWave(3,100);close(deep.omega**2,GRAVITY*deep.k);
  const shallow=gravityWave(1000,0.1);close(shallow.phaseVelocityMs,Math.sqrt(GRAVITY*0.1),1e-6);
});
test('wind waves remain small amplitude and obey gravity dispersion', () => {
  for(const wind of [0,3,15,100,NaN]) for(const depth of [0.1,45]) {
    for(const w of windWaves(wind,depth)) {
      const k=Math.hypot(w.kx,w.kz); close(w.omega**2,GRAVITY*k*Math.tanh(k*depth));
      assert.ok(k*w.amplitudeM<=0.055+1e-12);assert.ok(w.amplitudeM>=0);
    }
  }
});
test('spray is ballistic with gravity rather than an oscillating path', () => {
  const p0=ballisticDrop([1,2,3],[2,6,4],0),p1=ballisticDrop([1,2,3],[2,6,4],1),p2=ballisticDrop([1,2,3],[2,6,4],2);
  assert.deepEqual(p0,[1,2,3]);close(p1[0],3);close(p1[2],7);close(p2[1]-2*p1[1]+p0[1],-GRAVITY);
});

test('invalid wave depth inputs remain finite', () => {
  for(const depth of [NaN,Infinity,-1,0]) for(const w of windWaves(15,depth)) assert.ok(Object.values(w).every(Number.isFinite));
});
