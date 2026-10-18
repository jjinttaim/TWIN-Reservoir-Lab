import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createForecaster, residualBand } from '../src/ai-forecast.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8'));

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

for (const name of ['ai-lstm-random.json', 'ai-transformer-random.json', 'ai-lstm-quick.json', 'ai-model-real.json']) {
  test(`${name}: JS forward pass matches the PyTorch test vectors`, () => {
    const spec = fixture(name);
    const model = createForecaster(spec);
    const { inputs, logq_t, delta_outputs, outputs } = spec.test_vectors;
    let worstDelta = 0, worstOut = 0;
    for (let n = 0; n < inputs.length; n++) {
      const x = inputs[n].map(row => Float64Array.from(row));
      const delta = model.forward(x);
      worstDelta = Math.max(worstDelta, maxAbsDiff(delta, delta_outputs[n]));
      const predicted = delta.map(d => Math.max(0, Math.expm1(logq_t[n] + d)));
      for (let k = 0; k < predicted.length; k++) {
        const tolerance = Math.max(0.02, 2e-4 * Math.abs(outputs[n][k]));
        worstOut = Math.max(worstOut, Math.abs(predicted[k] - outputs[n][k]) / tolerance);
      }
    }
    assert.ok(worstDelta < 3e-4, `delta mismatch ${worstDelta}`);
    assert.ok(worstOut <= 1, `raw output mismatch beyond tolerance (ratio ${worstOut.toFixed(2)})`);
  });
}

test('window inputs reproduce the Python normalisation and hour encoding', () => {
  const spec = fixture('ai-lstm-random.json');
  const model = createForecaster(spec);
  const q = Array.from({ length: 48 }, (_, i) => 10 + i);
  const hours = Array.from({ length: 48 }, (_, i) => i % 24);
  const x = model.inputsFor(q, hours);
  assert.equal(x.length, 48);
  assert.ok(Math.abs(x[5][0] - (Math.log1p(15) - 2.5) / 1.8) < 1e-12);
  assert.ok(Math.abs(x[6][1] - Math.sin(2 * Math.PI * 6 / 24)) < 1e-12);
  assert.ok(Math.abs(x[6][2] - Math.cos(2 * Math.PI * 6 / 24)) < 1e-12);
  const out = model.predictWindow(q, hours);
  assert.equal(out.length, 24);
  assert.ok(out.every(v => Number.isFinite(v) && v >= 0), 'predictions are finite and non-negative');
});

test('forecastSeries respects the hourly requirement, the 48-row window and the hour-ending label', () => {
  const spec = fixture('ai-lstm-random.json');
  const model = createForecaster(spec);
  const rows = Array.from({ length: 60 }, (_, i) => ({ timestamp: new Date(Date.UTC(2024, 6, 1, i)).toISOString(), inflowCms: 50 + 5 * Math.sin(i / 3) }));
  const hourly = model.forecastSeries(rows, { stepHours: 1, timeZoneOffsetHours: 9 });
  assert.equal(hourly.reason, null);
  assert.equal(hourly.issued, 60 - 47);
  assert.equal(hourly.forecasts[46], null);
  assert.equal(hourly.forecasts[47].length, 24);
  // the same window predicted directly must agree with forecastSeries (labels: UTC 00 -> KST 09 start -> label 10)
  const labels = rows.slice(0, 48).map((r, i) => ((9 + i) % 24 + 1) % 24);
  const direct = model.predictWindow(rows.slice(0, 48).map(r => r.inflowCms), labels);
  assert.ok(maxAbsDiff(direct, hourly.forecasts[47]) < 1e-9);
  const daily = model.forecastSeries(rows, { stepHours: 24 });
  assert.ok(daily.reason && daily.issued === 0, 'non-hourly data gets no forecasts');
  const short = model.forecastSeries(rows.slice(0, 10), { stepHours: 1 });
  assert.ok(short.reason && short.issued === 0);
});

test('residual band reads the exported quantiles', () => {
  const spec = fixture('ai-lstm-quick.json');
  const model = createForecaster(spec);
  const band = residualBand(model, 3);
  assert.ok(band && band.low <= band.median && band.median <= band.high);
  assert.equal(residualBand(model, 99), null);
});

test('unsupported feature sets are rejected instead of silently mis-normalised', () => {
  const spec = fixture('ai-lstm-random.json');
  assert.throws(() => createForecaster({ ...spec, features: ['logq_z', 'hour_sin', 'hour_cos', 'level_z'] }), /기본 채널/);
  assert.throws(() => createForecaster({ ...spec, architecture: 'gru' }), /지원하지 않는 구조/);
});

test('the shipped assets/ai/model.json is the verified real model without its test vectors', () => {
  const shipped = JSON.parse(readFileSync(new URL('../assets/ai/model.json', import.meta.url), 'utf-8'));
  const { test_vectors, ...real } = fixture('ai-model-real.json');
  assert.ok(test_vectors && test_vectors.inputs.length >= 32, 'fixture carries PyTorch test vectors');
  assert.deepEqual(shipped, real);
  const model = createForecaster(shipped);
  assert.equal(model.window, 48);
  assert.equal(model.horizons.length, 24);
  assert.ok(model.training && /2024-07-01/.test(model.training.refit_time), 'July 1 refit model');
});

test('the shipped evaluation.json carries the six methods for the main horizon', () => {
  const evaluation = JSON.parse(readFileSync(new URL('../assets/ai/evaluation.json', import.meta.url), 'utf-8'));
  assert.deepEqual(evaluation.methods, ['persistence', 'mean6', 'ridge', 'hgb', 'lstm', 'transformer']);
  const h3 = evaluation.by_horizon.h3;
  for (const m of evaluation.methods) assert.ok(Number.isFinite(h3[m]), `${m} MAE at h=3`);
  assert.ok(h3.n > 2000, 'July to September sample count');
  assert.ok(['lstm', 'transformer'].includes(evaluation.winner));
  assert.ok(Array.isArray(evaluation.bootstrap) && evaluation.bootstrap.length >= 3);
});
