/**
 * 교육과 연구용 단일 저수지 물수지 모델. 실제 시설의 안전 판단에 사용할 수 없다.
 * timestamp는 구간 시작, 유입과 방류는 구간 평균, 계산 저장량과 수위는 구간 끝 값이다.
 * observedStorageMcm/observedLevelM은 timestamp 시점(구간 시작)의 관측값이다.
 * 관측 저장량은 비교값이며 시뮬레이션 상태에 자동 동화하지 않는다.
 */
export const DEFAULT_CONFIG = Object.freeze({
  initialStorageMcm: 60,
  minStorageMcm: 10,
  maxStorageMcm: 100,
  targetStorageMcm: 65,
  floodStorageMcm: 85,
  minLevelM: 80,
  maxLevelM: 120,
  tailwaterLevelM: 65,
  maxTurbineCms: 80,
  maxReleaseCms: 300,
  minimumReleaseCms: 10,
  fixedReleaseCms: 40,
  efficiency: 0.9,
  timeStepHours: 1,
  responseHours: 12,
  forecastHorizonHours: 6,
});

const FIELD_LABELS = {
  initialStorageMcm: '초기 저수량', minStorageMcm: '최소 저수량',
  maxStorageMcm: '최대 저수량', targetStorageMcm: '목표 저수량',
  floodStorageMcm: '주의 저수량', minLevelM: '최소 수위', maxLevelM: '최대 수위',
  tailwaterLevelM: '하류 수위', maxTurbineCms: '최대 발전 유량',
  maxReleaseCms: '최대 계획 방류량', minimumReleaseCms: '최소 요구 방류량',
  fixedReleaseCms: '고정 방류량', efficiency: '발전 효율',
  timeStepHours: '자료 시간 간격', responseHours: '수위 회복 시간',
  forecastHorizonHours: '예측 참고 지평',
};

export function validateConfig(config = {}) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return ['설정은 항목별 숫자로 구성된 객체여야 합니다.'];
  }
  const c = { ...DEFAULT_CONFIG, ...config };
  const errors = [];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    if (!Number.isFinite(c[key])) errors.push(`${label} 값은 유한한 숫자여야 합니다.`);
  }
  if (errors.length) return errors;
  for (const key of ['initialStorageMcm', 'minStorageMcm', 'targetStorageMcm',
    'floodStorageMcm', 'maxStorageMcm', 'maxTurbineCms', 'maxReleaseCms',
    'minimumReleaseCms', 'fixedReleaseCms']) {
    if (c[key] < 0) errors.push(`${FIELD_LABELS[key]} 값은 0 이상이어야 합니다.`);
  }
  if (c.minStorageMcm >= c.maxStorageMcm) errors.push('최대 저수량은 최소 저수량보다 커야 합니다.');
  for (const key of ['initialStorageMcm', 'targetStorageMcm', 'floodStorageMcm']) {
    if (c[key] < c.minStorageMcm || c[key] > c.maxStorageMcm) {
      errors.push(`${FIELD_LABELS[key]}은 최소와 최대 저수량 범위 안이어야 합니다.`);
    }
  }
  if (c.targetStorageMcm > c.floodStorageMcm) errors.push('목표 저수량은 주의 저수량 이하여야 합니다.');
  if (c.minLevelM >= c.maxLevelM) errors.push('최대 수위는 최소 수위보다 높아야 합니다.');
  if (c.maxTurbineCms > c.maxReleaseCms) errors.push('최대 발전 유량은 최대 계획 방류량 이하여야 합니다.');
  if (c.minimumReleaseCms > c.maxReleaseCms) errors.push('최소 요구 방류량은 최대 계획 방류량 이하여야 합니다.');
  if (c.fixedReleaseCms > c.maxReleaseCms) errors.push('고정 방류량은 최대 계획 방류량 이하여야 합니다.');
  if (c.efficiency <= 0 || c.efficiency > 1) errors.push('발전 효율은 0 초과 1 이하여야 합니다.');
  if (c.timeStepHours <= 0) errors.push('자료 시간 간격은 0보다 커야 합니다.');
  if (c.responseHours <= 0) errors.push('수위 회복 시간은 0보다 커야 합니다.');
  if (!Number.isInteger(c.forecastHorizonHours) || c.forecastHorizonHours < 1 || c.forecastHorizonHours > 24) {
    errors.push('예측 참고 지평은 1 이상 24 이하의 정수(시간)여야 합니다.');
  }
  if (!Number.isFinite(c.timeStepHours * 3600) || c.timeStepHours * 3600 / 1e6 === 0) {
    errors.push('자료 시간 간격이 계산 가능한 숫자 범위를 벗어났습니다.');
  }
  if (!Number.isFinite(c.responseHours * 3600)) errors.push('수위 회복 시간이 계산 가능한 숫자 범위를 벗어났습니다.');
  if (c.stageStorageCurve != null) {
    const curve = c.stageStorageCurve;
    if (!Array.isArray(curve) || curve.length < 2) {
      errors.push('수위 저수량 표에는 최소 두 점이 필요합니다.');
    } else {
      let pointsValid = true;
      curve.forEach((point, index) => {
        if (!point || !Number.isFinite(point.storageMcm) || !Number.isFinite(point.levelM)) {
          errors.push(`수위 저수량 표 ${index + 1}행의 저수량과 수위는 유한한 숫자여야 합니다.`);
          pointsValid = false;
        }
      });
      if (pointsValid) {
        for (let i = 1; i < curve.length; i++) {
          if (curve[i].storageMcm <= curve[i - 1].storageMcm || curve[i].levelM <= curve[i - 1].levelM) {
            errors.push('수위 저수량 표는 저수량과 수위가 모두 엄격하게 증가해야 합니다.');
            break;
          }
        }
        if (curve[0].storageMcm > c.minStorageMcm || curve.at(-1).storageMcm < c.maxStorageMcm) {
          errors.push('수위 저수량 표는 설정된 최소부터 최대 저수량까지의 전체 범위를 포함해야 합니다.');
        }
      }
    }
  }
  return errors;
}

function levelForStorage(storage, c) {
  const curve = c.stageStorageCurve;
  if (!curve) {
    return c.minLevelM + (storage - c.minStorageMcm) / (c.maxStorageMcm - c.minStorageMcm)
      * (c.maxLevelM - c.minLevelM);
  }
  for (let i = 1; i < curve.length; i++) {
    if (storage <= curve[i].storageMcm) {
      const lower = curve[i - 1];
      const upper = curve[i];
      const fraction = (storage - lower.storageMcm) / (upper.storageMcm - lower.storageMcm);
      return lower.levelM + fraction * (upper.levelM - lower.levelM);
    }
  }
  return curve.at(-1).levelM;
}

function validateRows(rows, policy) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('계산할 자료가 한 행 이상 필요합니다.');
  const nonnegative = ['observedReleaseCms', 'observedTurbineCms', 'observedStorageMcm',
    'observedGenerationMWh', 'observedTurbidityNtu'];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') throw new Error(`${i + 1}행이 올바른 자료가 아닙니다.`);
    if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) {
      throw new Error(`${i + 1}행의 시각을 확인하세요.`);
    }
    if (!Number.isFinite(row.inflowCms) || row.inflowCms < 0) {
      throw new Error(`${i + 1}행의 유입량은 0 이상의 유한한 숫자여야 합니다.`);
    }
    for (const key of nonnegative) {
      if (row[key] != null && (!Number.isFinite(row[key]) || row[key] < 0)) {
        throw new Error(`${i + 1}행의 ${key} 값은 0 이상의 유한한 숫자여야 합니다.`);
      }
    }
    if (row.observedLevelM != null && !Number.isFinite(row.observedLevelM)) {
      throw new Error(`${i + 1}행의 관측 수위는 유한한 숫자여야 합니다.`);
    }
    if (policy === 'recorded' && !Number.isFinite(row.observedReleaseCms)) {
      throw new Error(`관측 방류 재생에는 모든 행의 관측 총방류량이 필요합니다. (${i + 1}행 누락)`);
    }
    if (row.observedTurbineCms != null && row.observedReleaseCms != null
        && row.observedTurbineCms > row.observedReleaseCms + 1e-9) {
      throw new Error(`${i + 1}행의 관측 발전 유량이 총방류량보다 큽니다.`);
    }
  }
}

/**
 * fixed: 최소 요구량 이상인 고정 방류, rule: 직전 구간 유입량 + 저장량 목표 피드백.
 * forecast: 직전 구간 유입량 대신 직전 구간에 발행된 AI 예측의 다음 forecastHorizonHours 시간 평균 유입량을 쓰는 같은 규칙.
 *   options.forecast[j] 는 j행이 끝난 시점에 발행된 예측(다음 1, 2, ... 시간의 유입량 배열)이며 없으면 직전 구간 유입량으로 돌아간다.
 * recorded: 관측 방류 계획을 재생한다. 관측 수위와 저수량을 강제로 맞추지는 않는다.
 * overflowCms는 최대 저수량 초과분을 물수지상 방류로 처리한 값이며 실제 여수로 능력이 아니다.
 */
export function simulate(rows, config = {}, policy = 'rule', options = {}) {
  const issues = validateConfig(config);
  if (issues.length) throw new Error(issues.join('\n'));
  if (!['fixed', 'rule', 'forecast', 'recorded'].includes(policy)) throw new Error('알 수 없는 운영 방식입니다.');
  validateRows(rows, policy);
  const forecastTable = Array.isArray(options.forecast) ? options.forecast : null;
  if (policy === 'forecast' && (!forecastTable || forecastTable.length !== rows.length)) {
    throw new Error('예측 참고 운영안에는 행마다 정렬된 예측 표가 필요합니다.');
  }
  const c = { ...DEFAULT_CONFIG, ...config };
  const seconds = c.timeStepHours * 3600;
  const flowToMcm = seconds / 1e6;
  const warnings = new Set([
    '연구용 단일 저수지 모형입니다. 증발, 누수, 하천 전파, 수문 동역학, 발전기별 효율은 포함하지 않습니다.',
    '각 행은 설정된 시간 간격의 구간입니다. 시각, 관측 저수량, 수위는 구간 시작, 유입과 방류는 구간 평균, 계산 저수량과 수위는 구간 끝 값입니다.',
    '주의 저수량 초과 시간은 구간 시작 또는 끝 저수량이 기준을 넘은 구간의 합이며 실제 침수나 안전 판정이 아닙니다.',
  ]);
  if (!c.stageStorageCurve) warnings.add('수위 저수량 관계에 선형 가정을 사용했습니다. 실제 적용 전 공식 관계표로 교체하세요.');
  if (policy !== 'recorded') warnings.add('계획 방류는 발전 용량 이내에서 발전에 우선 사용하고 나머지는 비발전 방류로 계산합니다. 실제 발전기와 수문 배분을 재현한 것은 아닙니다.');
  if (policy === 'rule') warnings.add('목표 추종은 직전 구간 유입량을 사용합니다. 첫 구간은 고정 방류량을 초기 추정값으로 사용하며 AI 모델은 아닙니다.');
  if (policy === 'forecast') warnings.add(`예측 참고 규칙은 직전 구간에 발행된 AI 예측의 다음 ${c.forecastHorizonHours}시간 평균 유입량을 사용하고, 예측이 없는 구간은 직전 구간 유입량으로 돌아갑니다. 최적화(MPC)나 강화학습이 아닙니다.`);
  if (policy === 'recorded') warnings.add('관측 방류 재생도 초기 저수량에서 물수지로 계산합니다. 관측 저수량, 수위, 발전량을 모델 상태에 자동 반영하지 않습니다.');
  if (policy === 'recorded' && rows.some(row => row.observedTurbineCms == null)) {
    warnings.add('관측 발전 유량이 없는 구간은 총방류량 중 발전 용량 이내를 발전에 우선 사용한다고 가정했습니다. 계산 발전량은 실제 발전량이 아닙니다.');
  }

  let storage = c.initialStorageMcm;
  let previousInflow = c.fixedReleaseCms;
  let forecastUsedCount = 0;
  const series = [];
  const metrics = {
    totalEnergyMWh: 0, endStorageMcm: storage, totalReleaseMcm: 0,
    shortageMcm: 0, floodHours: 0, releaseViolationHours: 0,
    maxMassBalanceErrorMcm: 0, totalInflowMcm: 0, overflowMcm: 0,
    initialStorageMcm: storage,
  };

  for (const [rowIndex, row] of rows.entries()) {
    const startStorageMcm = storage;
    const startLevelM = levelForStorage(storage, c);
    let requestedReleaseCms;
    if (policy === 'fixed') requestedReleaseCms = Math.max(c.minimumReleaseCms, c.fixedReleaseCms);
    let inflowEstimateCms = previousInflow;
    let forecastUsed = false;
    if (policy === 'forecast' && rowIndex > 0) {
      const issued = forecastTable[rowIndex - 1];
      if (Array.isArray(issued) || ArrayBuffer.isView(issued)) {
        const horizon = Math.min(c.forecastHorizonHours, issued.length);
        let sum = 0, count = 0;
        for (let k = 0; k < horizon; k++) if (Number.isFinite(issued[k]) && issued[k] >= 0) { sum += issued[k]; count++; }
        if (count === horizon && horizon > 0) { inflowEstimateCms = sum / count; forecastUsed = true; forecastUsedCount++; }
      }
    }
    if (policy === 'rule' || policy === 'forecast') {
      // 일정한 유입에서는 저장량 오차가 구간마다 exp(-Δt/T) 배로 감소한다.
      // Δt가 T보다 큰 일별 자료에서도 단순 오일러 보정의 부호 반전을 피한다.
      const responseFraction = -Math.expm1(-seconds / (c.responseHours * 3600));
      const correctionCms = (storage - c.targetStorageMcm) * 1e6 * responseFraction / seconds;
      requestedReleaseCms = Math.min(c.maxReleaseCms, Math.max(c.minimumReleaseCms, inflowEstimateCms + correctionCms));
    }
    if (policy === 'recorded') requestedReleaseCms = row.observedReleaseCms;

    const availableMcm = Math.max(0, storage - c.minStorageMcm + row.inflowCms * flowToMcm);
    const controlledReleaseCms = Math.min(requestedReleaseCms, availableMcm / flowToMcm);
    const beforeOverflow = storage + (row.inflowCms - controlledReleaseCms) * flowToMcm;
    const overflowMcm = Math.max(0, beforeOverflow - c.maxStorageMcm);
    const overflowCms = overflowMcm / flowToMcm;
    const releaseCms = controlledReleaseCms + overflowCms;
    storage = Math.max(c.minStorageMcm, Math.min(c.maxStorageMcm, beforeOverflow));

    let turbineCms = Math.min(c.maxTurbineCms, controlledReleaseCms);
    if (policy === 'recorded' && row.observedTurbineCms != null) {
      const fulfilledRatio = requestedReleaseCms > 0 ? controlledReleaseCms / requestedReleaseCms : 0;
      turbineCms = Math.min(row.observedTurbineCms, c.maxTurbineCms) * fulfilledRatio;
      if (row.observedTurbineCms > c.maxTurbineCms + 1e-9) {
        warnings.add('일부 관측 발전 유량이 설정 발전 용량을 넘어서 용량 이내로 제한했습니다. 시설 설정을 확인하세요.');
      }
    }
    if (controlledReleaseCms + 1e-9 < requestedReleaseCms) {
      warnings.add('사용 가능한 물이 부족한 구간의 계획 방류를 줄였습니다. 최소 저수량 아래의 물은 사용할 수 없다고 가정합니다.');
      if (policy === 'recorded') warnings.add('물 부족으로 관측 방류를 그대로 재생하지 못한 구간이 있습니다. 초기 상태, 자료, 시설 설정을 확인하세요.');
    }
    if (overflowMcm > 1e-12) warnings.add('최대 저수량 초과분을 월류로 기록했습니다. 실제 여수로 용량이나 시설 안전을 검증한 결과가 아닙니다.');
    const spillCms = releaseCms - turbineCms;
    const levelM = levelForStorage(storage, c);
    const headM = Math.max(0, (startLevelM + levelM) / 2 - c.tailwaterLevelM);
    const powerMW = 1000 * 9.81 * turbineCms * headM * c.efficiency / 1e6;
    const energyMWh = powerMW * c.timeStepHours;
    const shortageCms = Math.max(0, c.minimumReleaseCms - releaseCms);
    const floodExceeded = Math.max(startStorageMcm, storage) > c.floodStorageMcm + 1e-9;
    const releaseExceeded = releaseCms > c.maxReleaseCms + 1e-9;
    const massBalanceResidualMcm = startStorageMcm + row.inflowCms * flowToMcm
      - releaseCms * flowToMcm - storage;
    const endTimeMs = Date.parse(row.timestamp) + seconds * 1000;
    const finiteStep = [requestedReleaseCms, availableMcm, controlledReleaseCms,
      beforeOverflow, overflowMcm, overflowCms, releaseCms, storage, turbineCms,
      spillCms, startLevelM, levelM, headM, powerMW, energyMWh, shortageCms,
      massBalanceResidualMcm].every(Number.isFinite);
    if (!finiteStep || !Number.isFinite(new Date(endTimeMs).getTime())) {
      throw new Error(`${rowIndex + 1}행의 계산값이 숫자와 시간 표현 범위를 벗어났습니다. 입력 단위와 시설 설정을 확인하세요.`);
    }
    const balanceTolerance = 1e-9 * Math.max(1, c.maxStorageMcm,
      Math.abs(row.inflowCms * flowToMcm), Math.abs(releaseCms * flowToMcm));
    if (Math.abs(massBalanceResidualMcm) > balanceTolerance) {
      throw new Error(`${rowIndex + 1}행에서 물수지가 맞지 않아 계산을 중단했습니다. 입력 단위와 시설 설정을 확인하세요.`);
    }
    if (storage < c.minStorageMcm - 1e-9 || storage > c.maxStorageMcm + 1e-9
        || releaseCms < -1e-9 || spillCms < -1e-9 || turbineCms < -1e-9
        || turbineCms > c.maxTurbineCms + 1e-9) {
      throw new Error(`${rowIndex + 1}행에서 저수량과 유량 계산 범위를 벗어났습니다.`);
    }

    series.push({
      timestamp: row.timestamp,
      endTimestamp: new Date(endTimeMs).toISOString(),
      inflowCms: row.inflowCms, requestedReleaseCms,
      controlledReleaseCms, releaseCms, turbineCms, spillCms, overflowCms,
      startStorageMcm, storageMcm: storage, startLevelM, levelM, headM, powerMW, energyMWh,
      shortageCms, floodExceeded, releaseExceeded, massBalanceResidualMcm,
      inflowEstimateCms, forecastUsed,
      observedReleaseCms: row.observedReleaseCms ?? null,
      observedTurbineCms: row.observedTurbineCms ?? null,
      observedStorageMcm: row.observedStorageMcm ?? null,
      observedLevelM: row.observedLevelM ?? null,
      observedGenerationMWh: row.observedGenerationMWh ?? null,
      observedTurbidityNtu: row.observedTurbidityNtu ?? null,
    });
    metrics.totalEnergyMWh += energyMWh;
    metrics.totalInflowMcm += row.inflowCms * flowToMcm;
    metrics.totalReleaseMcm += releaseCms * flowToMcm;
    metrics.overflowMcm += overflowMcm;
    metrics.shortageMcm += shortageCms * flowToMcm;
    metrics.floodHours += floodExceeded ? c.timeStepHours : 0;
    metrics.releaseViolationHours += releaseExceeded ? c.timeStepHours : 0;
    metrics.maxMassBalanceErrorMcm = Math.max(metrics.maxMassBalanceErrorMcm, Math.abs(massBalanceResidualMcm));
    metrics.endStorageMcm = storage;
    if (!Object.values(metrics).every(Number.isFinite)) {
      throw new Error(`${rowIndex + 1}행까지의 누적 계산값이 숫자 표현 범위를 벗어났습니다. 입력 단위를 확인하세요.`);
    }
    previousInflow = row.inflowCms;
  }
  if (policy === 'forecast' && forecastUsedCount < rows.length - 1) {
    warnings.add(`예측이 없어 직전 구간 유입량으로 돌아간 구간이 ${rows.length - 1 - forecastUsedCount}개 있습니다 (예측은 48시간 기록이 쌓인 뒤부터 발행됩니다).`);
  }
  metrics.forecastUsedIntervals = forecastUsedCount;
  return { series, metrics, warnings: [...warnings], config: c, policy };
}

/** 단순 차이만 반환한다. 물을 더 소진해서 얻은 발전 증가를 개선이라고 판정하지 않는다. */
export function compareMetrics(base, proposed) {
  const b = base.metrics ?? base;
  const p = proposed.metrics ?? proposed;
  return {
    energyDeltaMWh: p.totalEnergyMWh - b.totalEnergyMWh,
    energyDeltaPercent: Math.abs(b.totalEnergyMWh) > 1e-12
      ? 100 * (p.totalEnergyMWh - b.totalEnergyMWh) / b.totalEnergyMWh : null,
    endStorageDeltaMcm: p.endStorageMcm - b.endStorageMcm,
    shortageDeltaMcm: p.shortageMcm - b.shortageMcm,
    floodHoursDelta: p.floodHours - b.floodHours,
    releaseViolationHoursDelta: p.releaseViolationHours - b.releaseViolationHours,
  };
}
