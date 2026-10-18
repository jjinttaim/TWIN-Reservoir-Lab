/** Evidence-aware view model for the operating scene. All model quantities retain
 * their interval meaning; absent observations are never coerced to zero. */
export const SCENE_FEATURES = Object.freeze([
  { id: 'reservoir', label: '저수지', camera: 'upstream' },
  { id: 'powerhouse', label: '발전소', camera: 'downstream' },
  { id: 'spillway', label: '여수로', camera: 'spillway' },
  { id: 'downstream', label: '하류', camera: 'downstream' },
]);
const valid = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function sceneInformation(row = {}, config = {}, meta = {}, feature = 'reservoir', hydraulic = null) {
  const chosen = SCENE_FEATURES.find((item) => item.id === feature) || SCENE_FEATURES[0];
  const metric = (label, value, unit, source = '계산값', digits = 1) => ({ label, value: valid(value), unit, source, digits });
  const start = valid(row.startStorageMcm), end = valid(row.storageMcm);
  const change = start === null || end === null ? null : end - start;
  const observed = meta.dataKind === 'observed';
  const common = [
    metric('유입 (구간 평균)', row.inflowCms, 'm³/s', '입력자료'),
    metric('총방류 (구간 평균)', row.releaseCms, 'm³/s'),
    metric('저수량 변화 (이 구간)', change, '백만 m³', '계산값', 3),
    metric('수위 (구간 끝)', row.levelM, 'm'),
  ];
  const explanation = {
    reservoir: change === null ? '현재 구간의 저수량 변화 자료가 없습니다.' : Math.abs(change) < 1e-8 ? '들어오는 물과 나가는 물의 양이 같아 이 구간의 저수량이 유지됩니다.' : change > 0 ? '나가는 물보다 들어오는 물이 많아 저수량이 늘어납니다. 수위는 설정한 수위와 저수량 관계로 계산합니다.' : '들어오는 물보다 나가는 물이 많아 저수량이 줄어듭니다. 수위는 설정한 수위와 저수량 관계로 계산합니다.',
    powerhouse: valid(row.turbineCms) === null ? '현재 구간의 발전용 방류 자료가 없습니다.' : row.turbineCms > 0 ? '총방류 중 발전에 배분한 물입니다. 발전량은 발전용 유량, 평균 낙차와 설정 효율로 계산합니다.' : '이 구간에는 발전에 배분된 유량이 없어 발전 수로의 흐름을 표시하지 않습니다.',
    spillway: valid(row.spillCms) === null ? '현재 구간의 비발전 방류 자료가 없습니다.' : row.spillCms > 0 ? '총방류에서 발전용 방류를 뺀 양을 이 수로로 표현합니다. 실제 수문 개방량이나 관측 여수로 방류를 뜻하지 않습니다.' : '이 구간의 비발전 방류는 0입니다. 여수로는 마른 상태로 표시합니다.',
    downstream: '발전용 방류와 비발전 방류가 합류하는 경로입니다. 두 유량의 합이 총방류이며, 하류의 실제 홍수위나 도달 시간은 계산하지 않습니다.',
  }[chosen.id];
  const featureMetrics = {
    reservoir: [metric('저수량 (구간 끝)', row.storageMcm, '백만 m³', '계산값', 3), metric('자료 속 수위 (구간 시작)', row.observedLevelM, 'm', '입력자료')],
    powerhouse: [metric('발전용 방류 (평균)', row.turbineCms, 'm³/s'), metric('발전량 (이 구간)', row.energyMWh, 'MWh'), metric('추정 평균 출력', row.powerMW, 'MW'), metric('평균 유효 낙차', row.headM, 'm')],
    spillway: [metric('비발전 방류 (평균)', row.spillCms, 'm³/s'), metric('그중 모형 월류', row.overflowCms, 'm³/s')],
    downstream: [metric('합류 후 총방류 (평균)', row.releaseCms, 'm³/s'), metric('자료 속 총방류 (평균)', row.observedReleaseCms, 'm³/s', '입력자료')],
  }[chosen.id];
  const flow = [metric('발전용', row.turbineCms, 'm³/s'), metric('비발전', row.spillCms, 'm³/s')];
  const hydraulicMetrics = chosen.id === 'reservoir' ? [] : [
    metric('표시 수로의 평균 수심', hydraulic?.[chosen.id]?.depthM, 'm', '모형가정', 2),
    metric('표시 수로의 평균 유속', hydraulic?.[chosen.id]?.velocityMs, 'm/s', '모형가정', 2),
  ];
  const notes = [
    '유입과 방류는 구간 평균, 수위와 저수량은 구간 끝의 값입니다.',
    '3D 높이 변화는 외형에 맞춰 축약한 표현입니다. 실제 수위와 변화량은 숫자로 확인하세요.',
    '수로의 수심과 유속은 가정한 경사, 폭, 거칠기로 계산한 미보정 근사입니다.',
    '수면 연결부와 물결 속도는 시각 표현이며 도수나 도달 시간을 해석하지 않습니다.',
  ];
  if (valid(row.overflowCms) !== null && row.overflowCms > 0) notes.push('모형 월류가 포함되어 있습니다. 실제 시설 월류나 침수 여부를 뜻하지 않습니다.');
  return {
    title: 'TWIN 현재 구간 정보',
    feature: chosen.id, featureTitle: chosen.label,
    timestamp: row.timestamp || null, endTimestamp: row.endTimestamp || null,
    durationHours: valid(config.timeStepHours),
    dataKind: meta.dataKind || 'unknown',
    sourceLabel: meta.dataKind === 'synthetic' ? '가상 자료로 계산' : observed ? '관측자료 기반 계산' : '출처 미확인 자료로 계산',
    explanation, common, featureMetrics, flow, hydraulicMetrics, notes,
    metrics: [...common, ...flow, metric('발전량 (이 구간)', row.energyMWh, 'MWh'), metric('추정 평균 출력', row.powerMW, 'MW')],
    source: meta.source || '미제공',
  };
}
