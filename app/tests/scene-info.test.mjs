import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneInformation } from '../src/scene-info.mjs';

test('information keeps interval energy distinct from average power', () => {
  const info = sceneInformation({ energyMWh: 24, powerMW: 12 }, { timeStepHours: 2 }, {}, 'powerhouse');
  assert.deepEqual(info.featureMetrics.filter(m => ['MW','MWh'].includes(m.unit)).map(m => [m.value,m.unit]), [[24,'MWh'],[12,'MW']]);
});
test('storage change uses solved interval endpoints in million cubic metres', () => {
  const info = sceneInformation({ startStorageMcm: 50, storageMcm: 49.7 }, { initialStorageMcm: 90 });
  assert.ok(Math.abs(info.common[2].value + 0.3) < 1e-12);
  assert.match(info.explanation, /줄어/);
});
test('missing observation is unavailable while a recorded zero remains zero', () => {
  assert.equal(sceneInformation({}, {}, {}, 'downstream').featureMetrics[1].value, null);
  assert.equal(sceneInformation({ observedReleaseCms: 0 }, {}, {}, 'downstream').featureMetrics[1].value, 0);
});
test('observed input provenance does not turn computed discharge into a measurement', () => {
  const info = sceneInformation({ inflowCms: 35, releaseCms: 30 }, {}, { dataKind: 'observed' });
  assert.equal(info.common[0].source, '입력자료');
  assert.equal(info.common[1].source, '계산값');
});
test('overflow stays a subset of non-generation flow and is disclosed', () => {
  const info = sceneInformation({ spillCms: 20, overflowCms: 5 }, {}, {}, 'spillway');
  assert.equal(info.flow[1].value, 20);
  assert.equal(info.featureMetrics[1].value, 5);
  assert.match(info.explanation, /실제 수문/);
  assert.ok(info.notes.some(n => n.includes('모형 월류')));
});
test('hydraulic approximation is never classified as measured input', () => {
  const info = sceneInformation({}, {}, {}, 'downstream', { downstream: { depthM: 1.2, velocityMs: 2.1 } });
  assert.ok(info.hydraulicMetrics.every(m => m.source === '모형가정'));
  assert.equal(info.hydraulicMetrics[1].value, 2.1);
});
