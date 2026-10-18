import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, simulate, compareMetrics } from '../src/model.mjs';

const rows = (inflows, extras = {}) => inflows.map((inflowCms, i) => ({
  timestamp: new Date(Date.UTC(2024, 0, 1, i)).toISOString(), inflowCms, ...extras,
}));
const near = (actual, expected, tolerance = 1e-9) => assert.ok(
  Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`,
);
const referenceReservoir = { initialStorageMcm: 50, minStorageMcm: 10,
  maxStorageMcm: 90, targetStorageMcm: 55, floodStorageMcm: 75 };

test('fictional default config is valid; impossible boundaries and nonnumbers are rejected', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  for (const config of [
    { minStorageMcm: 100 }, { initialStorageMcm: -1 }, { efficiency: 1.1 },
    { maxTurbineCms: 400 }, { timeStepHours: 0 }, { fixedReleaseCms: Infinity },
    { targetStorageMcm: 80, floodStorageMcm: 70 }, { maxLevelM: 70 },
  ]) {
    assert.ok(validateConfig(config).length > 0);
    assert.throws(() => simulate(rows([20]), config));
  }
});

test('fixed policy follows analytical water balance and gravitational energy', () => {
  const result = simulate(rows([40, 40, 40]), referenceReservoir, 'fixed');
  for (const row of result.series) {
    near(row.storageMcm, 50);
    near(row.levelM, 100);
    near(row.releaseCms, 40);
    near(row.turbineCms, 40);
    near(row.energyMWh, 1000 * 9.81 * 40 * 35 * 0.9 / 1e6);
    near(row.massBalanceResidualMcm, 0);
  }
  near(result.metrics.totalReleaseMcm, 40 * 3600 * 3 / 1e6);
});

test('extreme flood overflow stays in the mass balance and downstream exceedance', () => {
  const result = simulate(rows([10000]), {
    ...referenceReservoir, initialStorageMcm: 89, fixedReleaseCms: 300,
  }, 'fixed');
  const row = result.series[0];
  near(row.storageMcm, 90);
  near(row.turbineCms, 80);
  near(row.overflowCms, (89 + (10000 - 300) * 0.0036 - 90) / 0.0036);
  near(row.releaseCms, row.turbineCms + row.spillCms);
  assert.ok(row.releaseCms > DEFAULT_CONFIG.maxReleaseCms);
  assert.equal(row.releaseExceeded, true);
  assert.equal(result.metrics.releaseViolationHours, 1);
  near(row.massBalanceResidualMcm, 0);
});

test('drought conserves water, respects minimum storage, and counts unmet required release', () => {
  const result = simulate(rows([0, 0]), {
    initialStorageMcm: 10.01, fixedReleaseCms: 40, minimumReleaseCms: 10,
  }, 'fixed');
  near(result.series[0].storageMcm, 10);
  near(result.series[0].releaseCms, 0.01 / 0.0036);
  near(result.series[1].releaseCms, 0);
  near(result.metrics.shortageMcm, 2 * 10 * 0.0036 - 0.01);
  near(result.metrics.totalReleaseMcm, 0.01);
  assert.ok(result.metrics.maxMassBalanceErrorMcm < 1e-12);
});

test('negative net head cannot generate negative or positive electrical energy', () => {
  const result = simulate(rows([40]), { tailwaterLevelM: 200 }, 'fixed');
  near(result.metrics.totalEnergyMWh, 0);
  near(result.series[0].headM, 0);
});

test('energy scales with duration and efficiency at constant water level', () => {
  const normal = simulate(rows([40]), {}, 'fixed');
  const modified = simulate(rows([40]), { timeStepHours: 0.5, efficiency: 0.45 }, 'fixed');
  near(modified.metrics.totalEnergyMWh, normal.metrics.totalEnergyMWh / 4);
  near(modified.metrics.totalReleaseMcm, normal.metrics.totalReleaseMcm / 2);
  assert.equal(modified.series[0].timestamp, '2024-01-01T00:00:00.000Z');
  assert.equal(modified.series[0].endTimestamp, '2024-01-01T00:30:00.000Z');
  assert.equal(normal.series[0].endTimestamp, '2024-01-01T01:00:00.000Z');
});

test('target tracking is causal and does not use the current or future inflow', () => {
  const a = simulate(rows([20, 30, 40]), {}, 'rule');
  const b = simulate(rows([20, 900, 800]), {}, 'rule');
  near(a.series[0].requestedReleaseCms, b.series[0].requestedReleaseCms);
  near(a.series[1].requestedReleaseCms, b.series[1].requestedReleaseCms);
  assert.notEqual(a.series[2].requestedReleaseCms, b.series[2].requestedReleaseCms);
});

test('daily target tracking approaches storage monotonically even with a six-hour response', () => {
  const dailyRows = Array.from({ length: 5 }, (_, day) => ({
    timestamp: new Date(Date.UTC(2024, 0, 1 + day)).toISOString(), inflowCms: 100,
  }));
  for (const initialStorageMcm of [60, 70]) {
    const result = simulate(dailyRows, {
      initialStorageMcm, targetStorageMcm: 65, timeStepHours: 24,
      responseHours: 6, fixedReleaseCms: 100,
    }, 'rule');
    let previousError = initialStorageMcm - 65;
    for (const row of result.series) {
      const error = row.storageMcm - 65;
      assert.ok(error * previousError >= -1e-12, 'controller must not cross the target');
      assert.ok(Math.abs(error) < Math.abs(previousError), 'storage must approach the target');
      assert.ok(row.requestedReleaseCms > DEFAULT_CONFIG.minimumReleaseCms);
      assert.ok(row.requestedReleaseCms < DEFAULT_CONFIG.maxReleaseCms);
      near(row.controlledReleaseCms, row.requestedReleaseCms);
      near(row.overflowCms, 0);
      near(error, previousError * Math.exp(-4));
      previousError = error;
    }
  }
});

test('recorded policy requires a complete total-release column and valid split', () => {
  assert.throws(() => simulate(rows([40]), {}, 'recorded'), /관측 총방류량/);
  assert.throws(() => simulate(rows([40], { observedReleaseCms: 20, observedTurbineCms: 30 }), {}, 'recorded'), /총방류량보다/);
});

test('recorded split excludes non-generation release from generation', () => {
  const result = simulate(rows([40], { observedReleaseCms: 40, observedTurbineCms: 10 }), referenceReservoir, 'recorded');
  near(result.series[0].turbineCms, 10);
  near(result.series[0].spillCms, 30);
  near(result.series[0].energyMWh, 1000 * 9.81 * 10 * 35 * 0.9 / 1e6);
  assert.ok(!result.warnings.some(value => value.includes('발전 유량이 없는')));
});

test('missing recorded split explicitly warns; observed storage does not silently alter water balance', () => {
  const result = simulate(rows([40], { observedReleaseCms: 40, observedStorageMcm: 80 }), referenceReservoir, 'recorded');
  near(result.series[0].storageMcm, 50);
  near(result.series[0].observedStorageMcm, 80);
  assert.ok(result.warnings.some(value => value.includes('발전 유량이 없는')));
});

test('stage-storage curve is validated and used instead of a linear water level assumption', () => {
  const stageStorageCurve = [
    { storageMcm: 10, levelM: 80 }, { storageMcm: 50, levelM: 95 },
    { storageMcm: 90, levelM: 120 },
  ];
  const result = simulate(rows([40]), { ...referenceReservoir, stageStorageCurve }, 'fixed');
  near(result.series[0].levelM, 95);
  near(result.series[0].headM, 30);
  assert.ok(validateConfig({ stageStorageCurve: stageStorageCurve.slice(1) }).length > 0);
  assert.ok(validateConfig({ stageStorageCurve: stageStorageCurve.toReversed() }).length > 0);
  assert.ok(validateConfig({ stageStorageCurve: [{ storageMcm: 10, levelM: 80 }, { storageMcm: 90, levelM: 80 }] }).length > 0);
});

test('all policies conserve water over a deterministic mix of wet and dry intervals', () => {
  const inflows = Array.from({ length: 240 }, (_, i) => i % 37 < 5 ? 4000 : i % 11 * 7);
  const input = rows(inflows, { observedReleaseCms: 65, observedTurbineCms: 25 });
  for (const policy of ['fixed', 'rule', 'recorded']) {
    const result = simulate(input, {}, policy);
    near(result.metrics.initialStorageMcm + result.metrics.totalInflowMcm
      - result.metrics.totalReleaseMcm, result.metrics.endStorageMcm, 1e-7);
    assert.ok(result.metrics.maxMassBalanceErrorMcm < 1e-10);
    for (const row of result.series) {
      assert.ok(row.storageMcm >= DEFAULT_CONFIG.minStorageMcm);
      assert.ok(row.storageMcm <= DEFAULT_CONFIG.maxStorageMcm);
      assert.ok(row.turbineCms <= DEFAULT_CONFIG.maxTurbineCms);
      near(row.turbineCms + row.spillCms, row.releaseCms);
    }
  }
});

test('comparison returns terminal storage tradeoff and avoids division by zero', () => {
  const base = simulate(rows([0]), { tailwaterLevelM: 200 }, 'fixed');
  const proposed = simulate(rows([0]), { tailwaterLevelM: 200 }, 'rule');
  const compared = compareMetrics(base, proposed);
  assert.equal(compared.energyDeltaPercent, null);
  assert.ok(compared.endStorageDeltaMcm > 0);
});

test('invalid inputs fail clearly instead of contaminating every chart with NaN', () => {
  assert.throws(() => simulate([]));
  assert.throws(() => simulate(rows([-1])));
  assert.throws(() => simulate(rows([NaN])));
  assert.throws(() => simulate(rows([20]), {}, 'invented'));
  assert.throws(() => simulate([{ timestamp: 'invalid', inflowCms: 20 }]));
  assert.throws(() => simulate(rows([20], { observedGenerationMWh: -1 })));
  assert.throws(() => simulate(rows([20]), { timeStepHours: Number.MAX_VALUE }), /시간 간격/);
  assert.throws(() => simulate(rows([0, Number.MAX_VALUE]), { timeStepHours: 1000 }, 'fixed'), /2행의 계산값/);
});
