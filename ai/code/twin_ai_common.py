# -*- coding: utf-8 -*-
"""TWIN AI v1 공통 모듈.

계획서 `TWIN_AI_구축계획.md`(2026-10-14)의 규칙을 코드로 옮긴 부분이다.
- 원문 시각 YYYYMMDDHH(01~24)는 보존하고, 분석 라벨만 24시를 다음 날 00시로 바꾼다.
- 발행 시각 t, 지연 L, 지평 h: 입력은 t-L까지의 행, 목표는 q(t+h).
- 기본 입력 13개, 추가 상태 입력 6개, 목표 q(t+1), q(t+3), q(t+6)과 다음 3행 평균.
- 문제 시각(WAMIS 불일치, 자정 충돌, WAMIS 누락)을 입력이나 목표의 원천 행으로 쓰는 표본을 추적한다.

이 코드는 최종 공개자료를 이용한 후향 평가용이다. 실시간 운용 검증이 아니다.
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HOUR = timedelta(hours=1)
T0 = datetime(2024, 1, 1, 1, 0)  # 원문 첫 시각 2024010101 의 분석 라벨
LAGS = (1, 3, 6, 12, 24, 48)
MEANS = (3, 6, 24)
DIFFS = (1, 3, 6)
BASE_FEATURES = (
    ['q_latest']
    + [f'q_lag{k}' for k in LAGS]
    + [f'q_mean{k}' for k in MEANS]
    + [f'q_diff{k}' for k in DIFFS]
)
STATE_FEATURES = ['level_latest', 'storage_latest', 'release_latest',
                  'level_chg3', 'storage_chg3', 'release_chg3']
MAX_PAST = 48  # 가장 먼 지연 행
MAX_FUTURE = 6  # 가장 먼 지평
HORIZONS = (1, 3, 6)
DELAYS = (0, 1, 3)

# 교차확인.json 에서 확인한 문제 시각(분석 라벨). 입력과 목표가 이 행을 참조하는 표본은
# 별도의 제외 분석에서 통째로 뺀다. 보수적으로 세 종류를 모두 문제 시각으로 본다.
PROBLEM_TIMES = {
    # WAMIS와 유량 차이가 반올림 범위를 넘는 5개 시각
    '2024-05-21T10:00': 'WAMIS 유량 불일치',
    '2024-05-21T13:00': 'WAMIS 유량 불일치',
    '2024-05-22T13:00': 'WAMIS 유량 불일치',
    '2024-05-27T15:00': 'WAMIS 유량 불일치',
    '2024-05-27T16:00': 'WAMIS 유량 불일치',
    # WAMIS 자정 중복(값 충돌 보존) 3개 시각
    '2024-04-26T00:00': 'WAMIS 자정 중복',
    '2024-09-19T00:00': 'WAMIS 자정 중복',
    '2024-09-23T00:00': 'WAMIS 자정 중복',
    # WAMIS에 없는 K-water 시각 13개
    '2024-04-12T22:00': 'WAMIS 누락',
    '2024-04-12T23:00': 'WAMIS 누락',
    '2024-04-13T00:00': 'WAMIS 누락',
    '2024-04-13T01:00': 'WAMIS 누락',
    '2024-04-13T02:00': 'WAMIS 누락',
    '2024-04-13T03:00': 'WAMIS 누락',
    '2024-04-13T04:00': 'WAMIS 누락',
    '2024-04-13T05:00': 'WAMIS 누락',
    '2024-04-13T06:00': 'WAMIS 누락',
    '2024-04-13T07:00': 'WAMIS 누락',
    '2024-04-13T08:00': 'WAMIS 누락',
    '2024-04-13T09:00': 'WAMIS 누락',
    '2024-07-09T17:00': 'WAMIS 누락',
}


def parse_raw_label(label: str) -> datetime:
    """'2024010124' -> 2024-01-02 00:00 (달력 라벨 정규화만 수행)."""
    label = str(label).strip()
    if len(label) != 10 or not label.isdigit():
        raise ValueError(f'원문 시각 형식이 다릅니다: {label!r}')
    day = datetime(int(label[:4]), int(label[4:6]), int(label[6:8]))
    hour = int(label[8:10])
    if not 1 <= hour <= 24:
        raise ValueError(f'원문 시각의 시간은 01~24여야 합니다: {label!r}')
    return day + timedelta(hours=hour)


def load_kwater_csv(path: Path) -> pd.DataFrame:
    """원문 23열 CSV를 읽어 ASCII 열 이름의 정리본을 만든다. 값은 바꾸지 않는다."""
    with open(path, encoding='utf-8-sig', newline='') as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    expected_prefix = ['측정일시', '댐명', '1호기 발전량(kWh)', '2호기 발전량(kWh)', '저수위(EL.m)',
                       '방수로수위(EL.m)', '저수량(MCM)', '저수율(%)', '유입량(CMS)', '자체 유입량(CMS)',
                       '외부 유입량(CMS)', '공용량(MCM)']
    for i, name in enumerate(expected_prefix):
        if header[i].strip() != name:
            raise ValueError(f'열 {i+1}의 이름이 예상과 다릅니다: {header[i]!r} != {name!r}')
    if not header[12].startswith('총방류량(CMS)'):
        raise ValueError('13번째 열은 총방류량이어야 합니다.')
    if header[13] != '수문방류량(CMS)' or header[14] != '발전방류량(CMS)':
        raise ValueError('14번째와 15번째 열은 수문방류량과 발전방류량이어야 합니다.')
    if len(body) != 8784:
        raise ValueError(f'데이터 행수가 8,784가 아닙니다: {len(body)}')
    data = {
        'row_index': list(range(len(body))),
        'raw_label': [r[0] for r in body],
        'dam': [r[1] for r in body],
        'gen1_kwh': [float(r[2]) for r in body],
        'gen2_kwh': [float(r[3]) for r in body],
        'level': [float(r[4]) for r in body],
        'tail_level': [float(r[5]) for r in body],
        'storage': [float(r[6]) for r in body],
        'storage_pct': [float(r[7]) for r in body],
        'q': [float(r[8]) for r in body],
        'q_own': [float(r[9]) for r in body],
        'q_external': [float(r[10]) for r in body],
        'free_storage': [float(r[11]) for r in body],
        'release': [float(r[12]) for r in body],
        'gate_release': [float(r[13]) for r in body],
        'turbine_release': [float(r[14]) for r in body],
    }
    df = pd.DataFrame(data)
    df['t_label'] = [parse_raw_label(x) for x in df['raw_label']]
    # 시각 규칙 검사: 매시 1행, 중복과 누락 없음
    diffs = df['t_label'].diff().dropna().unique()
    if len(diffs) != 1 or diffs[0] != np.timedelta64(1, 'h'):
        raise ValueError('분석 라벨의 간격이 1시간으로 일정하지 않습니다.')
    if df['t_label'].iloc[0] != T0 or df['t_label'].iloc[-1] != datetime(2025, 1, 1, 0, 0):
        raise ValueError('분석 라벨의 시작과 끝이 예상과 다릅니다.')
    if (df['dam'] != '소양강댐').any():
        raise ValueError('댐명이 소양강댐이 아닌 행이 있습니다.')
    if (df['q'] < 0).any():
        raise ValueError('공개 총유입량에 음수가 있습니다. 계획과 다르므로 확인이 필요합니다.')
    df['gen_mwh'] = (df['gen1_kwh'] + df['gen2_kwh']) / 1000.0
    key = df['t_label'].dt.strftime('%Y-%m-%dT%H:%M')
    df['problem_row'] = key.isin(PROBLEM_TIMES.keys())
    df['problem_reason'] = key.map(PROBLEM_TIMES).fillna('')
    return df


def label_to_index(t: datetime) -> int:
    """분석 라벨 -> 행 번호 (T0 기준 시간 차)."""
    return int((t - T0) / HOUR)


def month_start(year: int, month: int) -> datetime:
    return datetime(year, month, 1, 0, 0)


@dataclass
class SampleTable:
    """발행 시각 i 를 행으로, 지연 L 별 입력과 지평 h 별 목표를 열로 가진 표."""
    frame: pd.DataFrame
    q: np.ndarray

    def features(self, delay: int, with_state: bool) -> list[str]:
        cols = [f'L{delay}_{c}' for c in BASE_FEATURES]
        if with_state:
            cols += [f'L{delay}_{c}' for c in STATE_FEATURES]
        return cols

    def target(self, horizon: int, kind: str = 'point') -> str:
        return f'y_h{horizon}' if kind == 'point' else 'y_mean3'


def build_samples(df: pd.DataFrame) -> SampleTable:
    """공통 발행 시각 집합(필요한 과거 48+3행, 미래 6행이 모두 있는 i)에 대해
    L=0, 1, 3 입력과 h=1, 3, 6 목표, 평균 목표, 문제 행 참조 여부를 만든다.
    문제 행을 먼저 지우고 나머지를 당기지 않는다(시간 격자 유지)."""
    q = df['q'].to_numpy(dtype=float)
    level = df['level'].to_numpy(dtype=float)
    storage = df['storage'].to_numpy(dtype=float)
    release = df['release'].to_numpy(dtype=float)
    problem = df['problem_row'].to_numpy(dtype=bool)
    n = len(df)
    first = MAX_PAST + max(DELAYS)
    last = n - 1 - MAX_FUTURE
    idx = np.arange(first, last + 1)
    out = {'i': idx, 'issue_time': df['t_label'].to_numpy()[idx], 'raw_issue_label': df['raw_label'].to_numpy()[idx],
           'q_issue': q[idx]}
    cum = np.concatenate([[0.0], np.cumsum(q)])  # cum[k] = sum(q[:k])

    def window_mean(j: np.ndarray, k: int) -> np.ndarray:
        # 최신 가용 행 j 를 포함해 뒤로 k행 평균
        return (cum[j + 1] - cum[j + 1 - k]) / k

    problem_cum = np.concatenate([[0], np.cumsum(problem.astype(int))])

    def window_has_problem(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        # [a, b] 구간(양 끝 포함)에 문제 행이 있는가
        return (problem_cum[b + 1] - problem_cum[a]) > 0

    for L in DELAYS:
        j = idx - L
        out[f'L{L}_latest_input_time'] = df['t_label'].to_numpy()[j]
        out[f'L{L}_q_latest'] = q[j]
        for k in LAGS:
            out[f'L{L}_q_lag{k}'] = q[j - k]
        for k in MEANS:
            out[f'L{L}_q_mean{k}'] = window_mean(j, k)
        for k in DIFFS:
            out[f'L{L}_q_diff{k}'] = q[j] - q[j - k]
        out[f'L{L}_level_latest'] = level[j]
        out[f'L{L}_storage_latest'] = storage[j]
        out[f'L{L}_release_latest'] = release[j]
        out[f'L{L}_level_chg3'] = level[j] - level[j - 3]
        out[f'L{L}_storage_chg3'] = storage[j] - storage[j - 3]
        out[f'L{L}_release_chg3'] = release[j] - release[j - 3]
        out[f'L{L}_mean6_persist'] = window_mean(j, 6)  # 최근 6행 평균 유지 기준선
        # 기본 입력이 참조하는 원천 행: [j-23, j] 와 {j-24, j-48}. 상태 입력은 {j, j-3} ⊂ [j-23, j].
        out[f'L{L}_feature_problem'] = (window_has_problem(j - 23, j) | problem[j - 24] | problem[j - 48])
    for h in HORIZONS:
        out[f'y_h{h}'] = q[idx + h]
        out[f'target_time_h{h}'] = df['t_label'].to_numpy()[idx + h]
        out[f'target_problem_h{h}'] = problem[idx + h]
    out['y_mean3'] = (q[idx + 1] + q[idx + 2] + q[idx + 3]) / 3.0
    out['target_problem_mean3'] = window_has_problem(idx + 1, idx + 3)
    frame = pd.DataFrame(out)
    frame['month'] = pd.DatetimeIndex(frame['issue_time']).month
    # 평가와 조정에 쓰는 공통 표본: 발행 시각과 최대 목표 시각 t+6 이 같은 달 안에 있어야 한다.
    frame['month_t6'] = pd.DatetimeIndex(frame['target_time_h6']).month
    frame['eligible_eval'] = frame['month'] == frame['month_t6']
    return SampleTable(frame=frame, q=q)


def train_mask(frame: pd.DataFrame, refit_time: datetime, horizon: int, delay: int, kind: str = 'point') -> np.ndarray:
    """재학습 시각 r 에 허용되는 학습 표본: 마지막 목표 행 + L ≤ r 이고 목표 시각 < r."""
    r_index = label_to_index(refit_time)
    last_target_offset = horizon if kind == 'point' else 3
    i = frame['i'].to_numpy()
    last_target = i + last_target_offset
    return (last_target < r_index) & (last_target + delay <= r_index)


def eval_mask(frame: pd.DataFrame, month: int) -> np.ndarray:
    return (frame['month'].to_numpy() == month) & frame['eligible_eval'].to_numpy()


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default) + '\n', encoding='utf-8')


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (datetime, pd.Timestamp)):
        return o.strftime('%Y-%m-%d %H:%M')
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f'JSON으로 바꿀 수 없는 값: {type(o)}')
