/**
 * TWIN AI v2: in-browser inflow forecaster.
 * Reproduces the PyTorch LSTM and Transformer models exported by ai/code/06_deep_models.py
 * (weights, normalization statistics and test vectors travel in one JSON file).
 * Pure JavaScript; agreement with PyTorch is checked by tests/ai-forecast.test.mjs.
 *
 * Conventions shared with the Python side
 * - window: the last 48 hourly inflow rows up to and including the issue row
 * - channels: logq_z = (log1p(q) - logq_mean) / logq_std, hour_sin, hour_cos of the issue-row hour label
 * - output: d_h = clamp(model, -4, 4); q_hat_h = max(0, expm1(log1p(q_t) + d_h)) for h = 1..24
 * The hour label follows the K-water hour-ending convention (interval start + 1 h for hourly rows).
 */

const LN_EPS = 1e-5;

function erf(x) {
  // Abramowitz and Stegun 7.1.26 (abs error < 1.5e-7)
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}
const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function matrix(rows) {
  // rows: number[][] -> { data: Float64Array, rows, cols }
  const r = rows.length, c = rows[0].length;
  const data = new Float64Array(r * c);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) data[i * c + j] = rows[i][j];
  return { data, rows: r, cols: c };
}
const vector = (values) => Float64Array.from(values);

/** y = W x + b with W (out x in) in PyTorch layout. */
function linear(W, b, x, out) {
  const y = out || new Float64Array(W.rows);
  for (let i = 0; i < W.rows; i++) {
    let s = b ? b[i] : 0;
    const base = i * W.cols;
    for (let j = 0; j < W.cols; j++) s += W.data[base + j] * x[j];
    y[i] = s;
  }
  return y;
}

function layerNorm(x, weight, bias) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (x[i] - mean) ** 2;
  variance /= n;
  const inv = 1 / Math.sqrt(variance + LN_EPS);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = (x[i] - mean) * inv * weight[i] + bias[i];
  return y;
}

function lstmForward(weights, layers, hidden, x) {
  // x: array of T Float64Array(C). Returns the last hidden state of the top layer.
  let inputs = x;
  for (let l = 0; l < layers; l++) {
    const Wih = weights[`lstm.weight_ih_l${l}`], Whh = weights[`lstm.weight_hh_l${l}`];
    const bih = weights[`lstm.bias_ih_l${l}`], bhh = weights[`lstm.bias_hh_l${l}`];
    let h = new Float64Array(hidden), c = new Float64Array(hidden);
    const outputs = [];
    const gi = new Float64Array(4 * hidden), gh = new Float64Array(4 * hidden);
    for (let t = 0; t < inputs.length; t++) {
      linear(Wih, bih, inputs[t], gi);
      linear(Whh, bhh, h, gh);
      const hn = new Float64Array(hidden), cn = new Float64Array(hidden);
      for (let k = 0; k < hidden; k++) {
        const ig = sigmoid(gi[k] + gh[k]);
        const fg = sigmoid(gi[hidden + k] + gh[hidden + k]);
        const gg = Math.tanh(gi[2 * hidden + k] + gh[2 * hidden + k]);
        const og = sigmoid(gi[3 * hidden + k] + gh[3 * hidden + k]);
        cn[k] = fg * c[k] + ig * gg;
        hn[k] = og * Math.tanh(cn[k]);
      }
      h = hn; c = cn;
      outputs.push(h);
    }
    inputs = outputs;
  }
  return inputs[inputs.length - 1];
}

function transformerForward(weights, config, x) {
  const d = config.d_model, heads = config.heads, dh = d / heads, T = x.length;
  const proj = weights['proj.weight'], projB = weights['proj.bias'], pos = weights.pos;
  let h = x.map((row, t) => {
    const y = linear(proj, projB, row);
    for (let k = 0; k < d; k++) y[k] += pos.data[t * d + k];
    return y;
  });
  for (let l = 0; l < config.layers; l++) {
    const p = (name) => weights[`encoder.layers.${l}.${name}`];
    const Win = p('self_attn.in_proj_weight'), bin = p('self_attn.in_proj_bias');
    const Wout = p('self_attn.out_proj.weight'), bout = p('self_attn.out_proj.bias');
    // attention block (pre-norm)
    const normed = h.map(row => layerNorm(row, p('norm1.weight'), p('norm1.bias')));
    const qkv = normed.map(row => linear(Win, bin, row));
    const scale = 1 / Math.sqrt(dh);
    const attended = [];
    for (let t = 0; t < T; t++) {
      const out = new Float64Array(d);
      for (let hd = 0; hd < heads; hd++) {
        const off = hd * dh;
        const scores = new Float64Array(T);
        let max = -Infinity;
        for (let s = 0; s < T; s++) {
          let dot = 0;
          for (let k = 0; k < dh; k++) dot += qkv[t][off + k] * qkv[s][d + off + k];
          scores[s] = dot * scale;
          if (scores[s] > max) max = scores[s];
        }
        let sum = 0;
        for (let s = 0; s < T; s++) { scores[s] = Math.exp(scores[s] - max); sum += scores[s]; }
        for (let s = 0; s < T; s++) {
          const w = scores[s] / sum;
          for (let k = 0; k < dh; k++) out[off + k] += w * qkv[s][2 * d + off + k];
        }
      }
      attended.push(linear(Wout, bout, out));
    }
    h = h.map((row, t) => { const y = new Float64Array(d); for (let k = 0; k < d; k++) y[k] = row[k] + attended[t][k]; return y; });
    // feed-forward block (pre-norm)
    const W1 = p('linear1.weight'), b1 = p('linear1.bias'), W2 = p('linear2.weight'), b2 = p('linear2.bias');
    h = h.map(row => {
      const n = layerNorm(row, p('norm2.weight'), p('norm2.bias'));
      const inner = linear(W1, b1, n);
      for (let k = 0; k < inner.length; k++) inner[k] = gelu(inner[k]);
      const ff = linear(W2, b2, inner);
      const y = new Float64Array(d);
      for (let k = 0; k < d; k++) y[k] = row[k] + ff[k];
      return y;
    });
  }
  return layerNorm(h[T - 1], weights['norm.weight'], weights['norm.bias']);
}

function headForward(weights, z) {
  const a = linear(weights['head.0.weight'], weights['head.0.bias'], z);
  for (let k = 0; k < a.length; k++) a[k] = gelu(a[k]);
  return linear(weights['head.2.weight'], weights['head.2.bias'], a);
}

/** Parse the exported JSON into typed arrays; validates the parts the browser needs. */
export function createForecaster(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('모형 명세가 없습니다.');
  const architecture = spec.architecture;
  if (!['lstm', 'transformer'].includes(architecture)) throw new Error(`지원하지 않는 구조: ${architecture}`);
  const features = Array.isArray(spec.features) ? spec.features : [];
  const supported = ['logq_z', 'hour_sin', 'hour_cos'];
  if (features.length !== supported.length || features.some((f, i) => f !== supported[i])) {
    throw new Error('브라우저 추론은 기본 채널(logq_z, hour_sin, hour_cos) 모형만 지원합니다.');
  }
  const stats = spec.stats || {};
  for (const key of ['logq_mean', 'logq_std']) if (!Number.isFinite(stats[key])) throw new Error(`정규화 통계 ${key}가 없습니다.`);
  const weights = {};
  for (const [name, value] of Object.entries(spec.weights || {})) {
    weights[name] = Array.isArray(value[0]) ? matrix(value) : vector(value);
  }
  if (architecture === 'transformer') weights.pos = matrix(spec.weights.pos);
  const window = Number.isInteger(spec.window_hours) ? spec.window_hours : 48;
  const horizons = Array.isArray(spec.horizons) ? spec.horizons.slice() : Array.from({ length: 24 }, (_, i) => i + 1);
  const config = spec.config || {};
  const quantiles = spec.residual_quantiles_june_validation || null;

  function forward(x) {
    const z = architecture === 'lstm' ? lstmForward(weights, config.layers, config.hidden, x) : transformerForward(weights, config, x);
    const raw = headForward(weights, z);
    const delta = new Float64Array(raw.length);
    for (let k = 0; k < raw.length; k++) delta[k] = Math.max(-4, Math.min(4, raw[k]));
    return delta;
  }

  /** Build the model input for a window of raw inflows and the hour labels (0..23) of each row. */
  function inputsFor(qWindow, hourLabels) {
    if (qWindow.length !== window || hourLabels.length !== window) throw new Error(`입력 창은 ${window}행이어야 합니다.`);
    const x = [];
    for (let t = 0; t < window; t++) {
      const q = qWindow[t];
      if (!Number.isFinite(q) || q < 0) throw new Error('유입량은 0 이상의 유한한 값이어야 합니다.');
      const angle = 2 * Math.PI * hourLabels[t] / 24;
      x.push(Float64Array.from([(Math.log1p(q) - stats.logq_mean) / stats.logq_std, Math.sin(angle), Math.cos(angle)]));
    }
    return x;
  }

  function predictWindow(qWindow, hourLabels) {
    const delta = forward(inputsFor(qWindow, hourLabels));
    const base = Math.log1p(qWindow[window - 1]);
    const out = new Float64Array(delta.length);
    for (let k = 0; k < delta.length; k++) out[k] = Math.max(0, Math.expm1(base + delta[k]));
    return out;
  }

  /**
   * Forecasts for every row of an hourly series. rows[i].inflowCms is the interval-average inflow,
   * rows[i].timestamp an ISO string (interval start). Returns null for rows without a full window.
   */
  function forecastSeries(rows, { stepHours = 1, timeZoneOffsetHours = 9 } = {}) {
    const result = { forecasts: new Array(rows.length).fill(null), issued: 0, reason: null };
    if (Math.abs(stepHours - 1) > 1e-9) {
      result.reason = '예측 모형은 1시간 간격 자료로 학습했습니다. 현재 자료의 간격이 1시간이 아니므로 예측을 만들지 않습니다.';
      return result;
    }
    if (rows.length < window) {
      result.reason = `예측에는 최소 ${window}개 구간이 필요합니다.`;
      return result;
    }
    const hourLabel = (row) => {
      const ms = Date.parse(row.timestamp);
      const startHour = ((Math.floor(ms / 3600000) + Math.round(timeZoneOffsetHours)) % 24 + 24) % 24;
      return (startHour + 1) % 24; // hour-ending label of the interval
    };
    const labels = rows.map(hourLabel);
    const q = rows.map(r => r.inflowCms);
    for (let i = window - 1; i < rows.length; i++) {
      const qWindow = q.slice(i - window + 1, i + 1);
      if (!qWindow.every(v => Number.isFinite(v) && v >= 0)) continue;
      result.forecasts[i] = predictWindow(qWindow, labels.slice(i - window + 1, i + 1));
      result.issued++;
    }
    return result;
  }

  return {
    architecture, config, window, horizons, stats, features, quantiles,
    version: spec.model_version || null, training: spec.training || null, notes: spec.display_notes || [],
    forward, inputsFor, predictWindow, forecastSeries,
  };
}

/** Residual band for horizon h from the exported empirical quantiles (null when unavailable). */
export function residualBand(forecaster, h) {
  const q = forecaster?.quantiles?.[`h${h}`];
  if (!q) return null;
  return { low: q.p10, median: q.p50, high: q.p90, mae: q.MAE };
}
