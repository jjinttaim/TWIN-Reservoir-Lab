# -*- coding: utf-8 -*-
"""7단계: 6단계 결과를 TWIN 프로그램이 읽는 두 파일로 내보낸다.

실행: python3 07_export_app.py <결과폴더> <프로그램 assets/ai 폴더>
- model.json: 승자 구조의 7월 1일 재학습 모형(가중치, 정규화 통계, 잔차 분위수). 검증 벡터는 제외한다(tests/fixtures 에 둔다).
- evaluation.json: 7~9월 주비교표(h=1, 3, 6, 12, 24), 블록 부트스트랩, 월별 MAE, 6월 선택 요약.
"""
import json
import sys
from pathlib import Path


def high_inflow_block(results: Path, perf: dict) -> dict | None:
    """7~9월 h=3 에서 목표가 고유입 문턱(1~6월 유입량 90% 분위수) 이상인 표본의 오차. 02단계와 06단계 예측기록을 같은 발행 시각으로 짝짓는다."""
    try:
        import pandas as pd
        import numpy as np
    except ImportError:
        return None
    main_csv = results / '예측기록' / 'predictions_main.csv'
    deep_csv = results / '예측기록' / 'predictions_deep_base.csv'
    if not main_csv.exists() or not deep_csv.exists():
        return None
    v1 = pd.read_csv(main_csv, encoding='utf-8-sig')
    v1 = v1[(v1['horizon_h'] == 3) & (v1['month'].isin([7, 8, 9])) & (v1['role'] != '조정월(6월)')]
    piv = v1.pivot_table(index='i', columns='model', values='prediction')
    piv['actual'] = v1.groupby('i')['actual_official'].first()
    deep = pd.read_csv(deep_csv, encoding='utf-8-sig')
    threshold = None
    for key in ('high_inflow_threshold_m3s_p90_jan_jun',):
        threshold = perf.get(key)
    if threshold is None:
        v1_perf = results / '11_조건별_성능표.json'
        if v1_perf.exists():
            threshold = json.loads(v1_perf.read_text(encoding='utf-8')).get('high_inflow_threshold_m3s_p90_jan_jun')
    if threshold is None:
        return None
    preds = {m: piv[m] for m in ('persistence', 'mean6', 'ridge', 'hgb') if m in piv}
    for kind in ('lstm', 'transformer'):
        d = deep[(deep['model'] == kind) & (deep['features'] == 'base') & (deep['month'].isin([7, 8, 9]))].set_index('i')
        common = piv.index.intersection(d.index)
        if len(common) != len(piv.index):
            piv = piv.loc[common]
            preds = {m: v.loc[common] for m, v in preds.items()}
        if not np.allclose(piv['actual'], d.loc[piv.index, 'actual_h03']):
            raise ValueError('02단계와 06단계의 실측값이 다릅니다')
        preds[kind] = d.loc[piv.index, 'pred_h03']
    actual = piv['actual']
    high = actual >= threshold
    methods = {}
    for m, pred in preds.items():
        err = (pred - actual)
        under = np.maximum(-err, 0)
        methods[m] = {'MAE': float(np.abs(err[high]).mean()), 'bias': float(err[high].mean()), 'underprediction_mean': float(under[high].mean())}
    return {'definition': f'7~9월 h=3 표본 중 실측 목표가 {threshold:.1f} m³/s(1~6월 유입량의 90% 분위수) 이상인 발행 시각. 과소예측 평균은 max(실측 − 예측, 0)의 평균.',
            'threshold_m3s': float(threshold), 'n': int(high.sum()), 'n_total': int(len(actual)), 'methods': methods}


def main(results: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    selection = json.loads((results / '40_6월_딥러닝_설정선택.json').read_text(encoding='utf-8'))
    perf = json.loads((results / '41_딥러닝_조건별_성능표.json').read_text(encoding='utf-8'))
    main_cmp = json.loads((results / '42_딥러닝_주비교_7-9월.json').read_text(encoding='utf-8'))
    winner = selection['winner_by_june']
    model = json.loads((results / f'43_모형_{winner}_7월재학습.json').read_text(encoding='utf-8'))
    model.pop('test_vectors', None)
    (out_dir / 'model.json').write_text(json.dumps(model, ensure_ascii=False), encoding='utf-8')

    methods = ['persistence', 'mean6', 'ridge', 'hgb', 'lstm', 'transformer']
    labels = {'persistence': '유지', 'mean6': '6행 평균', 'ridge': 'Ridge', 'hgb': 'HGB', 'lstm': 'LSTM', 'transformer': 'Transformer'}
    by_h = {}
    for h in (1, 3, 6, 12, 24):
        row = {}
        for kind in ('lstm', 'transformer'):
            entry = perf['conditions'][f'{kind}/base']['periods']['주평가_7-9월'][f'h{h}']
            row[kind] = entry['MAE']
            row['n'] = entry['n']
            if kind == 'lstm':
                for m in ('persistence', 'mean6', 'ridge', 'hgb'):
                    key = f'MAE_{m}_same_samples'
                    row[m] = entry.get(key)
        by_h[f'h{h}'] = row
    boot_rows = []
    names = {'lstm_minus_ridge_absolute_error': 'LSTM − Ridge', 'lstm_minus_persistence_absolute_error': 'LSTM − 유지',
             'transformer_minus_ridge_absolute_error': 'Transformer − Ridge', 'transformer_minus_persistence_absolute_error': 'Transformer − 유지',
             'lstm_minus_transformer_absolute_error': 'LSTM − Transformer'}
    for key, label in names.items():
        b = main_cmp['paired_block_bootstrap'].get(key)
        if not b:
            continue
        boot_rows.append({'label': label, 'point': b['24']['point_estimate'], 'ci24': b['24']['ci95'], 'ci168': b['168']['ci95'],
                          'zero24': b['24']['contains_zero_95'], 'zero168': b['168']['contains_zero_95']})
    monthly = {}
    for month, entry in perf['conditions']['lstm/base']['monthly'].items():
        role = '주평가' if int(month) in (7, 8, 9) else '보조평가'
        row = {'role': role, 'lstm': entry['h3']['MAE'], 'transformer': perf['conditions']['transformer/base']['monthly'][month]['h3']['MAE']}
        for m in ('persistence', 'mean6', 'ridge', 'hgb'):
            row[m] = entry['h3'].get(f'MAE_{m}_same_samples')
        monthly[month] = row
    high = high_inflow_block(results, perf)
    evaluation = {
        'generated_from': ['40_6월_딥러닝_설정선택.json', '41_딥러닝_조건별_성능표.json', '42_딥러닝_주비교_7-9월.json',
                           '예측기록/predictions_main.csv', '예측기록/predictions_deep_base.csv'],
        'model_version': perf['model_version'],
        'winner': winner,
        'definition': main_cmp['definition'] + ' 12시간과 24시간 지평은 Ridge 기록이 없어 유지 기준선과만 비교하며 발행 시각과 t+24가 같은 달인 표본으로 제한합니다.',
        'methods': methods, 'labels': labels,
        'by_horizon': by_h,
        'bootstrap': boot_rows,
        'monthly': monthly,
        'selection': {k: {'config': v['config'], 'epochs': v['epochs'], 'june_MAE_h3': v['june_MAE_h3']} for k, v in selection['selected'].items()},
        'june_baselines_h3': selection.get('june_MAE_h3_baselines'),
        'high_inflow': high,
    }
    (out_dir / 'evaluation.json').write_text(json.dumps(evaluation, ensure_ascii=False, indent=1), encoding='utf-8')
    print('exported', winner, 'to', out_dir)


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
