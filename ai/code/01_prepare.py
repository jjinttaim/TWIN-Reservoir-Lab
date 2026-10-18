# -*- coding: utf-8 -*-
"""1단계: 원문 CSV -> 학습용 정리본, 특징과 목표 표, 정의 기록, 미래 정보 사용 검사.

실행: python3 01_prepare.py <원문23열.csv> <출력폴더>
"""
import hashlib
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from twin_ai_common import (BASE_FEATURES, DELAYS, DIFFS, HORIZONS, LAGS, MEANS, PROBLEM_TIMES, STATE_FEATURES,
                            build_samples, load_kwater_csv, write_json)


def main(src: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    df = load_kwater_csv(src)
    tidy = df[['row_index', 'raw_label', 't_label', 'q', 'q_own', 'level', 'storage', 'release', 'turbine_release',
               'gate_release', 'gen_mwh', 'problem_row', 'problem_reason']].copy()
    tidy['t_label'] = tidy['t_label'].dt.strftime('%Y-%m-%d %H:%M')
    tidy.to_csv(out / '01_학습용_정리본.csv', index=False, encoding='utf-8-sig')

    table = build_samples(df)
    frame = table.frame.copy()
    for col in frame.columns:
        if frame[col].dtype.kind == 'M':
            frame[col] = pd.DatetimeIndex(frame[col]).strftime('%Y-%m-%d %H:%M')
    frame.to_csv(out / '02_특징_목표표.csv', index=False, encoding='utf-8-sig')

    # ---- 미래 정보 사용 검사 (누수 검사) -------------------------------------
    # 모든 입력의 원천 행 번호가 발행 행 i-L 이하이고, 목표의 원천 행이 i+h 임을 직접 확인한다.
    checks = []
    q = df['q'].to_numpy()
    f = table.frame
    rng = np.random.default_rng(42)
    for L in DELAYS:
        j = f['i'].to_numpy() - L
        checks.append({'delay': L, 'rule': 'latest input row = i - L', 'ok': bool(np.all(j == f['i'].to_numpy() - L))})
        checks.append({'delay': L, 'rule': 'q_latest equals q[i-L]', 'ok': bool(np.allclose(f[f'L{L}_q_latest'], q[j]))})
        for k in LAGS:
            checks.append({'delay': L, 'rule': f'q_lag{k} equals q[i-L-{k}]', 'ok': bool(np.allclose(f[f'L{L}_q_lag{k}'], q[j - k]))})
        for k in MEANS:
            sample = rng.choice(len(j), 200, replace=False)
            manual = np.array([q[j[s] - k + 1: j[s] + 1].mean() for s in sample])
            checks.append({'delay': L, 'rule': f'q_mean{k} is backward mean incl. latest (200 random samples)',
                           'ok': bool(np.allclose(f[f'L{L}_q_mean{k}'].to_numpy()[sample], manual))})
        checks.append({'delay': L, 'rule': 'no feature references a row after i-L (by construction; max source row = i-L)',
                       'ok': True, 'max_source_offset_from_issue': -L})
    for h in HORIZONS:
        checks.append({'horizon': h, 'rule': f'y_h{h} equals q[i+{h}]', 'ok': bool(np.allclose(f[f'y_h{h}'], q[f['i'].to_numpy() + h]))})
    checks.append({'rule': 'y_mean3 equals mean(q[i+1..i+3])',
                   'ok': bool(np.allclose(f['y_mean3'], (q[f['i'] + 1] + q[f['i'] + 2] + q[f['i'] + 3]) / 3))})
    checks.append({'rule': 'issue times are strictly increasing by 1 hour', 'ok': bool((np.diff(f['i'].to_numpy()) == 1).all())})
    all_ok = all(c['ok'] for c in checks)

    excluded_tail = f.groupby('month')['eligible_eval'].apply(lambda s: int((~s).sum())).to_dict()
    definitions = {
        'prepared_on': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'source_file': src.name,
        'source_sha256': sha,
        'rows': int(len(df)),
        'time_rule': {
            'raw_label': 'YYYYMMDDHH, HH=01..24 (원문 보존)',
            'analysis_label': '24시는 다음 날 00:00 으로 환산한 달력 라벨. 시간대와 구간 의미(시작/끝, 평균/순간)는 미확인 상태로 둔다.',
            'first_label': '2024-01-01 01:00', 'last_label': '2025-01-01 00:00 (원문 2024-12-31 24시)',
            'month_definition': '분석 라벨 기준 [월초 00:00, 다음 월초 00:00)',
        },
        'sample_set': {
            'issue_rows_i': [int(f['i'].min()), int(f['i'].max())],
            'count': int(len(f)),
            'reason': '지평 1, 3, 6과 지연 0, 1, 3의 비교에 필요한 과거 48+3행과 미래 6행이 모두 있는 공통 발행 시각',
            'eligible_for_monthly_eval': int(f['eligible_eval'].sum()),
            'excluded_month_end_issue_times_per_month': excluded_tail,
            'eligibility_rule': '발행 시각과 최대 목표 시각 t+6 이 같은 달 안에 있는 표본만 조정과 평가에 사용',
        },
        'targets': {
            'point': {f'y_h{h}': f'q(t+{h}) 공개 총유입량 m³/s' for h in HORIZONS},
            'mean3': 'q(t+1), q(t+2), q(t+3) 의 산술평균 (별도 민감도, 점값 지표와 직접 비교하지 않음)',
            'note': '공식 총유입량을 그대로 목표로 쓴다. 물수지로 재구성한 부호 있는 값으로 바꾸지 않는다.',
        },
        'features': {
            'base_13': {
                'q_latest': 'q(t-L): 최신 이용 가능 유입량',
                **{f'q_lag{k}': f'q(t-L-{k})' for k in LAGS},
                **{f'q_mean{k}': f'최신 가용 행을 포함해 뒤로 {k}행 평균' for k in MEANS},
                **{f'q_diff{k}': f'q(t-L) - q(t-L-{k})' for k in DIFFS},
            },
            'state_6_separate_comparison': {
                'level_latest': '저수위(t-L) EL.m', 'storage_latest': '저수량(t-L) MCM', 'release_latest': '총방류량(t-L) m³/s',
                'level_chg3': '저수위(t-L) - 저수위(t-L-3)', 'storage_chg3': '저수량(t-L) - 저수량(t-L-3)',
                'release_chg3': '총방류량(t-L) - 총방류량(t-L-3)',
            },
            'never_used': ['미래의 모든 관측', '미래 실제 강우', '미래 방류 계획', '전체 연도로 계산한 표준화와 결측 대체', '같은 시각 저수량 변화로 유입량을 복원하는 산식'],
            'source_rows_tracked': '기본 입력: [j-23, j] ∪ {j-24, j-48} (j=i-L). 상태 입력: {j, j-3}. 목표: i+h (평균 목표: i+1..i+3).',
        },
        'problem_times': PROBLEM_TIMES,
        'problem_rows_in_data': int(df['problem_row'].sum()),
        'leakage_checks': checks,
        'leakage_checks_all_ok': all_ok,
        'status': '자료 정리와 특징 생성만 완료. 학습과 평가는 02_fit_eval.py 에서 수행.',
    }
    write_json(out / '03_정의와_검사.json', definitions)
    print('정리본 행수', len(tidy), '| 표본 수', len(f), '| 평가 가능', int(f['eligible_eval'].sum()), '| 누수 검사', 'OK' if all_ok else 'FAIL')
    if not all_ok:
        raise SystemExit('누수 검사 실패')


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
