import { DEFAULT_CONFIG, validateConfig, simulate } from "./model.mjs";
import {
  FIELD_DEFS,
  parseCSV,
  guessMapping,
  normalizeRows,
  createDemoData,
  toCSV,
  createTemplateCSV,
  workbookToGrids,
} from "./data.mjs";
import { createViewer } from "./viewer3d.mjs";
import { WEATHER_PRESETS } from "./weather3d.mjs";
import { SCENE_FEATURES, sceneInformation } from "./scene-info.mjs";
import { createForecaster, residualBand } from "./ai-forecast.mjs";
import uPlot from "uplot";

const VERSION = "1.6.1";
const USER_CONFIG_LABEL = "사용자 입력 제원 (미검증)";
const $ = (id) => document.getElementById(id);
const escape = (x) =>
  String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 1) =>
  Number.isFinite(Number(n)) && n !== null
    ? Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "";
const date = (s, short = false) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    ...(short ? {} : { year: "numeric" }),
  }).format(new Date(s));
const tip = (text, label = "설명 보기") =>
  `<button type="button" class="info" aria-label="${escape(label)}" data-tip="${escape(text)}">i</button>`;
const icon = (name) => `<i class="ico ico-${name}" aria-hidden="true"></i>`;
/** Percentage of the track to fill for a range input (used by the custom slider style). */
const rangeFill = (value, min, max) => (max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0);
function setRangeFill(input) {
  if (!input) return;
  input.style.setProperty("--fill", `${rangeFill(Number(input.value), Number(input.min) || 0, Number(input.max) || 0).toFixed(3)}%`);
}
const rangeMarkup = (id, max, value, label) =>
  `<input class="range" id="${id}" type="range" min="0" max="${max}" value="${value}" step="1" style="--fill:${rangeFill(value, 0, max).toFixed(3)}%" aria-label="${escape(label)}">`;
const demo = createDemoData();
const S = {
  tab: "dashboard",
  rows: demo.rows,
  meta: { ...demo.meta, name: "여름 홍수 7일 가상 시나리오", source: "프로그램에서 생성한 합성 자료", dataKind: "synthetic" },
  config: { ...DEFAULT_CONFIG },
  configSource: "가상 제원",
  basePolicy: "fixed",
  proposalPolicy: "rule",
  index: 0,
  playing: false,
  speed: 2,
  base: null,
  proposal: null,
  dirty: false,
  draft: null,
  quality: null,
  errors: [],
  title: "TWIN 연구용 댐",
  configErrors: [],
  navOpen: { ops: true, data: true, setup: true, help: true },
};
/** AI forecaster state. Forecasts are aligned with S.rows (null until a 48-row window exists). */
const AI = {
  status: "idle", // idle | loading | ready | error
  error: null,
  model: null,
  evaluation: null,
  forecasts: null,
  issued: 0,
  reason: null,
  computing: false,
  progress: 0,
  version: 0,
  chartHorizon: 3,
  index: null,
};
function aiIndex() {
  if (!AI.forecasts) return S.index;
  if (AI.index === null || !forecastAt(AI.index)) {
    const first = AI.forecasts.findIndex((f) => f);
    AI.index = forecastAt(S.index) ? S.index : Math.max(0, first);
  }
  return AI.index;
}
let timer = null, toastTimer;
const charts = {};
const POLICY_LABELS = {
  fixed: "일정한 양 방류",
  rule: "목표 저수량 유지 규칙",
  forecast: "AI 예측 참고 규칙",
  recorded: "관측 방류 재현 (물수지 제약 적용)",
};

function toast(t) {
  $("toast").textContent = t;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}
function download(name, text, type = "text/plain;charset=utf-8") {
  const a = document.createElement("a");
  const u = URL.createObjectURL(new Blob([text], { type }));
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
function stop() {
  S.playing = false;
  clearInterval(timer);
  timer = null;
}
function simulationOptions() {
  return { forecast: AI.forecasts };
}
function run() {
  stop();
  try {
    if (S.proposalPolicy === "forecast" && !AI.forecasts) throw new Error("AI 예측이 아직 없습니다. AI 예측 화면에서 예측을 생성한 뒤 다시 계산하세요.");
    S.base = simulate(S.rows, S.config, S.basePolicy, simulationOptions());
    S.proposal = simulate(S.rows, S.config, S.proposalPolicy, simulationOptions());
    S.errors = [];
    S.index = Math.min(S.index, S.rows.length - 1);
    S.dirty = false;
  } catch (e) {
    S.errors = [e.message];
    S.base = null;
    S.proposal = null;
  }
}

// ----------------------------------------------------------------------------- AI forecaster
const timeZoneOffsetHours = () => {
  const zone = S.meta?.timeZone || "+09:00";
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 9;
};
async function loadForecaster() {
  if (AI.status === "loading" || AI.status === "ready") return;
  AI.status = "loading";
  try {
    const base = new URL("assets/ai/", document.baseURI);
    const [modelResponse, evalResponse] = await Promise.all([
      fetch(new URL("model.json", base), { cache: "no-cache" }),
      fetch(new URL("evaluation.json", base), { cache: "no-cache" }).catch(() => null),
    ]);
    if (!modelResponse.ok) throw new Error("모형 파일(assets/ai/model.json)을 읽지 못했습니다.");
    AI.model = createForecaster(await modelResponse.json());
    AI.evaluation = evalResponse && evalResponse.ok ? await evalResponse.json() : null;
    AI.status = "ready";
    AI.error = null;
  } catch (error) {
    AI.status = "error";
    AI.error = error.message;
  }
  renderStatusbar();
  if (S.tab === "ai") render();
}
function invalidateForecasts() {
  AI.forecasts = null;
  AI.index = null;
  AI.issued = 0;
  AI.reason = null;
  AI.version += 1;
}
/** Compute forecasts for the loaded rows in chunks so the interface stays responsive. */
async function computeForecasts() {
  if (AI.status !== "ready" || AI.computing) return false;
  const version = AI.version, rows = S.rows, model = AI.model;
  const step = S.config.timeStepHours, offset = timeZoneOffsetHours();
  AI.computing = true;
  AI.progress = 0;
  renderStatusbar();
  const preview = model.forecastSeries(rows.slice(0, Math.min(rows.length, model.window)), { stepHours: step, timeZoneOffsetHours: offset });
  if (preview.reason && rows.length < model.window) {
    AI.computing = false;
    AI.reason = preview.reason;
    AI.forecasts = null;
    renderStatusbar();
    return false;
  }
  if (Math.abs(step - 1) > 1e-9) {
    AI.computing = false;
    AI.reason = "예측 모형은 1시간 간격 자료로 학습했습니다. 현재 자료의 간격이 1시간이 아니므로 예측을 만들지 않습니다.";
    AI.forecasts = null;
    renderStatusbar();
    return false;
  }
  const forecasts = new Array(rows.length).fill(null);
  const labels = rows.map((row) => {
    const start = ((Math.floor(Date.parse(row.timestamp) / 3600000) + Math.round(offset)) % 24 + 24) % 24;
    return (start + 1) % 24;
  });
  const q = rows.map((r) => r.inflowCms);
  let issued = 0;
  const chunk = model.architecture === "transformer" ? 40 : 160;
  for (let i = model.window - 1; i < rows.length; i += chunk) {
    const end = Math.min(rows.length, i + chunk);
    for (let j = i; j < end; j++) {
      const window = q.slice(j - model.window + 1, j + 1);
      if (!window.every((v) => Number.isFinite(v) && v >= 0)) continue;
      forecasts[j] = model.predictWindow(window, labels.slice(j - model.window + 1, j + 1));
      issued++;
    }
    AI.progress = end / rows.length;
    renderStatusbar();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (version !== AI.version) { AI.computing = false; renderStatusbar(); return false; }
  }
  AI.forecasts = forecasts;
  AI.issued = issued;
  AI.reason = null;
  AI.computing = false;
  AI.progress = 1;
  renderStatusbar();
  return true;
}
function forecastAt(index) {
  return AI.forecasts?.[index] || null;
}
/** Expected inflow for the next h hours from the forecast issued at the end of the previous interval. */
function expectedInflow(index, h) {
  const issued = forecastAt(index - 1);
  if (!issued) return null;
  const n = Math.min(h, issued.length);
  let s = 0;
  for (let k = 0; k < n; k++) s += issued[k];
  return s / n;
}
/** Level trajectory implied by the forecast issued at the current index, under the target-storage rule. */
function projectionMap(index) {
  const projection = projectedLevels(index);
  if (!projection) return null;
  const current = S.proposal.series[index];
  const map = new Map([[Date.parse(current.endTimestamp) / 1000, current.levelM]]);
  for (const p of projection) map.set(Date.parse(p.timestamp) / 1000, p.levelM);
  return map;
}
function projectedLevels(index) {
  const issued = forecastAt(index);
  if (!issued || !S.proposal) return null;
  const current = S.proposal.series[index];
  const stepMs = S.config.timeStepHours * 3600000;
  const rows = Array.from(issued, (inflow, k) => ({ timestamp: new Date(Date.parse(current.endTimestamp) + k * stepMs).toISOString(), inflowCms: Math.max(0, inflow) }));
  try {
    const projected = simulate(rows, { ...S.config, initialStorageMcm: current.storageMcm }, "rule");
    return projected.series.map((row, k) => ({ h: k + 1, timestamp: row.endTimestamp, levelM: row.levelM, storageMcm: row.storageMcm, releaseCms: row.releaseCms, inflowCms: issued[k] }));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------- layout
const NAV = [
  { id: "ops", label: "운영", items: [["dashboard", "운영 실험실"], ["ai", "AI 예측"]] },
  { id: "data", label: "자료", items: [["data", "데이터 연결"]] },
  { id: "setup", label: "설정", items: [["settings", "댐 운영 설정"]] },
  { id: "help", label: "도움말", items: [["guide", "사용 안내"]] },
];
const PAGE_TITLES = { dashboard: "운영 실험실", ai: "AI 예측", data: "데이터 연결", settings: "댐 운영 설정", guide: "사용 안내" };
function navMarkup() {
  return NAV.map((group) => `<div class="lnb-group ${S.navOpen[group.id] ? "open" : ""}"><button type="button" class="lnb-folder" data-folder="${group.id}" aria-expanded="${S.navOpen[group.id]}">${icon("folder")}<span>${group.label}</span>${icon("chev")}</button><ul class="lnb-items">${group.items
    .map(([id, label]) => `<li><button type="button" data-tab="${id}" class="${S.tab === id ? "active" : ""}" ${S.tab === id ? 'aria-current="page"' : ""}>${icon("item")}${label}</button></li>`)
    .join("")}</ul></div>`).join("");
}
function statusbarMarkup() {
  const aiText = AI.computing
    ? `AI 예측 계산 ${Math.round(AI.progress * 100)}%`
    : AI.status === "ready"
      ? (AI.forecasts ? `AI 예측 ${AI.issued}개 구간` : "AI 모형 준비")
      : AI.status === "loading" ? "AI 모형 불러오는 중" : "AI 모형 없음";
  return `<span>${escape(S.meta.name)}</span><span>${S.rows.length}개 구간, ${fmt(S.config.timeStepHours, 2)}시간 간격</span><span>${escape(S.configSource)}</span><span>${S.dirty ? "다시 계산 필요" : S.errors.length ? "계산 오류" : "계산 완료"}</span><span>${aiText}</span><span class="statusbar-right">TWIN Reservoir Lab ${VERSION}</span>`;
}
function renderStatusbar() {
  const bar = document.querySelector(".statusbar");
  if (bar) bar.innerHTML = statusbarMarkup();
}
function header() {
  return `<div class="shell"><header class="gnb"><div class="gnb-brand"><img class="gnb-logo" src="assets/brand/twin-logo-compact.png" alt="TWIN, Turbid Water INtelligence" width="91" height="28"><span>Reservoir Lab</span></div><div class="gnb-page"><span class="gnb-title">${PAGE_TITLES[S.tab] || ""}</span></div><div class="gnb-right"><span class="gnb-project">${icon("doc")}${escape(S.title)}</span><button id="loadProject" class="btn">${icon("open")}프로젝트 열기</button><button id="saveProject" class="btn primary">${icon("save")}프로젝트 저장</button></div></header><aside class="lnb"><div class="lnb-head">메뉴</div><nav aria-label="주 메뉴">${navMarkup()}</nav><div class="lnb-foot"><span>로컬 처리</span><span>파일은 외부로 전송되지 않음</span><span>연구용 시제품</span></div></aside><main class="content" id="view"></main><footer class="statusbar">${statusbarMarkup()}</footer></div>`;
}
function pageHead(title, description) {
  return `<div class="page-head"><h1>${title}</h1>${description ? tip(description, title + " 설명") : ""}</div>`;
}
function badge() {
  return S.meta.dataKind === "synthetic"
    ? '<span class="badge amber">가상 데이터</span>'
    : `<span class="badge">${S.meta.dataKind === "observed" ? "관측자료" : "출처 미확인 자료"}</span>`;
}
function statusRow() {
  const text = S.meta.dataKind === "synthetic"
    ? "수치와 시설 제원은 예제입니다. 3D 외형은 소양강댐을 참고했으며 실제 수리 특성이나 운영 성능을 검증한 결과가 아닙니다. AI 예측은 과거 공개자료로 학습한 유입량 예측이며 현장 제어와 연결되어 있지 않습니다."
    : `불러온 자료의 출처와 단위를 확인하세요. 현재 시설 설정은 ${S.configSource}이며, 이 결과는 실제 운영 성능을 입증하지 않습니다. AI 예측은 현장 제어와 연결되어 있지 않습니다.`;
  return `<div class="status-row">${badge()}<span class="badge">${escape(S.configSource)}</span><span class="muted">${S.meta.dataKind === "synthetic" ? "가상 자료로 체험 중" : "자료 연결 후 검증 필요"}</span>${tip(text, "현재 상태 설명")}</div>`;
}
const section = (title, body, extra = "") => `<section class="sec"><div class="sec-head"><h2>${title}</h2>${extra}</div>${body}</section>`;

// ----------------------------------------------------------------------------- charts (uPlot)
const tz = (ts) => uPlot.tzDate(new Date(ts * 1e3), "Asia/Seoul");
const pad2 = (n) => String(n).padStart(2, "0");
function timeAxisValues(u, splits, axisIdx, foundSpace, foundIncr) {
  return splits.map((ts) => {
    const d = tz(ts);
    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    if (foundIncr >= 86400) return dayLabel;
    if (d.getHours() === 0 && d.getMinutes() === 0) return dayLabel;
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  });
}
/** Draws a horizontal reference line (for example zero) across the plot area. */
function referenceLinePlugin(value, color = "#999") {
  return {
    hooks: {
      draw: (u) => {
        const y = u.valToPos(value, "y", true);
        if (!Number.isFinite(y) || y < u.bbox.top || y > u.bbox.top + u.bbox.height) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}
const CHART_COLORS = { base: "#7a8599", proposal: "#1f5fa0", inflow: "#b7791f", forecast: "#c0392b", band: "rgba(192,57,43,.14)", marker: "#333" };
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}
function destroyAllCharts() {
  Object.keys(charts).forEach(destroyChart);
}
/** Draws a vertical marker at the selected interval and a label with the time. */
function markerPlugin(getX) {
  return {
    hooks: {
      draw: (u) => {
        const x = getX();
        if (!Number.isFinite(x)) return;
        const left = u.valToPos(x, "x", true);
        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = CHART_COLORS.marker;
        ctx.lineWidth = 1;
        ctx.moveTo(left, u.bbox.top);
        ctx.lineTo(left, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.restore();
      },
    },
  };
}
function makeChart(key, container, options, data) {
  destroyChart(key);
  if (!container) return null;
  const width = Math.max(320, container.clientWidth - 2);
  const chart = new uPlot({
    width, height: options.height || 230,
    tzDate: tz,
    cursor: { sync: { key: "twin", setSeries: false }, drag: { x: true, y: false }, points: { size: 7 } },
    legend: { live: true },
    padding: [8, 12, 0, 0],
    ...options,
    series: (options.series || []).map((sr, i) => (i === 0 && !sr.value ? { ...sr, value: (u, v) => (v == null ? "" : date(v * 1e3)) } : sr)),
    scales: { x: { time: true }, ...(options.scales || {}) },
    axes: [
      { stroke: "#555", grid: { stroke: "#e4e6ea", width: 1 }, ticks: { stroke: "#c9ccd1" }, font: "11px sans-serif", labelFont: "11px sans-serif", space: 70, values: timeAxisValues },
      { stroke: "#555", grid: { stroke: "#e4e6ea", width: 1 }, ticks: { stroke: "#c9ccd1" }, font: "11px sans-serif", labelFont: "11px sans-serif", size: 56, label: options.yLabel || "", labelGap: 4 },
    ],
    plugins: [markerPlugin(() => (S.proposal ? Date.parse(S.proposal.series[S.index].timestamp) / 1000 : NaN)), ...(options.plugins || [])],
  }, data, container);
  charts[key] = chart;
  return chart;
}
function dashboardChartData() {
  const p = S.proposal, b = S.base;
  const x = p.series.map((r) => Date.parse(r.timestamp) / 1000);
  const xEnd = p.series.map((r) => Date.parse(r.endTimestamp) / 1000);
  const levelX = [Date.parse(p.series[0].timestamp) / 1000, ...xEnd];
  const levelBase = [b.series[0].startLevelM, ...b.series.map((r) => r.levelM)];
  const levelProposal = [p.series[0].startLevelM, ...p.series.map((r) => r.levelM)];
  const forecastInflow = x.map((_, i) => {
    const issued = forecastAt(i - AI.chartHorizon);
    return issued ? issued[AI.chartHorizon - 1] : null;
  });
  return { x, levelX, levelBase, levelProposal, inflow: S.rows.map((r) => r.inflowCms), baseRelease: b.series.map((r) => r.releaseCms), proposalRelease: p.series.map((r) => r.releaseCms), forecastInflow };
}
function buildDashboardCharts() {
  if (!S.proposal || !$("chartLevel")) return;
  const d = dashboardChartData();
  const map = projectionMap(S.index);
  const projY = map ? d.levelX.map((t) => map.get(t) ?? null) : null;
  makeChart("level", $("chartLevel"), {
    yLabel: "수위 (m)",
    series: [
      { label: "시각" },
      { label: "기준 운영안", stroke: CHART_COLORS.base, width: 1.4, dash: [5, 4], value: (u, v) => (v == null ? "" : fmt(v, 2) + " m") },
      { label: "제안 운영안", stroke: CHART_COLORS.proposal, width: 1.8, value: (u, v) => (v == null ? "" : fmt(v, 2) + " m") },
      { label: "AI 예측 궤적 (규칙 운영 가정)", stroke: CHART_COLORS.forecast, width: 1.4, dash: [2, 3], spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 2) + " m") },
    ],
  }, [d.levelX, d.levelBase, d.levelProposal, projY || d.levelX.map(() => null)]);
  makeChart("flow", $("chartFlow"), {
    yLabel: "유량 (m³/s)",
    series: [
      { label: "시각" },
      { label: "유입 (입력자료)", stroke: CHART_COLORS.inflow, width: 1.6, paths: uPlot.paths.stepped({ align: 1 }), value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      { label: "기준 방류", stroke: CHART_COLORS.base, width: 1.3, dash: [5, 4], paths: uPlot.paths.stepped({ align: 1 }), value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      { label: "제안 방류", stroke: CHART_COLORS.proposal, width: 1.8, paths: uPlot.paths.stepped({ align: 1 }), value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      { label: `AI 유입 예측 (${AI.chartHorizon}시간 전 발행)`, stroke: CHART_COLORS.forecast, width: 1.3, dash: [2, 3], spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
    ],
  }, [d.x, d.inflow, d.baseRelease, d.proposalRelease, d.forecastInflow]);
}
function redrawChartMarkers() {
  Object.values(charts).forEach((chart) => chart.redraw(false, false));
}
function aiForecastChartData() {
  const x = S.rows.map((r) => Date.parse(r.timestamp) / 1000);
  const h = AI.chartHorizon;
  const actual = S.rows.map((r) => r.inflowCms);
  const predicted = x.map((_, i) => { const issued = forecastAt(i - h); return issued ? issued[h - 1] : null; });
  const persistence = x.map((_, i) => (i - h >= 0 && forecastAt(i - h) ? S.rows[i - h].inflowCms : null));
  const error = x.map((_, i) => (predicted[i] == null ? null : predicted[i] - actual[i]));
  return { x, actual, predicted, persistence, error };
}
function fanData(index) {
  const issued = forecastAt(index);
  if (!issued || !S.proposal) return null;
  const stepS = S.config.timeStepHours * 3600;
  const start = Date.parse(S.proposal.series[index].timestamp) / 1000;
  const x = [], mid = [], low = [], high = [];
  for (let k = 0; k < issued.length; k++) {
    const band = residualBand(AI.model, k + 1);
    x.push(start + (k + 1) * stepS);
    mid.push(issued[k]);
    low.push(band ? Math.max(0, issued[k] + band.low) : null);
    high.push(band ? Math.max(0, issued[k] + band.high) : null);
  }
  return { x, mid, low, high };
}
function buildAiCharts() {
  if (!$("chartAiSeries")) return;
  if (!AI.forecasts) return;
  const d = aiForecastChartData();
  makeChart("aiSeries", $("chartAiSeries"), {
    height: 260, yLabel: "유입량 (m³/s)",
    series: [
      { label: "시각" },
      { label: "실측 유입 (입력자료)", stroke: CHART_COLORS.inflow, width: 1.5, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      { label: `AI 예측 (${AI.chartHorizon}시간 앞)`, stroke: CHART_COLORS.forecast, width: 1.5, spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      { label: `유지 기준선 (${AI.chartHorizon}시간 전 값)`, stroke: CHART_COLORS.base, width: 1, dash: [4, 3], spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
    ],
  }, [d.x, d.actual, d.predicted, d.persistence]);
  makeChart("aiError", $("chartAiError"), {
    height: 170, yLabel: "예측 − 실측 (m³/s)",
    plugins: [referenceLinePlugin(0)],
    series: [
      { label: "시각" },
      { label: `AI 오차 (${AI.chartHorizon}시간 앞)`, stroke: CHART_COLORS.forecast, width: 1.2, spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
    ],
  }, [d.x, d.error]);
  const index = aiIndex();
  const fan = fanData(index);
  if ($("chartAiFan")) {
    if (fan) {
      const lookback = Math.min(48, index + 1);
      const px = [], py = [];
      for (let i = index - lookback + 1; i <= index; i++) { px.push(Date.parse(S.rows[i].timestamp) / 1000); py.push(S.rows[i].inflowCms); }
      const allX = [...px, ...fan.x];
      const pad = (arr, front, back) => [...Array(front).fill(null), ...arr, ...Array(back).fill(null)];
      makeChart("aiFan", $("chartAiFan"), {
        height: 230, yLabel: "유입량 (m³/s)",
        bands: [{ series: [3, 4], fill: CHART_COLORS.band }],
        series: [
          { label: "시각" },
          { label: "최근 48시간 실측", stroke: CHART_COLORS.inflow, width: 1.6, spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
          { label: "AI 예측 (1~24시간)", stroke: CHART_COLORS.forecast, width: 1.8, spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
          { label: "경험적 상한 (6월 잔차 p90)", stroke: "rgba(192,57,43,.45)", width: 1, dash: [2, 2], spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
          { label: "경험적 하한 (6월 잔차 p10)", stroke: "rgba(192,57,43,.45)", width: 1, dash: [2, 2], spanGaps: false, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
        ],
      }, [allX, pad(py, 0, fan.x.length), pad(fan.mid, px.length, 0), pad(fan.high, px.length, 0), pad(fan.low, px.length, 0)]);
    } else {
      destroyChart("aiFan");
      $("chartAiFan").innerHTML = '<p class="empty">현재 구간에 발행된 예측이 없습니다 (48시간 기록이 쌓인 뒤 발행).</p>';
    }
  }
  if ($("chartAiHorizon")) {
    const horizons = AI.model.horizons;
    const maeAi = [], maePersist = [], counts = [];
    for (const h of horizons) {
      let sa = 0, sp = 0, n = 0;
      for (let i = 0; i + h < S.rows.length; i++) {
        const issued = forecastAt(i);
        if (!issued) continue;
        const actual = S.rows[i + h].inflowCms;
        sa += Math.abs(issued[h - 1] - actual); sp += Math.abs(S.rows[i].inflowCms - actual); n++;
      }
      maeAi.push(n ? sa / n : null); maePersist.push(n ? sp / n : null); counts.push(n);
    }
    destroyChart("aiHorizon");
    const container = $("chartAiHorizon");
    charts.aiHorizon = new uPlot({
      width: Math.max(320, container.clientWidth - 2), height: 210, padding: [8, 12, 0, 0],
      scales: { x: { time: false } },
      legend: { live: true },
      cursor: { points: { size: 7 } },
      axes: [
        { stroke: "#555", grid: { stroke: "#e4e6ea" }, ticks: { stroke: "#c9ccd1" }, font: "11px sans-serif", label: "지평 (시간 앞)", labelFont: "11px sans-serif", values: (u, vals) => vals.map((v) => (Number.isInteger(v) ? v : "")) },
        { stroke: "#555", grid: { stroke: "#e4e6ea" }, ticks: { stroke: "#c9ccd1" }, font: "11px sans-serif", size: 56, label: "MAE (m³/s)", labelFont: "11px sans-serif" },
      ],
      series: [
        { label: "지평", value: (u, v) => (v == null ? "" : `${v}시간`) },
        { label: "AI 예측 MAE", stroke: CHART_COLORS.forecast, width: 1.8, points: { show: true, size: 5 }, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
        { label: "유지 기준선 MAE", stroke: CHART_COLORS.base, width: 1.3, dash: [4, 3], points: { show: true, size: 4 }, value: (u, v) => (v == null ? "" : fmt(v, 1)) },
      ],
    }, [horizons, maeAi, maePersist], container);
    const note = $("aiHorizonNote");
    if (note) note.textContent = `현재 불러온 자료에서 실측이 있는 발행 시각 기준 (지평 1시간 ${counts[0] ?? 0}개, 24시간 ${counts.at(-1) ?? 0}개). 학습 기간과 겹치는 구간은 학습 범위 안의 결과입니다.`;
  }
}

// ----------------------------------------------------------------------------- 3D scene
const viewerState = {
  root: null, api: null, generation: 0, view: "overview", autoOrbit: false,
  waterMotion: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality: "high", weather: { ...WEATHER_PRESETS.clear }, expanded: false, infoVisible: true, infoCollapsed: false,
  selectedFeature: "reservoir", nativeFullscreen: false, overflowBeforeExpand: null, fullscreenRequest: 0,
  status: { phase: "loading", message: "3D 장면을 준비하고 있습니다." },
};
const cameraViews = [
  ["overview", "전체 풍경"], ["upstream", "호수 쪽"], ["inlet", "여수로 입구"], ["shoreline", "호숫가"], ["plaza", "전망광장"],
  ["spillway", "여수로"], ["bucket", "감세지"], ["powerhouse", "발전소"], ["downstream", "하류 쪽"], ["top", "위에서"],
];
function sceneMarkup() {
  return `<section id="twin3dScene" class="scene-3d" aria-label="소양강댐 3D 운영 실험실">
    <div class="scene-heading"><div class="scene-heading-title"><span id="sceneProvenance" class="muted">소양강댐 외형 참고, 관측자료 미연결</span>${tip("외형은 소양강댐을 참고한 표현용 모델입니다. 수위와 방류량은 제안 운영안의 계산값에 연결되고, 수면 높이는 모델 안의 상대 높이입니다. 취수탑 앞의 노란 표시면과 라벨은 AI 예측 유입으로 계산한 예상 수위이며, 물 흐름은 유량에 연동한 시각효과로 CFD 해석이 아닙니다.", "3D 장면 설명")}</div><div class="scene-view-actions"><label class="inline-field"><span>시점</span><select id="sceneCamera" aria-label="카메라 시점">${cameraViews.map(([key, label]) => `<option value="${key}" ${viewerState.view === key ? "selected" : ""}>${label}</option>`).join("")}</select></label><label class="check"><input type="checkbox" id="sceneInfoToggle" ${viewerState.infoVisible ? "checked" : ""}> 정보 패널</label><label class="check"><input type="checkbox" id="sceneOrbit" ${viewerState.autoOrbit ? "checked" : ""}> 자동 둘러보기</label><label class="check"><input type="checkbox" id="sceneWater" ${viewerState.waterMotion ? "checked" : ""}> 물결 움직임</label><label class="inline-field"><span>화질</span><select id="sceneQuality" aria-label="3D 화질"><option value="standard" ${viewerState.quality === "standard" ? "selected" : ""}>일반</option><option value="high" ${viewerState.quality === "high" ? "selected" : ""}>높음</option></select></label><button id="sceneCapture" type="button" class="btn">${icon("image")}PNG 저장</button><button id="sceneFullscreen" type="button" class="btn" title="3D 화면 전체화면" aria-label="전체화면" aria-pressed="false">${icon("expand")}<span>전체화면</span></button></div></div>
    <div class="scene-workbench ${viewerState.infoVisible ? "" : "without-info"}" id="sceneWorkbench"><div class="scene-viewport-wrap"><div id="twin3dViewport" class="twin3d-viewport" role="region" aria-label="마우스로 회전하고 확대할 수 있는 소양강댐 외형 참고 3D 장면"></div>
      <div class="scene-readouts" aria-label="3D 장면에 연결된 계산값"><div><span>수위 (구간 끝)</span><strong id="sceneLevel"></strong></div><div><span>방류 (구간 평균)</span><strong id="sceneRelease"></strong></div><div><span>AI 예상 수위 (<span id="sceneForecastH">6</span>시간 뒤)</span><strong id="sceneForecastLevel">예측 없음</strong></div></div>
      <div class="scene-status" id="sceneStatus" role="status">3D 장면을 준비하고 있습니다.</div>
      <div class="scene-source-chip" id="sceneSourceChip">가상 시나리오</div>
      <div class="scene-weather-badge" id="sceneWeatherBadge" aria-live="polite"><span>날씨 연출 ${viewerState.weather.label}</span><strong id="sceneWeatherReading">${viewerState.weather.rainMmH} mm/h <i>|</i> ${viewerState.weather.windMs} m/s</strong></div>
      <div class="scene-camera-help">드래그 회전, 휠 확대, 우클릭 드래그 이동</div>
    </div>
      <aside id="sceneInformation" class="scene-information ${viewerState.infoCollapsed ? "is-collapsed" : ""}" aria-label="현재 구간과 선택한 시설 정보" ${viewerState.infoVisible ? "" : "hidden"}>
        <div class="scene-info-heading"><h3>현재 구간 정보</h3><button type="button" class="btn small" id="sceneInfoCollapse" aria-expanded="${!viewerState.infoCollapsed}" aria-controls="sceneInfoBody">${viewerState.infoCollapsed ? "펼치기" : "접기"}</button></div>
        <div id="sceneInfoBody" class="scene-info-body" ${viewerState.infoCollapsed ? "hidden" : ""}>
          <div class="scene-info-source" id="sceneInfoSource"></div><p class="scene-info-interval" id="sceneInfoInterval"></p><div class="scene-balance-summary" id="sceneBalance" aria-label="현재 구간 물수지 요약"></div>
          <div class="scene-feature-tabs" role="group" aria-label="시설 정보 선택">${SCENE_FEATURES.map(({ id, label }) => `<button type="button" data-scene-feature="${id}" aria-pressed="${viewerState.selectedFeature === id}">${label}</button>`).join("")}</div>
          <div id="sceneInfoContent"></div>
        </div>
      </aside>
    </div>
    <div class="scene-replay" aria-label="3D 시각 탐색"><button id="scenePrevious" type="button" class="btn small" aria-label="3D 이전 구간">‹</button><button id="scenePlay" type="button" class="btn small primary">재생</button><button id="sceneNext" type="button" class="btn small" aria-label="3D 다음 구간">›</button><div class="scene-replay-track"><label id="sceneReplayTime" for="sceneTimeline">선택 구간</label><input id="sceneTimeline" type="range" min="0" max="${S.rows.length - 1}" value="${S.index}" aria-label="3D 재생 시각"></div><span id="sceneReplayIndex" class="mono"></span></div>
    <div class="scene-weather-controls"><div class="scene-weather-presets" role="radiogroup" aria-label="날씨 선택"><span>날씨</span>${Object.values(WEATHER_PRESETS).map((weather) => `<label class="radio"><input type="radio" name="sceneWeather" value="${weather.preset}" ${viewerState.weather.preset === weather.preset ? "checked" : ""}> ${weather.label}</label>`).join("")}</div><label class="scene-weather-slider" for="sceneRain">강우 <output id="sceneRainValue">${viewerState.weather.rainMmH} mm/h</output><input id="sceneRain" type="range" min="0" max="80" step="1" value="${viewerState.weather.rainMmH}" aria-label="화면 강우 강도" aria-valuetext="${viewerState.weather.rainMmH} mm/h"></label><label class="scene-weather-slider" for="sceneWind">바람 <output id="sceneWindValue">${viewerState.weather.windMs} m/s</output><input id="sceneWind" type="range" min="0" max="20" step="0.5" value="${viewerState.weather.windMs}" aria-label="화면 풍속" aria-valuetext="${viewerState.weather.windMs} m/s"></label>${tip("강우와 바람은 화면 연출입니다. 유입량은 입력자료로 계산하며 화면 날씨를 바꿔도 계산 결과는 바뀌지 않습니다.", "날씨 연출 설명")}</div>
    <div class="scene-bottom"><span id="sceneModelNote">물 흐름은 유량에 연동한 시각효과입니다.</span><span id="sceneCalculationStatus">제안 운영안, 계산 결과</span></div>
    ${location.protocol === "file:" ? '<div class="scene-file-hint">3D 모델을 불러오려면 데스크톱 앱을 사용하거나 폴더의 시작.command를 실행하고 표시된 주소로 접속하세요.</div>' : ""}
  </section>`;
}
function setViewerStatus(status = {}) {
  viewerState.status = { ...viewerState.status, ...status };
  const target = $("sceneStatus");
  if (!target) return;
  target.textContent = viewerState.status.message || "3D 장면 준비 완료";
  target.dataset.phase = viewerState.status.phase || "ready";
  target.classList.toggle("is-error", ["error", "unsupported"].includes(viewerState.status.phase));
}
function setSceneExpanded(expanded) {
  const root = viewerState.root;
  if (expanded && !root?.isConnected) return;
  if (expanded && !viewerState.expanded) {
    viewerState.overflowBeforeExpand = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  } else if (!expanded && viewerState.overflowBeforeExpand !== null) {
    document.body.style.overflow = viewerState.overflowBeforeExpand;
    viewerState.overflowBeforeExpand = null;
  }
  viewerState.expanded = expanded;
  root?.classList.toggle("is-expanded", expanded);
  const button = $("sceneFullscreen");
  if (button) {
    button.innerHTML = expanded ? `${icon("collapse")}<span>전체화면 닫기</span>` : `${icon("expand")}<span>전체화면</span>`;
    button.setAttribute("aria-pressed", String(expanded));
    button.setAttribute("aria-label", expanded ? "전체화면 닫기" : "전체화면");
    button.title = expanded ? "전체화면 닫기 (Esc)" : "3D 화면 전체화면";
  }
  viewerState.api?.resize();
}
function exitSceneExpanded() {
  viewerState.fullscreenRequest += 1;
  const ownsNativeScreen = !!viewerState.root && document.fullscreenElement === viewerState.root;
  viewerState.nativeFullscreen = false;
  setSceneExpanded(false);
  if (ownsNativeScreen && document.exitFullscreen) Promise.resolve(document.exitFullscreen()).catch(() => {});
}
async function toggleSceneExpanded() {
  const root = viewerState.root;
  if (!root) return;
  if (viewerState.expanded || document.fullscreenElement === root) { exitSceneExpanded(); return; }
  setSceneExpanded(true);
  $("sceneFullscreen")?.focus({ preventScroll: true });
  const request = ++viewerState.fullscreenRequest;
  if (!document.fullscreenEnabled || !root.requestFullscreen) return;
  try {
    await root.requestFullscreen();
    if (request !== viewerState.fullscreenRequest || root !== viewerState.root) {
      if (document.fullscreenElement === root && document.exitFullscreen) await document.exitFullscreen();
      return;
    }
    viewerState.nativeFullscreen = document.fullscreenElement === root;
    setSceneExpanded(true);
  } catch {
    if (request === viewerState.fullscreenRequest && root === viewerState.root) setSceneExpanded(true);
  }
}
function syncSceneFullscreen() {
  const isNative = !!viewerState.root && document.fullscreenElement === viewerState.root;
  if (isNative) { viewerState.nativeFullscreen = true; setSceneExpanded(true); }
  else if (viewerState.nativeFullscreen) { viewerState.nativeFullscreen = false; setSceneExpanded(false); }
}
function handleSceneKeys(event) {
  if (!viewerState.expanded || !viewerState.root) return;
  if (event.key === "Escape") {
    event.preventDefault();
    exitSceneExpanded();
    $("sceneFullscreen")?.focus({ preventScroll: true });
  } else if (event.key === "Tab") {
    const items = [...viewerState.root.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter((item) => item.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items.at(-1), active = document.activeElement;
    if (!viewerState.root.contains(active) || (event.shiftKey && active === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
}
function disposeViewer() {
  exitSceneExpanded();
  viewerState.generation += 1;
  viewerState.api?.dispose();
  viewerState.api = null;
  viewerState.root = null;
}
function updateScene() {
  if (!viewerState.root || !S.proposal) return;
  const row = S.proposal.series[S.index];
  const solvedConfig = S.proposal.config || S.config;
  $("sceneLevel").textContent = `${fmt(row.levelM)} m`;
  $("sceneRelease").textContent = `${fmt(row.releaseCms, 0)} m³/s`;
  const horizon = Math.max(1, Math.min(24, S.config.forecastHorizonHours || 6));
  const projection = projectedLevels(S.index);
  const ahead = projection ? projection[horizon - 1] : null;
  $("sceneForecastH").textContent = horizon;
  $("sceneForecastLevel").textContent = ahead ? `${fmt(ahead.levelM)} m` : "예측 없음";
  viewerState.api?.setForecast?.(ahead ? ahead.levelM : null, ahead ? { horizonHours: horizon, deltaM: ahead.levelM - row.levelM } : null);
  $("sceneProvenance").textContent = S.meta.dataKind === "observed" ? "소양강댐 외형 참고, 관측자료 기반 계산, 제원 검증 필요" : "소양강댐 외형 참고, 관측자료 미연결";
  $("sceneSourceChip").textContent = S.meta.dataKind === "synthetic" ? "가상 시나리오" : S.meta.dataKind === "observed" ? "관측자료 기반 계산" : "자료 출처 미확인";
  $("sceneCalculationStatus").textContent = S.dirty ? "설정 변경 중, 이전 계산 결과 표시" : `${date(row.timestamp, true)}, ${POLICY_LABELS[S.proposalPolicy]}`;
  viewerState.api?.setState(row, solvedConfig, { ...S.meta, configSource: S.configSource, weather: { ...viewerState.weather } });
  updateSceneInformation();
  setViewerStatus();
}
function informationSnapshot() {
  if (!S.proposal) return null;
  const row = S.proposal.series[S.index];
  const info = sceneInformation(row, S.proposal.config || S.config, S.meta, viewerState.selectedFeature, viewerState.api?.getHydraulicInfo?.());
  info.interval = `${date(row.timestamp)} → ${date(row.endTimestamp, true)} (한국시간)`;
  return info;
}
function sceneMetricMarkup(metric, compact = false) {
  const value = metric.value === null ? "미제공" : fmt(metric.value, metric.digits);
  const unit = metric.value === null ? "" : metric.unit;
  return `<div class="scene-info-metric ${compact ? "compact" : ""}"><span>${escape(metric.label)} <i class="evidence ${metric.source === "입력자료" ? "input" : metric.source === "모형가정" ? "assumed" : "computed"}">[${escape(metric.source)}]</i></span><strong>${value}<small>${escape(unit)}</small></strong></div>`;
}
function forecastInfoMarkup() {
  const issued = forecastAt(S.index - 1);
  const horizon = Math.max(1, Math.min(24, S.config.forecastHorizonHours || 6));
  if (!AI.forecasts) return `<section class="scene-feature-explanation"><div class="scene-feature-title"><h4>AI 유입 예측</h4></div><p class="muted small">${AI.status === "ready" ? "AI 예측 화면에서 예측을 생성하면 이곳에 표시됩니다." : "AI 모형이 준비되지 않았습니다."}</p></section>`;
  if (!issued) return `<section class="scene-feature-explanation"><div class="scene-feature-title"><h4>AI 유입 예측</h4></div><p class="muted small">이 구간 이전에 발행된 예측이 없습니다 (48시간 기록이 쌓인 뒤 발행).</p></section>`;
  const metrics = [1, 3, 6].map((h) => ({ label: `${h}시간 뒤 유입`, value: issued[h - 1], unit: "m³/s", digits: 1, source: "AI 예측" }));
  metrics.push({ label: `다음 ${horizon}시간 평균`, value: expectedInflow(S.index, horizon), unit: "m³/s", digits: 1, source: "AI 예측" });
  const used = S.proposal?.series[S.index]?.forecastUsed;
  return `<section class="scene-feature-explanation"><div class="scene-feature-title"><h4>AI 유입 예측</h4>${tip(`직전 구간이 끝난 시점에 ${AI.model.architecture === "lstm" ? "LSTM" : "Transformer"} 모형이 발행한 예측입니다. 입력은 과거 48시간의 공개 유입 기록뿐이며 강우 예보는 쓰지 않습니다. ${used ? "현재 제안 운영안이 이 예측의 평균을 참고했습니다." : "현재 제안 운영안은 이 예측을 사용하지 않습니다."}`, "AI 예측 설명")}</div><div class="scene-feature-metrics">${metrics.map((m) => sceneMetricMarkup(m, true)).join("")}</div></section>`;
}
function updateSceneInformation() {
  const info = informationSnapshot();
  if (!info || !$("sceneInfoContent")) return;
  $("sceneInfoSource").textContent = `${POLICY_LABELS[S.proposalPolicy]}, ${info.sourceLabel}${S.dirty ? ", 변경 전 계산" : ""}`;
  $("sceneInfoInterval").textContent = `${info.interval}, ${fmt(info.durationHours, 2)}시간`;
  const [inflow, release, storageChange] = info.common;
  const balanceAvailable = [inflow.value, release.value, storageChange.value, info.durationHours].every(Number.isFinite);
  const difference = Math.abs(storageChange.value) < 1e-8 ? 0 : storageChange.value;
  $("sceneBalance").innerHTML = balanceAvailable
    ? `<span>유입 ${fmt(inflow.value)} − 방류 ${fmt(release.value)} m³/s</span><strong>→ 저수량 ${difference > 0 ? "↑ +" : difference < 0 ? "↓ " : "유지 "}${fmt(difference, difference !== 0 && Math.abs(difference) < 0.001 ? 6 : 3)} 백만 m³ / ${fmt(info.durationHours, info.durationHours % 1 === 0 ? 0 : 2)}시간 <i class="evidence computed">[계산값]</i></strong>`
    : "<span>물수지 요약, 자료 미제공</span>";
  const branch = info.flow.map((metric, index) => `<div class="scene-flow-branch"><span>${index === 0 ? "발전소 경유" : "여수로로 표현"}</span><strong>${metric.value === null ? "미제공" : fmt(metric.value)}<small>${metric.value === null ? "" : "m³/s"}</small></strong></div>`).join("");
  const power = info.metrics.filter((metric) => ["MWh", "MW"].includes(metric.unit));
  const detailsWasOpen = $("sceneHydraulicDetails")?.open;
  const detailsSourceWasOpen = $("sceneSourceDetails")?.open;
  const scrollPosition = $("sceneInfoBody").scrollTop;
  $("sceneInfoContent").innerHTML = `<section class="scene-feature-explanation"><div class="scene-feature-title"><h4>${escape(info.featureTitle)}</h4>${tip(info.explanation, info.featureTitle + " 흐름 설명")}</div><div class="scene-feature-metrics">${info.featureMetrics.map((metric) => sceneMetricMarkup(metric, true)).join("")}</div></section>
    ${forecastInfoMarkup()}
    <h4 class="scene-summary-heading">같은 구간의 전체 물수지</h4><div class="scene-info-grid">${info.common.map((metric) => sceneMetricMarkup(metric)).join("")}</div>
    <div class="scene-flow-map" aria-label="물의 경로"><div class="scene-flow-start">저수지<span>↗<br>↘</span></div><div class="scene-flow-split">${branch}</div><div class="scene-flow-end"><span>→</span>하류</div></div><p class="scene-flow-note">발전용 + 비발전 = 총방류 <i class="evidence computed">[계산값]</i></p>
    ${info.feature === "powerhouse" ? "" : `<div class="scene-energy-row">${power.map((metric) => sceneMetricMarkup(metric, true)).join("")}</div>`}
    <details id="sceneHydraulicDetails" ${detailsWasOpen ? "open" : ""}><summary>모형 가정과 수로 수치</summary>${info.hydraulicMetrics.length ? `<div class="scene-feature-metrics">${info.hydraulicMetrics.map((metric) => sceneMetricMarkup(metric, true)).join("")}</div>` : ""}<ul>${info.notes.map((note) => `<li>${escape(note)}</li>`).join("")}</ul></details>
    <details id="sceneSourceDetails" ${detailsSourceWasOpen ? "open" : ""}><summary>자료 출처와 숫자 구분</summary><p>${escape(info.source)}</p><p>[입력자료] 불러온 자료의 값<br>[계산값] 물수지와 발전 모형의 결과<br>[모형가정] 검증 전 형상과 수리 근사<br>[AI 예측] 과거 48시간 기록으로 발행한 유입량 예측</p><p>가상 자료는 실제 관측이 아닙니다. 자료 속 수위는 구간 시작 값이며 계산 수위와 시점이 다릅니다.</p></details>`;
  $("sceneInfoBody").scrollTop = scrollPosition;
  $("scenePrevious").disabled = S.index === 0;
  $("sceneNext").disabled = S.index === S.rows.length - 1;
  $("scenePlay").textContent = S.playing ? "일시정지" : "재생";
  $("scenePlay").setAttribute("aria-label", S.playing ? "3D 일시정지" : "3D 재생");
  $("sceneTimeline").max = S.rows.length - 1;
  $("sceneTimeline").value = S.index;
  setRangeFill($("sceneTimeline"));
  $("sceneTimeline").setAttribute("aria-valuetext", `${date(S.proposal.series[S.index].timestamp)}, ${S.index + 1}번째 구간`);
  $("sceneReplayTime").textContent = `${date(S.proposal.series[S.index].timestamp, true)} → ${date(S.proposal.series[S.index].endTimestamp, true)}`;
  $("sceneReplayIndex").textContent = `${S.index + 1} / ${S.rows.length}`;
}
function selectSceneFeature(id) {
  if (!SCENE_FEATURES.some((feature) => feature.id === id)) return;
  viewerState.selectedFeature = id;
  viewerState.api?.setSelection?.(id);
  viewerState.root?.querySelectorAll("[data-scene-feature]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.sceneFeature === id)));
  updateSceneInformation();
  $("sceneInfoBody").scrollTop = 0;
}
function setSceneInformationVisible(visible) {
  viewerState.infoVisible = visible;
  $("sceneInformation").hidden = !visible;
  $("sceneWorkbench").classList.toggle("without-info", !visible);
  $("sceneInfoToggle").checked = visible;
  viewerState.api?.setAnnotations?.(visible);
  viewerState.api?.resize();
}
function togglePlayback() {
  if (S.dirty) return toast("다시 계산을 먼저 눌러 주세요.");
  if (S.playing) { stop(); render(); return; }
  if (S.index >= S.rows.length - 1) S.index = 0;
  S.playing = true;
  render();
  timer = setInterval(() => {
    S.index = Math.min(S.rows.length - 1, S.index + 1);
    if (S.index === S.rows.length - 1) stop();
    render();
  }, 1000 / S.speed);
}
function seekScene(index) {
  stop();
  S.index = Math.max(0, Math.min(S.rows.length - 1, index));
  render();
}
function bindScene() {
  const root = viewerState.root;
  $("sceneInfoToggle").onchange = (event) => setSceneInformationVisible(event.target.checked);
  $("sceneInfoCollapse").onclick = () => {
    viewerState.infoCollapsed = !viewerState.infoCollapsed;
    $("sceneInformation").classList.toggle("is-collapsed", viewerState.infoCollapsed);
    $("sceneInfoBody").hidden = viewerState.infoCollapsed;
    $("sceneInfoCollapse").setAttribute("aria-expanded", String(!viewerState.infoCollapsed));
    $("sceneInfoCollapse").textContent = viewerState.infoCollapsed ? "펼치기" : "접기";
    viewerState.api?.resize();
  };
  root.querySelectorAll("[data-scene-feature]").forEach((button) => { button.onclick = () => selectSceneFeature(button.dataset.sceneFeature); });
  $("scenePlay").onclick = togglePlayback;
  $("scenePrevious").onclick = () => seekScene(S.index - 1);
  $("sceneNext").onclick = () => seekScene(S.index + 1);
  $("sceneTimeline").oninput = (event) => { setRangeFill(event.target); seekScene(Number(event.target.value)); };
  $("sceneCamera").onchange = (event) => { viewerState.view = event.target.value; viewerState.api?.setView(viewerState.view); };
  $("sceneOrbit").onchange = (event) => { viewerState.autoOrbit = event.target.checked; viewerState.api?.setAutoOrbit(viewerState.autoOrbit); };
  $("sceneWater").onchange = (event) => { viewerState.waterMotion = event.target.checked; viewerState.api?.setWaterMotion(viewerState.waterMotion); };
  $("sceneQuality").onchange = (event) => { viewerState.quality = event.target.value; viewerState.api?.setQuality(viewerState.quality); };
  const applyWeather = () => {
    const weather = viewerState.weather;
    root.querySelectorAll('input[name="sceneWeather"]').forEach((input) => { input.checked = input.value === weather.preset; });
    $("sceneRain").value = weather.rainMmH;
    $("sceneWind").value = weather.windMs;
    $("sceneRain").setAttribute("aria-valuetext", `${weather.rainMmH} mm/h`);
    $("sceneWind").setAttribute("aria-valuetext", `${weather.windMs} m/s`);
    $("sceneRainValue").textContent = `${weather.rainMmH} mm/h`;
    $("sceneWindValue").textContent = `${weather.windMs} m/s`;
    $("sceneWeatherBadge").querySelector("span").textContent = `날씨 연출 ${weather.label}`;
    $("sceneWeatherReading").innerHTML = `${weather.rainMmH} mm/h <i>|</i> ${weather.windMs} m/s`;
    viewerState.api?.setWeather(weather);
    updateScene();
  };
  root.querySelectorAll('input[name="sceneWeather"]').forEach((input) => {
    input.onchange = () => { if (input.checked) { viewerState.weather = { ...WEATHER_PRESETS[input.value] }; applyWeather(); } };
  });
  $("sceneRain").oninput = (event) => {
    const rainMmH = Number(event.target.value);
    const preset = rainMmH === 0 ? "clear" : rainMmH >= 25 ? "monsoon" : "rain";
    viewerState.weather = { ...viewerState.weather, preset, label: WEATHER_PRESETS[preset].label, rainMmH };
    applyWeather();
  };
  $("sceneWind").oninput = (event) => { viewerState.weather = { ...viewerState.weather, windMs: Number(event.target.value) }; applyWeather(); };
  $("sceneFullscreen").onclick = toggleSceneExpanded;
  $("sceneCapture").onclick = async () => {
    if (!viewerState.api) return toast("3D 장면이 준비된 뒤 다시 눌러 주세요.");
    try {
      const snapshot = informationSnapshot();
      const result = await viewerState.api.capture(viewerState.infoVisible ? { information: snapshot } : {});
      if (!result) throw new Error("화면을 저장할 수 없습니다.");
      const blob = result instanceof Blob;
      const url = blob ? URL.createObjectURL(result) : result;
      if (typeof url !== "string" || (!blob && !url.startsWith("data:image/"))) throw new Error("화면 저장 형식을 확인하지 못했습니다.");
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `TWIN_소양강댐_${viewerState.weather.label}_외형참고_${S.meta.dataKind}_${S.index + 1}.png`;
      anchor.click();
      if (blob) setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(viewerState.infoVisible ? "3D 화면과 현재 구간 정보를 PNG로 저장했습니다." : "현재 3D 화면을 PNG로 저장했습니다.");
    } catch (error) {
      toast("화면을 저장하지 못했습니다: " + error.message);
    }
  };
}
function mountViewer() {
  const root = $("twin3dScene");
  if (!root || S.errors.length) return;
  if (viewerState.root === root) return updateScene();
  disposeViewer();
  viewerState.root = root;
  const generation = viewerState.generation;
  viewerState.status = { phase: "loading", message: "3D 장면을 준비하고 있습니다." };
  bindScene();
  updateScene();
  try {
    Promise.resolve(createViewer($("twin3dViewport"), {
      onFeatureSelect: (id) => { if (generation === viewerState.generation) selectSceneFeature(id); },
      onStatus: (status) => { if (generation === viewerState.generation) { setViewerStatus(status); updateSceneInformation(); } },
    }))
      .then((api) => {
        if (generation !== viewerState.generation) return api?.dispose();
        viewerState.api = api;
        api.setQuality(viewerState.quality);
        api.setView(viewerState.view);
        api.setAutoOrbit(viewerState.autoOrbit);
        api.setWaterMotion(viewerState.waterMotion);
        api.setWeather(viewerState.weather);
        api.setSelection?.(viewerState.selectedFeature);
        api.setAnnotations?.(viewerState.infoVisible);
        updateScene();
        api.resize();
      })
      .catch((error) => setViewerStatus({ phase: "error", message: `3D 화면을 열지 못했습니다. ${error.message}` }));
  } catch (error) {
    setViewerStatus({ phase: "error", message: `3D 화면을 열지 못했습니다. ${error.message}` });
  }
}

// ----------------------------------------------------------------------------- pages
function conditionBar() {
  const recordedOk = S.rows.every((r) => Number.isFinite(r.observedReleaseCms));
  const forecastOk = AI.status === "ready";
  const item = (label, control) => `<div class="cond-item"><span class="cond-label">${label}</span>${control}</div>`;
  return `<div class="cond"><div class="cond-row">
    ${item("기준 운영안", `<select id="basePolicy"><option value="fixed" ${S.basePolicy === "fixed" ? "selected" : ""}>${POLICY_LABELS.fixed}</option><option value="rule" ${S.basePolicy === "rule" ? "selected" : ""}>${POLICY_LABELS.rule}</option><option value="recorded" ${S.basePolicy === "recorded" ? "selected" : ""} ${recordedOk ? "" : "disabled"}>${POLICY_LABELS.recorded}</option></select>`)}
    ${item("제안 운영안", `<select id="proposalPolicy"><option value="rule" ${S.proposalPolicy === "rule" ? "selected" : ""}>${POLICY_LABELS.rule}</option><option value="forecast" ${S.proposalPolicy === "forecast" ? "selected" : ""} ${forecastOk ? "" : "disabled"}>${POLICY_LABELS.forecast}</option><option value="fixed" ${S.proposalPolicy === "fixed" ? "selected" : ""}>${POLICY_LABELS.fixed}</option></select>`)}
    ${item("고정 방류량", `<input id="fixedRelease" class="num" type="number" min="${S.config.minimumReleaseCms}" max="${S.config.maxReleaseCms}" step="1" value="${S.config.fixedReleaseCms}"><span class="unit">m³/s</span>`)}
    ${item("목표 저수량", `<input id="targetStorage" class="num" type="number" min="${S.config.minStorageMcm}" max="${S.config.floodStorageMcm}" step="0.1" value="${S.config.targetStorageMcm}"><span class="unit">백만 m³</span>`)}
    ${item("예측 참고 지평", `<select id="forecastHorizon" class="narrow" ${S.proposalPolicy === "forecast" ? "" : "disabled"}>${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${S.config.forecastHorizonHours === h ? "selected" : ""}>${h}시간</option>`).join("")}</select>`)}
    <div class="cond-actions"><button id="run" class="btn primary">${icon("calc")}다시 계산</button>${tip("두 안은 같은 초기 저수량과 유입자료를 사용합니다. 목표 저수량 유지 규칙은 직전 구간 유입량, AI 예측 참고 규칙은 직전 구간에 발행된 AI 예측의 평균 유입량을 사용합니다. 두 규칙 모두 미래 실측을 미리 보지 않으며 최적화나 강화학습이 아닙니다.", "운영안 설명")}</div>
  </div><div class="cond-status" id="dirtyText">${S.dirty ? "변경사항이 있습니다. 다시 계산해 주세요." : "현재 설정으로 계산 완료"}</div></div>`;
}
function currentStateTable(v, p) {
  const cumulative = p.series.slice(0, S.index + 1).reduce((s, r) => s + r.energyMWh, 0);
  const horizon = Math.max(1, Math.min(24, S.config.forecastHorizonHours || 6));
  const expected = expectedInflow(S.index, horizon);
  const projection = projectedLevels(S.index);
  const ahead = projection ? projection[horizon - 1] : null;
  const cell = (label, value, unit, note) => `<th>${label}</th><td><strong class="num">${value}</strong> <span class="unit">${unit}</span>${note ? `<span class="cell-note">${note}</span>` : ""}</td>`;
  return `<table class="form"><tbody>
    <tr>${cell("구간", `${escape(date(v.timestamp))} → ${escape(date(v.endTimestamp, true))}`, "", "한국시간")}${cell("수위", fmt(v.levelM, 2), "m", "구간 끝, 계산값")}${cell("저수량", fmt(v.storageMcm, 2), "백만 m³", "구간 끝, 계산값")}${cell("유입량", fmt(v.inflowCms, 1), "m³/s", "구간 평균, 입력자료")}</tr>
    <tr>${cell("총방류량", fmt(v.releaseCms, 1), "m³/s", "구간 평균, 계산값")}${cell("발전 방류", fmt(v.turbineCms, 1), "m³/s", "계산값")}${cell("누적 발전량", fmt(cumulative, 0), "MWh", "시뮬레이션 추정")}${cell(`AI 예측 유입 (다음 ${horizon}시간 평균)`, expected == null ? "없음" : fmt(expected, 1), expected == null ? "" : "m³/s", ahead ? `예상 수위 ${fmt(ahead.levelM, 2)} m (${horizon}시간 뒤)` : (AI.forecasts ? "이 구간 예측 없음" : "AI 예측 미생성"))}</tr>
  </tbody></table>`;
}
function dashboard() {
  let html = `<div id="dashboardBefore">${pageHead("운영 실험실", "소양강댐을 참고한 3D 장면을 둘러보고, 방류 조건에 따른 두 운영안의 변화를 같은 조건에서 비교합니다. AI 예측은 과거 48시간 기록으로 발행한 유입량 예측입니다.")}${statusRow()}`;
  if (S.errors.length) return html + `${conditionBar()}<div class="errors">${S.errors.map(escape).join("<br>")}</div></div>`;
  const p = S.proposal, b = S.base, v = p.series[S.index];
  html += conditionBar() + section("현재 구간", currentStateTable(v, p), tip("선택한 구간의 계산값입니다. 재생 막대나 3D 장면의 시간 막대로 구간을 바꿀 수 있습니다.", "현재 구간 설명")) + "</div>";
  html += section("3D 장면", sceneMarkup());
  html += `<div id="dashboardCharts">${section("시계열 그래프", `<div class="chart-grid"><div class="chart-box"><div class="chart-title">수위 <span class="muted">(구간 끝)</span></div><div id="chartLevel" class="chart"></div></div><div class="chart-box"><div class="chart-title">유입과 방류 <span class="muted">(구간 평균)</span></div><div id="chartFlow" class="chart"></div></div></div>`, `<div class="sec-tools"><label class="inline-field"><span>그래프의 AI 예측 지평</span><select id="chartHorizon">${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${AI.chartHorizon === h ? "selected" : ""}>${h}시간 앞</option>`).join("")}</select></label>${tip("가로축 십자선을 움직이면 범례에 그 시각의 값이 표시됩니다. 드래그로 구간을 확대하고 더블클릭으로 되돌립니다. 점선 세로선은 선택한 구간입니다. 붉은 점선은 AI 예측(선택한 지평만큼 전에 발행)이며, 수위 그래프의 붉은 점선은 현재 구간에 발행된 24시간 예측 유입을 규칙 운영에 넣어 계산한 예상 궤적입니다.", "그래프 사용법")}</div>`)}</div>`;
  html += '<div id="dashboardAfter">';
  html += section("시간 재생", `<div class="toolbar"><button id="resetTime" class="btn small" aria-label="처음으로">${icon("first")}처음</button><button id="play" class="btn small primary">${S.playing ? "일시정지" : "재생"}</button><button id="peakReleaseTime" class="btn small" title="현재 제안 운영안에서 총방류량이 가장 많은 구간으로 이동">${icon("peak")}방류 최대 시점</button><label class="inline-field"><span>속도</span><select id="speed" aria-label="재생 속도">${[1, 2, 4, 8].map((n) => `<option value="${n}" ${S.speed === n ? "selected" : ""}>${n}×</option>`).join("")}</select></label><span class="mono muted">${S.index + 1} / ${S.rows.length}</span><span class="mono current-time" id="timelineCurrent">${escape(date(v.timestamp, true))} → ${escape(date(v.endTimestamp, true))}</span></div><div class="timeline">${rangeMarkup("timeline", S.rows.length - 1, S.index, "재생 시각")}<div class="tick-labels"><span>${escape(date(S.rows[0].timestamp, true))}</span><span>${escape(date(p.series.at(-1).endTimestamp, true))}</span></div></div>`);
  const items = [
    ["총 발전량", "totalEnergyMWh", "MWh", 1], ["종료 저수량", "endStorageMcm", "백만 m³", 2], ["총방류 부피", "totalReleaseMcm", "백만 m³", 2],
    ["최소 방류량 대비 부족", "shortageMcm", "백만 m³", 3], ["설정 홍수 저수량 초과 구간", "floodHours", "시간", 1], ["설정 최대 방류량 초과 구간", "releaseViolationHours", "시간", 1],
  ];
  if (S.proposalPolicy === "forecast") items.push(["AI 예측을 참고한 구간 수", "forecastUsedIntervals", "개", 0]);
  const adjusted = b.series.filter((r) => r.controlledReleaseCms + 1e-9 < r.requestedReleaseCms);
  const unfulfilled = adjusted.reduce((sum, r) => sum + ((r.requestedReleaseCms - r.controlledReleaseCms) * S.config.timeStepHours * 3600) / 1e6, 0);
  const replayNote = S.basePolicy === "recorded" ? `<p class="note">관측 방류 재현 (물수지 제약 적용): 요청한 방류를 물 부족으로 줄인 구간 ${adjusted.length}개, 미이행 부피 ${fmt(unfulfilled, 4)} 백만 m³. 관측 발전유량이 없으면 발전 우선 배분을 가정합니다.</p>` : "";
  html += section("전체 기간 비교", `<table class="grid numeric"><thead><tr><th>비교 항목</th><th>기준 운영안 (${POLICY_LABELS[S.basePolicy]})</th><th>제안 운영안 (${POLICY_LABELS[S.proposalPolicy]})</th><th>차이 (제안 − 기준)</th></tr></thead><tbody>${items.map(([label, key, unit, d]) => `<tr><td>${label}</td><td>${b.metrics[key] == null ? "해당 없음" : fmt(b.metrics[key], d) + " " + unit}</td><td class="emphasis">${p.metrics[key] == null ? "해당 없음" : fmt(p.metrics[key], d) + " " + unit}</td><td>${b.metrics[key] == null || p.metrics[key] == null ? "해당 없음" : fmt(p.metrics[key] - b.metrics[key], d) + " " + unit}</td></tr>`).join("")}</tbody></table>${replayNote}<details><summary>계산 가정과 점검 결과</summary><p>최대 물수지 잔차: 기준 ${Number(b.metrics.maxMassBalanceErrorMcm).toExponential(2)}, 제안 ${Number(p.metrics.maxMassBalanceErrorMcm).toExponential(2)} 백만 m³</p><ul>${[...new Set([...b.warnings, ...p.warnings, "수위와 발전량은 입력 제원에 따른 계산입니다. 실측 대비 보정과 검증을 별도로 수행해야 합니다.", "탁도 자료는 보관과 내보내기만 지원합니다. 층별 탁수와 선택취수 모델은 아직 연결하지 않았습니다."])].map((w) => `<li>${escape(w)}</li>`).join("")}</ul></details>`, `<div class="sec-tools"><button id="exportResults" class="btn small">${icon("csv")}결과 CSV 내보내기</button>${tip("발전량과 함께 남은 물과 설정 조건 위반을 확인하세요. 종료 저수량이 다른 안의 발전량만 비교해 우열을 단정하지 마세요. 한계 초과 시간은 모델 구간 단위 집계이며 실제 침수 시간이나 안전성을 뜻하지 않습니다.", "전체 기간 비교 설명")}</div>`);
  return html + `<div class="footer">출처: ${escape(S.meta.source || "미입력")}</div></div>`;
}
function evaluationTable() {
  const e = AI.evaluation;
  if (!e) return '<p class="muted">평가 결과 파일(assets/ai/evaluation.json)이 없습니다.</p>';
  const methods = e.methods;
  const rowsH = e.by_horizon;
  return `<table class="grid numeric"><thead><tr><th>지평</th>${methods.map((m) => `<th>${escape(e.labels[m] || m)}</th>`).join("")}<th>표본 수</th></tr></thead><tbody>${Object.entries(rowsH).map(([h, row]) => `<tr><td>${h.replace("h", "")}시간</td>${methods.map((m) => `<td class="${m === e.winner ? "emphasis" : ""}">${row[m] == null ? `<span class="muted">기록 없음</span>` : fmt(row[m], 1)}</td>`).join("")}<td>${row.n ?? ""}</td></tr>`).join("")}</tbody></table>`;
}
/** "A − B" 형식의 절대오차 차이: 양수면 B의 오차가 작고 음수면 A의 오차가 작다. 두 블록 길이의 95% 구간이 모두 0을 제외할 때만 차이를 인정한다. */
function bootstrapVerdict(row) {
  const [a, b] = String(row.label).split(" − ").map((x) => x.trim());
  if (row.zero24 || row.zero168) return "차이 근거 부족 (구간이 0을 포함)";
  if (row.point < 0) return `${a} 쪽 오차가 작음`;
  if (row.point > 0) return `${b || "비교 대상"} 쪽 오차가 작음`;
  return "차이 없음";
}
function bootstrapTable() {
  const e = AI.evaluation;
  if (!e?.bootstrap) return "";
  return `<table class="grid numeric"><thead><tr><th>짝지은 비교 (절대오차 차이, 3시간 앞)</th><th>점추정</th><th>95% 구간 (24시간 블록)</th><th>95% 구간 (168시간 블록)</th><th>판정</th></tr></thead><tbody>${e.bootstrap.map((row) => `<tr><td>${escape(row.label)}</td><td>${fmt(row.point, 2)}</td><td>${fmt(row.ci24[0], 2)} ~ ${fmt(row.ci24[1], 2)}</td><td>${fmt(row.ci168[0], 2)} ~ ${fmt(row.ci168[1], 2)}</td><td>${bootstrapVerdict(row)}</td></tr>`).join("")}</tbody></table>`;
}
function highInflowTable() {
  const e = AI.evaluation;
  const h = e?.high_inflow;
  if (!h?.methods) return "";
  const methods = e.methods.filter((m) => h.methods[m]);
  return `<h3 class="sub">고유입 구간 (3시간 앞, 실측 목표 ${fmt(h.threshold_m3s, 1)} m³/s 이상, ${h.n}개 / ${h.n_total}개)</h3><table class="grid numeric"><thead><tr><th>항목</th>${methods.map((m) => `<th>${escape(e.labels[m] || m)}</th>`).join("")}</tr></thead><tbody><tr><td>MAE (m³/s)</td>${methods.map((m) => `<td class="${m === e.winner ? "emphasis" : ""}">${fmt(h.methods[m].MAE, 1)}</td>`).join("")}</tr><tr><td>평균 편향 (예측 − 실측)</td>${methods.map((m) => `<td class="${m === e.winner ? "emphasis" : ""}">${fmt(h.methods[m].bias, 1)}</td>`).join("")}</tr><tr><td>평균 과소예측 (실측 − 예측, 0 이상)</td>${methods.map((m) => `<td class="${m === e.winner ? "emphasis" : ""}">${fmt(h.methods[m].underprediction_mean, 1)}</td>`).join("")}</tr></tbody></table><p class="note">${escape(h.definition)} 유지 기준선보다 평균 과소예측이 큰 방법은 상승기를 늦게 따라간다는 뜻이며, 전체 MAE가 낮아도 홍수 대응 성능이 좋아졌다고 말하지 않습니다.</p>`;
}
function monthlyTable() {
  const e = AI.evaluation;
  if (!e?.monthly) return "";
  const months = Object.keys(e.monthly);
  return `<table class="grid numeric"><thead><tr><th>월 (3시간 앞 MAE)</th>${e.methods.map((m) => `<th>${escape(e.labels[m] || m)}</th>`).join("")}</tr></thead><tbody>${months.map((month) => `<tr><td>${month}월 ${e.monthly[month].role ? `<span class="muted">(${e.monthly[month].role})</span>` : ""}</td>${e.methods.map((m) => `<td class="${m === e.winner ? "emphasis" : ""}">${e.monthly[month][m] == null ? `<span class="muted">기록 없음</span>` : fmt(e.monthly[month][m], 1)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function aiPage() {
  let html = pageHead("AI 예측", "과거 48시간의 공개 유입 기록만으로 다음 1~24시간 유입량을 예측하는 모형입니다. 2024년 소양강댐 자료로 6월에 설정을 고르고 7~9월에 매월 재학습해 평가했습니다. 강우 예보나 미래 정보는 쓰지 않습니다.") + statusRow();
  const model = AI.model;
  const modelRows = model
    ? [["구조", model.architecture === "lstm" ? `LSTM (hidden ${model.config.hidden}, ${model.config.layers}층)` : `Transformer encoder (d_model ${model.config.d_model}, ${model.config.layers}층, ${model.config.heads} heads)`],
       ["입력", "최근 48시간 유입량 (log1p 표준화), 시각 sin/cos"], ["출력", "1~24시간 뒤 유입량 (log 공간 변화량, 0 이상 제한)"],
       ["학습 자료", model.training ? `${model.training.data_source}, ${model.training.period}, 표본 ${model.training.n_train}개` : "미기재"],
       ["재학습 시각", model.training?.refit_time || "미기재"], ["버전", model.version || "미기재"], ["실행 위치", "이 프로그램 안 (브라우저 JavaScript, PyTorch 검증 벡터와 일치 확인)"]]
    : [["상태", AI.status === "loading" ? "불러오는 중" : AI.error || "모형 파일 없음"]];
  html += section("모형", `<table class="form two"><tbody>${modelRows.map(([k, v]) => `<tr><th>${k}</th><td>${escape(v)}</td></tr>`).join("")}</tbody></table>`, tip("가중치와 정규화 통계는 assets/ai/model.json에 있습니다. 같은 입력에 대해 PyTorch 출력과 일치하는지 자동 검사로 확인한 JavaScript 구현이 예측을 계산합니다.", "모형 설명"));
  const stateText = AI.computing ? `계산 중 ${Math.round(AI.progress * 100)} %` : AI.forecasts ? `${AI.issued}개 구간에 예측 발행 (${S.rows.length}개 구간 중, 처음 ${model?.window ?? 48}개 구간은 기록 부족)` : AI.reason || "아직 생성하지 않음";
  html += section("현재 자료 예측", `<table class="form two"><tbody><tr><th>자료</th><td>${escape(S.meta.name)}, ${S.rows.length}개 구간, ${fmt(S.config.timeStepHours, 2)}시간 간격</td></tr><tr><th>예측 상태</th><td id="aiComputeState">${escape(stateText)}</td></tr></tbody></table><div class="toolbar"><button id="aiCompute" class="btn primary" ${AI.status !== "ready" || AI.computing ? "disabled" : ""}>${icon("calc")}${AI.forecasts ? "예측 다시 생성" : "예측 생성"}</button><label class="inline-field"><span>그래프 지평</span><select id="aiHorizon">${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${AI.chartHorizon === h ? "selected" : ""}>${h}시간 앞</option>`).join("")}</select></label><button id="aiExport" class="btn" ${AI.forecasts ? "" : "disabled"}>${icon("csv")}예측 CSV 내보내기</button><button id="aiUseInPolicy" class="btn" ${AI.forecasts ? "" : "disabled"}>${icon("link")}제안 운영안에 적용</button></div>`, tip("예측 생성은 불러온 자료의 모든 구간에 대해 48시간 창을 밀어 가며 모형을 실행합니다. 1시간 간격 자료에서만 동작합니다. 제안 운영안에 적용하면 운영 실험실의 제안안이 AI 예측 참고 규칙으로 바뀝니다.", "현재 자료 예측 설명"));
  if (AI.forecasts) {
    html += section("예측과 실측", `<div class="chart-box"><div class="chart-title">유입량 실측과 AI 예측 <span class="muted">(예측은 발행 시각이 아니라 목표 시각에 표시)</span></div><div id="chartAiSeries" class="chart"></div></div><div class="chart-box"><div class="chart-title">예측 오차</div><div id="chartAiError" class="chart"></div></div>`, tip("십자선을 움직이면 그 시각의 실측, 예측, 유지 기준선 값이 범례에 표시됩니다. 드래그로 확대, 더블클릭으로 복원합니다.", "그래프 사용법"));
    const index = aiIndex();
    html += section("선택 구간의 24시간 예측", `<div class="chart-grid"><div class="chart-box"><div class="chart-title">선택 구간 끝에 발행된 예측 <span class="muted" id="aiFanTitle">(${S.proposal ? escape(date(S.proposal.series[index].endTimestamp)) : ""} 기준)</span></div><div id="chartAiFan" class="chart"></div></div><div class="chart-box"><div class="chart-title">지평별 MAE <span class="muted">(현재 자료)</span></div><div id="chartAiHorizon" class="chart"></div><p class="note" id="aiHorizonNote"></p></div></div><div class="toolbar"><button id="aiPrev" class="btn small">‹ 이전 구간</button><span class="mono muted" id="aiIndexLabel">${index + 1} / ${S.rows.length}</span><button id="aiNext" class="btn small">다음 구간 ›</button>${rangeMarkup("aiTimeline", S.rows.length - 1, index, "구간 선택")}</div>`, tip("음영은 6월 검증 잔차의 10~90 % 분위수를 더한 경험적 범위이며 보정된 예측구간이 아닙니다. 지평별 MAE는 현재 불러온 자료에서 실측이 있는 구간으로 계산합니다.", "24시간 예측 설명"));
  }
  html += section("2024년 소양강댐 평가 (7~9월, 매월 재학습)", `${evaluationTable()}<p class="note">${AI.evaluation ? escape(AI.evaluation.definition) : ""}</p>${bootstrapTable()}${highInflowTable()}<h3 class="sub">월별 (3시간 앞 MAE, m³/s)</h3>${monthlyTable()}`, tip("표의 값은 같은 발행 시각에서 여섯 방법을 비교한 MAE (m³/s)입니다. 유지는 현재 값이 유지된다는 가장 단순한 예측, Ridge는 1단계에서 만든 선형 모형입니다. 블록 부트스트랩은 24시간과 168시간 블록을 복원추출해 짝지은 오차 차이의 95% 범위를 구한 것이며, 범위가 0을 포함하지 않을 때만 개선 근거가 있다고 적습니다.", "평가 설명"));
  html += section("해석 범위", `<ul class="plain"><li>입력은 공개 유입 기록뿐입니다. 강우 예보나 상류 관측을 쓰지 않으므로 강우로 시작되는 홍수의 첫 상승은 예측하지 못하고, 상승이 기록된 뒤부터 따라갑니다.</li><li>1년 자료로 학습했습니다. 학습 범위(2024년 1~6월)를 넘는 큰 홍수에서는 오차가 커집니다. 2024년 7~9월 고유입 구간에서 LSTM의 평균 과소예측은 유지 기준선보다 컸습니다(위 표).</li><li>7월 1일 재학습 모형을 프로그램에 넣었으므로 2024년 7월 이후 예측은 학습 범위 밖, 그 이전은 학습 범위 안입니다.</li><li>예측은 운영을 명령하지 않습니다. AI 예측 참고 규칙은 예측 평균을 목표 저수량 유지 규칙의 유입 추정값으로 쓰는 것이며 최적화(MPC)나 강화학습이 아닙니다.</li><li>탁도, 취수심도, 하류 영향은 이 모형의 대상이 아닙니다.</li></ul>`);
  return html;
}
const unitChoices = {
  inflowCms: ["m3/s", "m3/day"], observedReleaseCms: ["m3/s", "m3/day"], observedTurbineCms: ["m3/s", "m3/day"],
  observedStorageMcm: ["MCM", "m3"], observedGenerationMWh: ["MWh", "kWh"], observedLevelM: ["m"], observedTurbidityNtu: ["NTU"],
};
function dataPage() {
  let html = pageHead("데이터 연결", "기관마다 다른 열 이름을 프로그램 항목에 연결하고 단위와 시간 간격을 확인합니다. 파일은 이 컴퓨터 안에서만 처리됩니다.") + statusRow();
  html += section("현재 자료", `<table class="form two"><tbody><tr><th>자료 이름</th><td>${escape(S.meta.name)} ${badge()}</td></tr><tr><th>구간</th><td>${S.rows.length}개 구간, ${fmt(S.config.timeStepHours, 2)}시간 간격, ${escape(date(S.rows[0].timestamp))} ~ ${escape(date(S.rows.at(-1).timestamp))}</td></tr><tr><th>출처</th><td>${escape(S.meta.source || "출처 미입력")}</td></tr></tbody></table><div class="toolbar"><button id="downloadTemplate" class="btn">${icon("csv")}입력 양식 CSV</button><button id="downloadDemo" class="btn">${icon("csv")}가상 자료 CSV</button><button id="exportInput" class="btn">${icon("csv")}현재 자료 내보내기</button><button id="restoreDemo" class="btn">${icon("reset")}가상 자료로 돌아가기</button></div>`);
  html += section("새 자료 불러오기", `<table class="form"><tbody><tr><th>파일</th><td><button id="chooseData" class="btn primary">${icon("open")}CSV 또는 Excel 파일 선택</button> <span class="muted">최대 20 MB, 20,000개 구간</span></td><th>CSV 문자 인코딩</th><td><select id="encoding"><option value="utf-8" ${S.encoding !== "euc-kr" ? "selected" : ""}>UTF-8</option><option value="euc-kr" ${S.encoding === "euc-kr" ? "selected" : ""}>EUC-KR (한글이 깨질 때)</option></select></td><th>시간대 없는 시각의 기준</th><td><select id="timezone"><option value="+09:00" ${S.timeZone !== "+00:00" ? "selected" : ""}>한국시간 (UTC+9)</option><option value="+00:00" ${S.timeZone === "+00:00" ? "selected" : ""}>UTC</option></select></td></tr></tbody></table>${S.draft ? draftMarkup() : ""}`, tip("필수 항목은 시각과 유입량입니다. 실제 운영을 비교하려면 방류 기록도 연결하세요. Excel 수식은 Excel에서 재계산하고 저장한 뒤 불러오세요. 자료를 적용해도 댐 제원이 자동으로 실제 값이 되지는 않으므로 다음으로 댐 운영 설정에서 제원과 초기 저수량을 확인하세요.", "불러오기 설명"));
  return html;
}
function draftMarkup() {
  const d = S.draft;
  return `<h3 class="sub">${escape(d.name)} ${tip("시각은 구간 시작 시각, 유입과 방류는 해당 구간 평균으로 준비해 주세요. 끝 시각 자료는 먼저 시작 시각으로 맞춰야 합니다. 수위와 저수량 등 선택 열은 원자료로 보관하며 현재 계산의 초기값이나 보정값으로 자동 적용하지 않습니다.", "자료 준비 규칙")}</h3><table class="form"><tbody><tr><th>시트</th><td><select id="sheet">${d.sheetNames.map((n) => `<option ${n === d.sheet ? "selected" : ""}>${escape(n)}</option>`).join("")}</select></td><th>열 이름이 있는 행</th><td><input id="headerRow" class="num" type="number" min="1" max="${Math.min(50, d.grid.length - 1)}" value="${d.headerRow + 1}"></td><th>자료 구분</th><td><select id="dataKind"><option value="unknown" ${d.dataKind === "unknown" ? "selected" : ""}>출처 미확인</option><option value="observed" ${d.dataKind === "observed" ? "selected" : ""}>기관 제공 관측자료</option><option value="synthetic" ${d.dataKind === "synthetic" ? "selected" : ""}>가상 또는 합성 자료</option></select></td></tr><tr><th>출처와 자료 설명</th><td colspan="5"><input id="dataSource" class="wide" type="text" placeholder="예: 제공 기관, 기간, 자료명, 취득일" value="${escape(d.source)}"></td></tr></tbody></table>
  <table class="grid"><thead><tr><th>프로그램 항목</th><th>항목 키</th><th>파일의 열</th><th>파일 단위</th></tr></thead><tbody>${FIELD_DEFS.map((f) => `<tr><td>${escape(f.label)} ${f.required ? '<span class="req">필수</span>' : ""}</td><td class="mono">${f.key}</td><td><select data-map="${f.key}" aria-label="${escape(f.label)} 열 연결"><option value="-1">연결 안 함</option>${d.headers.map((h, i) => `<option value="${i}" ${d.mapping[f.key] === i ? "selected" : ""}>${i + 1}. ${escape(h || "(빈 이름)")}</option>`).join("")}</select></td><td>${unitChoices[f.key] ? `<select data-unit="${f.key}" aria-label="${escape(f.label)} 단위">${unitChoices[f.key].map((u) => `<option ${d.units[f.key] === u ? "selected" : ""}>${u}</option>`).join("")}</select>` : '<span class="muted">시각 형식 자동 확인</span>'}</td></tr>`).join("")}</tbody></table>
  <div class="toolbar"><button id="validateData" class="btn primary">${icon("check")}자료 검사</button><button id="applyData" class="btn" ${d.validated && !d.validated.errors.length ? "" : "disabled"}>${icon("apply")}검사한 자료 적용</button></div><div id="qualityResult">${d.validated ? qualityHTML(d.validated) : ""}</div><details><summary>원본 미리보기 (처음 5행)</summary><div class="table-wrap"><table class="grid"><thead><tr>${d.headers.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${d.rawRows.slice(0, 5).map((row) => `<tr>${d.headers.map((_, i) => `<td>${escape(row[i])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}
function qualityHTML(q) {
  const statistics = Object.entries(q.summary.statistics || {}).map(([key, v]) => `<tr><td>${escape(v.label || key)}</td><td>${escape(v.unit)}</td><td>${v.count}</td><td>${fmt(v.min, 3)}</td><td>${fmt(v.max, 3)}</td><td>${fmt(v.mean, 3)}</td></tr>`).join("");
  return q.errors.length
    ? `<div class="errors"><strong>적용할 수 없습니다 (${q.errors.length}개 문제)</strong><ul>${q.errors.slice(0, 15).map((e) => `<li>${escape(e)}</li>`).join("")}</ul></div>`
    : `<div class="success"><strong>형식 검사 통과: ${q.summary.count}개 구간, ${fmt(q.summary.timestepHours, 3)}시간 간격</strong><p>형식 통과는 측정 정확도나 연구 타당성 검증을 뜻하지 않습니다.</p>${q.warnings.length ? `<ul>${q.warnings.slice(0, 12).map((w) => `<li>${escape(w)}</li>`).join("")}</ul>` : ""}</div>${statistics ? `<details open><summary>단위 변환 후 범위 확인 ${tip("원자료의 단위와 규모가 맞는지 확인하세요. 범위 표시는 측정 정확도 검증이 아닙니다.", "범위 확인 설명")}</summary><table class="grid numeric"><thead><tr><th>항목</th><th>내부 단위</th><th>값 수</th><th>최소</th><th>최대</th><th>평균</th></tr></thead><tbody>${statistics}</tbody></table></details>` : ""}`;
}
const configFields = [
  ["initialStorageMcm", "초기 저수량", "백만 m³"], ["minStorageMcm", "사용 가능한 최저 저수량", "백만 m³"], ["maxStorageMcm", "저수용량 상한", "백만 m³"],
  ["targetStorageMcm", "목표 저수량", "백만 m³"], ["floodStorageMcm", "홍수 관리용 저수량 기준", "백만 m³"], ["minLevelM", "최저 저수량의 수위", "m"],
  ["maxLevelM", "최대 저수량의 수위", "m"], ["tailwaterLevelM", "방수로 수위", "m"], ["maxTurbineCms", "최대 발전 방류량", "m³/s"],
  ["maxReleaseCms", "최대 조절 방류량", "m³/s"], ["minimumReleaseCms", "최소 방류 요구량", "m³/s"], ["fixedReleaseCms", "고정 방류량", "m³/s"],
  ["efficiency", "발전 효율", "0~1"], ["responseHours", "목표 저수량 조정 시간", "시간"], ["forecastHorizonHours", "AI 예측 참고 지평", "시간, 1~24"],
];
function settingsPage() {
  const fieldCells = configFields.map(([key, label, unit]) => `<th>${label}</th><td><input id="cfg-${key}" name="${key}" class="num" type="number" step="any" required value="${S.config[key]}"> <span class="unit">${unit}</span></td>`);
  const rows = [];
  for (let i = 0; i < fieldCells.length; i += 3) rows.push(`<tr>${fieldCells.slice(i, i + 3).join("")}${fieldCells.slice(i, i + 3).length < 3 ? `<th></th><td></td>`.repeat(3 - fieldCells.slice(i, i + 3).length) : ""}</tr>`);
  return pageHead("댐 운영 설정", "기본값은 가상의 연구용 댐입니다. 실제 자료를 적용하기 전에 제원을 교체하세요. 파일을 넣는 것만으로 가상 댐 설정이 실제 댐 설정으로 바뀌지 않습니다.") + statusRow()
    + `<form id="settingsForm">${section("프로젝트", `<table class="form"><tbody><tr><th>프로젝트 이름</th><td><input id="projectTitle" name="projectTitle" type="text" maxlength="80" value="${escape(S.title)}"></td><th>제원 출처</th><td><select id="configSource" name="configSource"><option ${S.configSource === "가상 제원" ? "selected" : ""}>가상 제원</option><option ${S.configSource === USER_CONFIG_LABEL ? "selected" : ""}>${USER_CONFIG_LABEL}</option></select></td><th>자료 시간 간격</th><td>${fmt(S.config.timeStepHours, 3)}시간 ${tip("자료를 적용할 때 자료의 간격으로 결정됩니다.", "시간 간격 설명")}</td></tr></tbody></table>`)}
    ${section("저수지와 발전 시설", `${Number.isFinite(S.rows[0].observedStorageMcm) ? `<div class="toolbar"><button type="button" id="useObservedInitial" class="btn small">첫 관측 저수량 ${fmt(S.rows[0].observedStorageMcm, 3)} 백만 m³를 초기값에 입력</button></div>` : ""}<table class="form"><tbody>${rows.join("")}</tbody></table><details><summary>수위 저수량 관계표 ${tip("한 줄에 저수량(백만 m³),수위(m)를 입력하세요. 두 값 모두 증가해야 하며 설정한 최저부터 최대 저수량까지 포함해야 합니다. 비워두면 선형 가정을 사용합니다.", "관계표 입력 규칙")}</summary><textarea id="curve" aria-label="수위 저수량 관계표" rows="6" placeholder="10,80&#10;60,105&#10;100,120">${escape((S.config.stageStorageCurve || []).map((r) => `${r.storageMcm},${r.levelM}`).join("\n"))}</textarea></details><div id="settingsErrors">${S.configErrors.length ? `<div class="errors">${S.configErrors.map(escape).join("<br>")}</div>` : ""}</div><div class="toolbar"><button type="submit" class="btn primary">${icon("save")}설정 저장 후 다시 계산</button><button type="button" id="defaultConfig" class="btn">${icon("reset")}가상 기본 제원 복원</button></div>`, tip("선형 수위 저수량 관계가 기본입니다. 실제 관계표가 있으면 아래 관계표 항목에서 교체하세요.", "제원 설명"))}</form>
    ${section("모델 범위", `<details><summary>현재 모델에 포함된 것과 포함되지 않은 것</summary><p class="note">포함: 유입과 방류 물수지, 저수용량 제한, 부족 시 방류 제한, 불가피한 넘침, 발전 방류 용량, 낙차와 효율 기반 발전량, 고정 방류와 목표 저수량 규칙과 AI 예측 참고 규칙 비교, 48시간 기록 기반 유입량 예측.</p><p class="note">추가 검증이나 구현이 필요한 것: 증발, 누수, 취수 등 별도 유출, 시간에 따라 변하는 효율과 방수로 수위, 실제 게이트 수리 특성, 하류 홍수 추적, 층별 탁수와 선택취수, 강우 예보 입력, 최적화(MPC)와 강화학습 운영, 실시간 관측 동기화. 현재 발전량은 가정에 따른 추정이며 탁도 열은 계산에 사용하지 않습니다.</p></details>`)}`;
}
function guidePage() {
  return pageHead("사용 안내", "지금은 가상 자료로 기능을 확인하고, 실제 자료가 오면 같은 흐름으로 연결합니다.")
    + `<div class="brand-band"><img src="assets/brand/twin-logo.png" alt="TWIN, Turbid Water INtelligence" width="288" height="89"><div><strong>TWIN Reservoir Lab ${VERSION}</strong><span>팀 TWIN (Turbid Water INtelligence)의 연구용 댐 운영 시뮬레이터이자 디지털 트윈 시제품. 가상 자료와 2024년 소양강댐 공개자료로 학습한 유입량 예측기를 포함하며, 실제 댐 제어와 연결되지 않습니다.</span></div></div>`
    + section("순서", `<table class="form two"><tbody><tr><th>1. 가상 시나리오 체험</th><td>운영 실험실에서 재생을 누르고 방류량과 목표 저수량을 바꿔 보세요. 다시 계산하면 두 운영안이 같은 조건에서 비교됩니다.</td></tr><tr><th>2. 실제 파일 연결</th><td>데이터 연결에서 CSV나 Excel을 고르고 시각과 유입량 등의 열과 단위를 연결하세요. 오류를 해결한 뒤 적용합니다.</td></tr><tr><th>3. AI 예측</th><td>AI 예측 화면에서 예측 생성을 누르면 불러온 자료의 모든 구간에 1~24시간 예측이 발행됩니다. 제안 운영안에 적용하면 예측을 참고하는 운영안과 기준 운영안을 비교할 수 있습니다.</td></tr><tr><th>4. 제원 교체와 검증</th><td>댐 운영 설정에서 실제 제원과 초기 저수량을 입력하세요. 별도 기간의 실측 자료로 계산을 검증한 후 연구 결과로 사용합니다.</td></tr></tbody></table>`)
    + section("이 프로그램으로 할 수 있는 일", `<ul class="plain"><li>합성 자료 재생과 방류 조건 비교</li><li>소양강댐 외형 참고 3D 장면, 자유로운 시점 이동, 물 흐름 표시, AI 예상 수위 면, PNG 저장</li><li>CSV와 Excel 시트 선택, 열 연결, 단위 변환, 누락과 중복과 시간 간격 검사</li><li>LSTM 또는 Transformer 유입 예측을 프로그램 안에서 계산하고 실측과 비교 (십자선 그래프, 지평별 오차, 24시간 예측 범위)</li><li>시설 제원과 수위 저수량 관계표 변경</li><li>프로젝트 JSON 저장과 복원, 계산 결과와 예측 CSV 내보내기</li></ul><h3 class="sub">아직 연결하지 않은 기능</h3><p>층별 탁수 모델, 실시간 댐 연결, 실제 수문 제어, 최적화(MPC)와 강화학습 운영은 없습니다. 현재의 제안안은 설명 가능한 규칙이며, AI는 유입량 예측 층만 담당합니다. 이 프로그램은 과거 데이터 기반 시뮬레이터이자 디지털 트윈 시제품입니다.</p>`)
    + section("자료를 준비할 때", `<ul class="plain"><li>시각은 구간 시작, 유입과 방류량은 그 구간의 평균값으로 맞춥니다. 시간대 없는 시각은 선택한 시간대(기본 한국시간)로 읽습니다.</li><li>시간 간격은 일정해야 합니다. 빠진 구간을 임의로 0으로 채우거나 긴 간격 전체를 같은 유량으로 계산하지 않습니다. AI 예측은 1시간 간격 자료에서만 동작합니다.</li><li>필수 항목은 시각과 유입량입니다. 실제 방류 재현에는 방류량, 발전량 해석에는 발전용 방류와 시설 제원이 중요합니다.</li><li>기관 파일에 제원이나 관측값이 있다고 자동 보정되는 것은 아닙니다. 초기 저수량을 직접 설정하거나 첫 관측 저수량 입력 버튼을 사용합니다.</li><li>선택 항목의 빈칸은 누락으로 남습니다. 탁도 NTU를 부유물질 mg/L로 바꾸지 않습니다.</li><li>결과 CSV에는 자료 구분과 출처가 포함됩니다. 재현에 필요한 전체 설정과 입력자료는 프로젝트 JSON을 함께 저장하세요.</li></ul><div class="toolbar"><button id="downloadTemplate" class="btn">${icon("csv")}입력 양식 CSV 받기</button></div>`)
    + section("결과를 해석할 때", `<p>발전량이 높아도 종료 저수량이 적거나 설정 제약을 더 많이 위반했다면 좋은 운영이라고 단정할 수 없습니다. 같은 자료와 초기 상태와 제약으로 비교하고, 실제 관측과의 차이는 별도로 검증하세요.</p><p class="note">3D 장면은 소양강댐의 외형을 참고한 시각화이며 측량 도면이나 실제 지형을 정밀 복원한 모델이 아닙니다. 드래그, 휠, 우클릭으로 시점을 바꾸고, 시점 목록이나 자동 둘러보기를 사용할 수 있습니다. 물결과 방류는 계산된 유량과 수위를 전달하는 시각효과이며 CFD 해석이 아닙니다. 파일은 외부로 전송되지 않으며 자동 저장되지 않습니다. 작업을 보관하려면 프로젝트 저장을 눌러 주세요.</p>`);
}

// ----------------------------------------------------------------------------- render and bindings
function render() {
  const keepScene = S.tab === "dashboard" && !S.errors.length && viewerState.root?.isConnected && $("dashboardBefore") && $("dashboardAfter") && $("dashboardCharts");
  if (keepScene) {
    const next = document.createElement("template");
    next.innerHTML = dashboard();
    $("dashboardBefore").replaceWith(next.content.querySelector("#dashboardBefore"));
    $("dashboardAfter").replaceWith(next.content.querySelector("#dashboardAfter"));
    redrawChartMarkers();
    if (charts.level && S.proposal) {
      // refresh only the projected trajectory series of the level chart
      const d = dashboardChartData();
      const map = projectionMap(S.index);
      charts.level.setData([d.levelX, d.levelBase, d.levelProposal, d.levelX.map((t) => (map ? map.get(t) ?? null : null))]);
    }
    document.querySelector(".gnb-project").innerHTML = `${icon("doc")}${escape(S.title)}`;
    renderStatusbar();
  } else {
    disposeViewer();
    destroyAllCharts();
    document.querySelector("#app").innerHTML = header();
    $("view").innerHTML = { dashboard, ai: aiPage, data: dataPage, settings: settingsPage, guide: guidePage }[S.tab]();
    document.querySelector(".gnb-title").textContent = PAGE_TITLES[S.tab];
  }
  bind();
  if (S.tab === "dashboard" && !S.errors.length) {
    mountViewer();
    if (!keepScene) buildDashboardCharts();
  }
  if (S.tab === "ai") buildAiCharts();
}
function markDirty() {
  S.dirty = true;
  stop();
  if ($("dirtyText")) $("dirtyText").textContent = "변경사항이 있습니다. 다시 계산해 주세요.";
  if ($("play")) $("play").textContent = "재생";
  updateScene();
  renderStatusbar();
}
function invalidateDraft() {
  if (S.draft) S.draft.validated = null;
  if ($("applyData")) $("applyData").disabled = true;
  if ($("qualityResult")) $("qualityResult").innerHTML = '<p class="note">연결 설정이 바뀌었습니다. 자료 검사를 다시 눌러 주세요.</p>';
}
function updateDraft() {
  const d = S.draft;
  d.headers = d.grid[d.headerRow].map((x) => String(x ?? ""));
  d.rawRows = d.grid.slice(d.headerRow + 1);
  d.mapping = guessMapping(d.headers);
  d.validated = null;
}
function replaceRows(rows, meta) {
  S.rows = rows;
  S.meta = meta;
  invalidateForecasts();
  if (S.proposalPolicy === "forecast") S.proposalPolicy = "rule";
}
function bind() {
  document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { stop(); S.tab = b.dataset.tab; render(); }));
  document.querySelectorAll("[data-folder]").forEach((b) => (b.onclick = () => { S.navOpen[b.dataset.folder] = !S.navOpen[b.dataset.folder]; b.parentElement.classList.toggle("open", S.navOpen[b.dataset.folder]); b.setAttribute("aria-expanded", String(S.navOpen[b.dataset.folder])); }));
  $("saveProject").onclick = saveProject;
  $("loadProject").onclick = () => $("projectFile").click();
  const on = (id, event, fn) => { if ($(id)) $(id).addEventListener(event, fn); };
  on("run", "click", () => {
    run();
    render();
    toast(S.errors.length ? "설정을 확인해 주세요." : "같은 입력 조건으로 두 운영안을 다시 계산했습니다.");
  });
  on("basePolicy", "change", (e) => { S.basePolicy = e.target.value; markDirty(); });
  on("proposalPolicy", "change", (e) => {
    S.proposalPolicy = e.target.value;
    if ($("forecastHorizon")) $("forecastHorizon").disabled = S.proposalPolicy !== "forecast";
    if (S.proposalPolicy === "forecast" && !AI.forecasts) toast("AI 예측이 없습니다. AI 예측 화면에서 예측을 생성한 뒤 다시 계산하세요.");
    markDirty();
  });
  on("forecastHorizon", "change", (e) => { S.config.forecastHorizonHours = Number(e.target.value); markDirty(); });
  on("fixedRelease", "input", (e) => { S.config.fixedReleaseCms = Number(e.target.value); markDirty(); });
  on("targetStorage", "input", (e) => { S.config.targetStorageMcm = Number(e.target.value); markDirty(); });
  on("chartHorizon", "change", (e) => { AI.chartHorizon = Number(e.target.value); buildDashboardCharts(); });
  on("play", "click", togglePlayback);
  on("speed", "change", (e) => { S.speed = Number(e.target.value); stop(); render(); });
  on("timeline", "input", (e) => { stop(); setRangeFill(e.target); S.index = Number(e.target.value); render(); });
  on("peakReleaseTime", "click", () => {
    const series = S.proposal?.series;
    if (!series?.length) return;
    stop();
    S.index = series.reduce((largest, row, index) => (row.releaseCms > series[largest].releaseCms ? index : largest), 0);
    render();
    toast(`방류량이 가장 큰 구간으로 이동했습니다 (${fmt(series[S.index].releaseCms, 0)} m³/s${S.dirty ? ", 변경 전 계산 결과" : ""})`);
  });
  on("resetTime", "click", () => { stop(); S.index = 0; render(); });
  on("aiCompute", "click", async () => {
    $("aiCompute").disabled = true;
    const ok = await computeForecasts();
    render();
    toast(ok ? `${AI.issued}개 구간에 예측을 발행했습니다.` : AI.reason || "예측을 만들지 못했습니다.");
  });
  on("aiHorizon", "change", (e) => { AI.chartHorizon = Number(e.target.value); buildAiCharts(); });
  const setAiIndex = (value) => {
    AI.index = Math.max(0, Math.min(S.rows.length - 1, value));
    if ($("aiFanTitle") && S.proposal) $("aiFanTitle").textContent = `(${date(S.proposal.series[AI.index].endTimestamp)} 기준)`;
    if ($("aiIndexLabel")) $("aiIndexLabel").textContent = `${AI.index + 1} / ${S.rows.length}`;
    if ($("aiTimeline")) { $("aiTimeline").value = AI.index; setRangeFill($("aiTimeline")); }
    buildAiCharts();
  };
  on("aiPrev", "click", () => setAiIndex(aiIndex() - 1));
  on("aiNext", "click", () => setAiIndex(aiIndex() + 1));
  on("aiTimeline", "input", (e) => setAiIndex(Number(e.target.value)));
  on("aiExport", "click", exportForecasts);
  on("aiUseInPolicy", "click", () => {
    if (!AI.forecasts) return;
    S.proposalPolicy = "forecast";
    run();
    S.tab = "dashboard";
    render();
    toast(S.errors.length ? "설정을 확인해 주세요." : "제안 운영안을 AI 예측 참고 규칙으로 바꾸고 다시 계산했습니다.");
  });
  on("chooseData", "click", () => $("dataFile").click());
  on("encoding", "change", (e) => { S.encoding = e.target.value; toast("선택한 인코딩으로 읽으려면 파일을 다시 선택하세요."); });
  on("timezone", "change", (e) => { S.timeZone = e.target.value; invalidateDraft(); });
  on("sheet", "change", (e) => { S.draft.sheet = e.target.value; S.draft.grid = S.draft.grids[e.target.value]; S.draft.headerRow = 0; updateDraft(); render(); });
  on("headerRow", "change", (e) => { S.draft.headerRow = Math.max(0, Math.min(S.draft.grid.length - 2, Math.floor(Number(e.target.value) || 1) - 1)); updateDraft(); render(); });
  on("dataKind", "change", (e) => { S.draft.dataKind = e.target.value; invalidateDraft(); });
  on("dataSource", "input", (e) => { S.draft.source = e.target.value; invalidateDraft(); });
  document.querySelectorAll("[data-map]").forEach((el) => (el.onchange = () => { S.draft.mapping[el.dataset.map] = Number(el.value); invalidateDraft(); }));
  document.querySelectorAll("[data-unit]").forEach((el) => (el.onchange = () => { S.draft.units[el.dataset.unit] = el.value; invalidateDraft(); }));
  on("validateData", "click", () => {
    const d = S.draft;
    d.validated = normalizeRows(d.rawRows, d.headers, d.mapping, { units: d.units, timeZone: S.timeZone || "+09:00", dataKind: d.dataKind });
    if (d.validated.summary.dataKind === "observed" && !d.source.trim()) d.validated.errors.push("기관 제공 관측자료는 출처와 자료 설명을 입력해 주세요.");
    render();
  });
  on("applyData", "click", () => {
    const d = S.draft, q = d?.validated;
    if (!q || q.errors.length) return;
    replaceRows(q.rows, {
      name: d.name, source: d.source || "출처 미입력", dataKind: q.summary.dataKind, importedAt: new Date().toISOString(),
      timeZone: S.timeZone || "+09:00", timestepHours: q.summary.timestepHours,
      importOptions: { headers: d.headers, mapping: d.mapping, units: d.units, headerRow: d.headerRow + 1, sheet: d.sheet, encoding: S.encoding || "utf-8", timestampMeaning: "interval-start" },
    });
    S.quality = q.summary;
    S.config.timeStepHours = q.summary.timestepHours;
    S.basePolicy = S.rows.every((r) => Number.isFinite(r.observedReleaseCms)) ? "recorded" : "fixed";
    S.index = 0;
    S.draft = null;
    run();
    S.tab = "dashboard";
    render();
    toast("자료가 적용되었습니다. 다음으로 댐 제원과 초기 저수량을 확인하세요.");
  });
  on("restoreDemo", "click", () => {
    stop();
    const fresh = createDemoData();
    replaceRows(fresh.rows, { ...fresh.meta, name: "여름 홍수 7일 가상 시나리오", source: "프로그램에서 생성한 합성 자료", dataKind: "synthetic" });
    S.config = { ...DEFAULT_CONFIG };
    S.configSource = "가상 제원";
    S.basePolicy = "fixed";
    S.proposalPolicy = "rule";
    S.index = 0;
    S.draft = null;
    run();
    render();
    toast("가상 자료와 기본 제원으로 돌아왔습니다.");
  });
  on("downloadTemplate", "click", () => download("TWIN_입력양식.csv", createTemplateCSV(), "text/csv;charset=utf-8"));
  on("downloadDemo", "click", () => download("TWIN_SYNTHETIC_가상자료.csv", inputCSV(createDemoData().rows, { dataKind: "synthetic", source: "프로그램에서 생성한 합성 자료" }, "가상 제원"), "text/csv;charset=utf-8"));
  on("exportInput", "click", () => download(`TWIN_${S.meta.dataKind}_입력자료.csv`, inputCSV(S.rows, S.meta, S.configSource), "text/csv;charset=utf-8"));
  on("exportResults", "click", exportResults);
  on("defaultConfig", "click", () => { S.config = { ...DEFAULT_CONFIG, timeStepHours: S.config.timeStepHours }; S.configSource = "가상 제원"; S.configErrors = []; run(); render(); });
  on("useObservedInitial", "click", () => { $("cfg-initialStorageMcm").value = S.rows[0].observedStorageMcm; toast("첫 구간 시작 관측값을 입력했습니다. 제원을 확인한 뒤 설정을 저장하세요."); });
  on("settingsForm", "submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const c = { ...S.config };
    configFields.forEach(([k]) => (c[k] = Number(fd.get(k))));
    try {
      const curve = $("curve").value.trim();
      if (curve) {
        c.stageStorageCurve = curve.split(/\n+/).map((line, i) => {
          const cells = line.trim().split(/[,\t]/);
          const v = cells.map(Number);
          if (cells.some((x) => !x.trim()) || v.length !== 2 || !v.every(Number.isFinite)) throw new Error(`수위 저수량 관계표 ${i + 1}행을 확인하세요.`);
          return { storageMcm: v[0], levelM: v[1] };
        });
      } else delete c.stageStorageCurve;
      S.configErrors = validateConfig(c);
      if (S.configErrors.length) { $("settingsErrors").innerHTML = `<div class="errors">${S.configErrors.map(escape).join("<br>")}</div>`; return; }
      S.config = c;
      S.title = String(fd.get("projectTitle")).trim() || "TWIN 연구용 댐";
      S.configSource = String(fd.get("configSource"));
      run();
      render();
      toast("제원을 저장하고 다시 계산했습니다.");
    } catch (err) {
      S.configErrors = [err.message];
      $("settingsErrors").innerHTML = `<div class="errors">${escape(err.message)}</div>`;
    }
  });
}
function inputCSV(rows, meta, configSource) {
  return toCSV(rows.map((r) => ({ ...r, sourceKind: meta.dataKind, source: meta.source, configStatus: configSource })), [...FIELD_DEFS.map((f) => f.key), "sourceKind", "source", "configStatus"]);
}
function saveProject() {
  if (S.dirty) { toast("다시 계산한 뒤 저장해 주세요."); return; }
  const p = {
    schema: "twin-reservoir-project", version: 1, appVersion: VERSION, savedAt: new Date().toISOString(), title: S.title, meta: S.meta, config: S.config,
    configSource: S.configSource, rows: S.rows, basePolicy: S.basePolicy, proposalPolicy: S.proposalPolicy, index: S.index,
  };
  download(`TWIN_${S.meta.dataKind}_프로젝트.json`, JSON.stringify(p, null, 2), "application/json");
  toast("자료와 설정을 프로젝트 파일로 저장했습니다.");
}
function exportResults() {
  if (S.dirty) { toast("다시 계산한 뒤 내보내 주세요."); return; }
  const fields = ["sourceKind", "source", "configStatus", "modelVersion", "policy", "timestamp", "endTimestamp", "startStorageMcm", "startLevelM", "requestedReleaseCms", "inflowEstimateCms", "forecastUsed",
    "controlledReleaseCms", "inflowCms", "releaseCms", "turbineCms", "spillCms", "overflowCms", "storageMcm", "levelM", "powerMW", "energyMWh", "shortageCms", "floodExceeded", "releaseExceeded", "massBalanceResidualMcm",
    ...FIELD_DEFS.filter((f) => f.key.startsWith("observed")).map((f) => f.key)];
  const rows = [...S.base.series.map((r) => ({ ...r, policy: "baseline_" + S.basePolicy })), ...S.proposal.series.map((r) => ({ ...r, policy: "proposal_" + S.proposalPolicy }))]
    .map((r) => ({ ...r, sourceKind: S.meta.dataKind, source: S.meta.source, configStatus: S.configSource, modelVersion: VERSION }));
  download(`TWIN_${S.meta.dataKind}_비교결과.csv`, toCSV(rows, fields), "text/csv;charset=utf-8");
  toast("비교 결과를 내보냈습니다. 재현을 위해 프로젝트도 함께 저장하세요.");
}
function exportForecasts() {
  if (!AI.forecasts) return;
  const horizons = AI.model.horizons;
  const header = ["issue_timestamp", "issue_inflow_cms", ...horizons.map((h) => `pred_h${String(h).padStart(2, "0")}_cms`), "model", "model_version"];
  const lines = [header.join(",")];
  S.rows.forEach((row, i) => {
    const f = AI.forecasts[i];
    if (!f) return;
    lines.push([row.timestamp, row.inflowCms, ...Array.from(f, (v) => v.toFixed(3)), AI.model.architecture, JSON.stringify(AI.model.version || "")].join(","));
  });
  download(`TWIN_${S.meta.dataKind}_AI예측.csv`, "﻿" + lines.join("\n"), "text/csv;charset=utf-8");
  toast("AI 예측을 CSV로 내보냈습니다. 발행 시각은 각 구간의 시작이며 예측은 그 구간이 끝난 시점 기준입니다.");
}
$("dataFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast("20MB 이하 파일을 선택해 주세요."); return; }
  try {
    let grids = {};
    if (/\.csv$/i.test(file.name)) {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder(S.encoding || "utf-8", { fatal: true }).decode(bytes);
      const raw = parseCSV(text);
      grids.CSV = [raw.headers, ...raw.rows];
    } else if (/\.xlsx?$/i.test(file.name)) {
      if (!window.XLSX) throw new Error("Excel 읽기 도구를 불러오지 못했습니다. assets 폴더를 확인해 주세요.");
      const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false, cellNF: true });
      grids = workbookToGrids(wb, window.XLSX);
    } else throw new Error("CSV, XLSX, XLS 파일을 선택해 주세요.");
    const names = Object.keys(grids);
    if (!names.length || grids[names[0]].length < 3) throw new Error("열 이름과 2개 이상의 자료 행이 필요합니다.");
    if (grids[names[0]].length > 20051) throw new Error("20,000개 구간 이하 자료를 선택하세요.");
    S.draft = {
      name: file.name, grids, sheetNames: names, sheet: names[0], grid: grids[names[0]], headerRow: 0, headers: [], rawRows: [], mapping: {},
      units: Object.fromEntries(Object.entries(unitChoices).map(([k, v]) => [k, v[0]])),
      dataKind: /synthetic|가상/i.test(file.name) ? "synthetic" : "unknown", source: "", validated: null,
    };
    updateDraft();
    S.tab = "data";
    render();
    toast("파일을 읽었습니다. 열과 단위를 확인한 뒤 자료 검사를 눌러 주세요.");
  } catch (err) {
    toast("파일을 읽지 못했습니다: " + err.message);
  }
});
$("projectFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) { toast("프로젝트 파일은 40MB 이하여야 합니다."); return; }
  try {
    const p = JSON.parse(await file.text());
    if (p.schema !== "twin-reservoir-project" || p.version !== 1 || !Array.isArray(p.rows) || !p.meta || !p.config) throw new Error("지원하지 않는 프로젝트 형식입니다.");
    if (!["synthetic", "observed", "unknown"].includes(p.meta.dataKind)) throw new Error("자료 구분이 올바르지 않습니다.");
    if (p.meta.dataKind === "observed" && (typeof p.meta.source !== "string" || !p.meta.source.trim())) throw new Error("관측자료의 출처 설명이 없습니다.");
    const headers = FIELD_DEFS.map((f) => f.key);
    const q = normalizeRows(p.rows.map((r) => headers.map((k) => r[k] ?? "")), headers, guessMapping(headers), { dataKind: p.meta.dataKind, timeZone: "+00:00" });
    if (q.errors.length) throw new Error(q.errors[0]);
    const loadedConfig = { ...DEFAULT_CONFIG, ...p.config };
    const issues = validateConfig(loadedConfig);
    if (issues.length) throw new Error(issues[0]);
    if (Math.abs(q.summary.timestepHours - loadedConfig.timeStepHours) > 1e-6) throw new Error("자료 시간 간격과 설정이 다릅니다.");
    if (!["fixed", "recorded", "rule"].includes(p.basePolicy) || !["fixed", "rule", "forecast"].includes(p.proposalPolicy)) throw new Error("운영안 형식이 올바르지 않습니다.");
    const proposalPolicy = p.proposalPolicy === "forecast" ? "rule" : p.proposalPolicy;
    const base = simulate(q.rows, loadedConfig, p.basePolicy);
    const proposal = simulate(q.rows, loadedConfig, proposalPolicy);
    stop();
    invalidateForecasts();
    Object.assign(S, {
      rows: q.rows, meta: p.meta, config: loadedConfig, title: String(p.title || "TWIN 연구용 댐").slice(0, 80),
      configSource: p.configSource === "가상 제원" ? "가상 제원" : USER_CONFIG_LABEL, basePolicy: p.basePolicy, proposalPolicy,
      index: Math.max(0, Math.min(q.rows.length - 1, Math.floor(Number(p.index) || 0))), base, proposal, dirty: false, draft: null, errors: [], tab: "dashboard",
    });
    render();
    toast(p.proposalPolicy === "forecast" ? "프로젝트를 복원했습니다. AI 예측 참고 운영안은 예측을 다시 생성한 뒤 적용할 수 있습니다." : "프로젝트의 자료와 설정을 복원했습니다.");
  } catch (err) {
    toast("프로젝트를 열지 못했습니다: " + err.message);
  }
});
document.addEventListener("click", (event) => {
  const button = event.target.closest(".info");
  document.querySelectorAll(".info.open").forEach((item) => { if (item !== button) item.classList.remove("open"); });
  if (button) button.classList.toggle("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.querySelectorAll(".info.open").forEach((item) => item.classList.remove("open"));
});
document.addEventListener("fullscreenchange", syncSceneFullscreen);
document.addEventListener("keydown", handleSceneKeys);
window.addEventListener("pagehide", disposeViewer);
window.addEventListener("pageshow", (event) => { if (event.persisted) render(); });
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [key, chart] of Object.entries(charts)) {
      const container = chart.root.parentElement;
      if (container) chart.setSize({ width: Math.max(320, container.clientWidth - 2), height: chart.height });
    }
  }, 150);
});
run();
render();
loadForecaster();
