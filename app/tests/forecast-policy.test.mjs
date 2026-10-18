import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, DEFAULT_CONFIG, validateConfig } from '../src/model.mjs';

const rows = Array.from({ length: 72 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2024, 6, 1, i)).toISOString(),
  inflowCms: 40 + 30 * Math.max(0, Math.sin(i / 8)) + (i > 40 && i < 50 ? 150 : 0),
}));

test('forecast policy with no issued forecasts reproduces the rule policy exactly', () => {
  const rule = simulate(rows, DEFAULT_CONFIG, 'rule');
  const forecast = simulate(rows, DEFAULT_CONFIG, 'forecast', { forecast: rows.map(() => null) });
  for (let i = 0; i < rows.length; i++) {
    assert.ok(Math.abs(rule.series[i].releaseCms - forecast.series[i].releaseCms) < 1e-12);
    assert.equal(forecast.series[i].forecastUsed, false);
  }
  assert.equal(forecast.metrics.forecastUsedIntervals, 0);
  assert.ok(forecast.warnings.some(w => w.includes('예측이 없어')));
});

test('a perfect one-hour forecast moves the rule from the previous to the current interval inflow', () => {
  const perfect = rows.map((_, j) => (j + 1 < rows.length ? [rows[j + 1].inflowCms] : null));
  const result = simulate(rows, { ...DEFAULT_CONFIG, forecastHorizonHours: 1 }, 'forecast', { forecast: perfect });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(Math.abs(result.series[i].inflowEstimateCms - rows[i].inflowCms) < 1e-12, `row ${i} uses the forecast inflow`);
    assert.equal(result.series[i].forecastUsed, true);
  }
  assert.equal(result.metrics.forecastUsedIntervals, rows.length - 1);
  assert.ok(result.metrics.maxMassBalanceErrorMcm < 1e-9);
});

test('the horizon average is used and the horizon is validated', () => {
  const table = rows.map(() => Float64Array.from([10, 20, 30, 40, 50, 60]));
  const result = simulate(rows, { ...DEFAULT_CONFIG, forecastHorizonHours: 3 }, 'forecast', { forecast: table });
  assert.ok(Math.abs(result.series[5].inflowEstimateCms - 20) < 1e-12);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, forecastHorizonHours: 0 }).length > 0);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, forecastHorizonHours: 25 }).length > 0);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, forecastHorizonHours: 2.5 }).length > 0);
  assert.throws(() => simulate(rows, DEFAULT_CONFIG, 'forecast'), /예측 표/);
});

test('an anticipated flood raises the release before the previous-inflow rule does', () => {
  const horizon = 6;
  const table = rows.map((_, j) => Float64Array.from(Array.from({ length: horizon }, (_, k) => rows[Math.min(rows.length - 1, j + 1 + k)].inflowCms)));
  const rule = simulate(rows, DEFAULT_CONFIG, 'rule');
  const ahead = simulate(rows, { ...DEFAULT_CONFIG, forecastHorizonHours: horizon }, 'forecast', { forecast: table });
  // flood starts at row 41; the forecast policy must request more release in the hours before it
  const before = [36, 37, 38, 39, 40];
  assert.ok(before.every(i => ahead.series[i].requestedReleaseCms > rule.series[i].requestedReleaseCms + 1));
});
