# -*- coding: utf-8 -*-
"""3단계: 결과 그래프와 요약표(Markdown) 생성.

실행: python3 03_figures.py <결과폴더>
"""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd

MODELS = [('persistence', '현재값 유지', '#8a8a8a'), ('mean6', '최근 6행 평균', '#c8a24a'),
          ('ridge', 'Ridge', '#1f6fb2'), ('hgb', '작은 부스팅(HGB)', '#c0392b')]


def setup_font():
    for name in ['Noto Sans CJK KR', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'NanumGothic', 'AppleGothic', 'Malgun Gothic']:
        if any(f.name == name for f in font_manager.fontManager.ttflist):
            plt.rcParams['font.family'] = name
            break
    plt.rcParams['axes.unicode_minus'] = False


def main(out: Path) -> None:
    setup_font()
    fig_dir = out / '그래프'
    fig_dir.mkdir(exist_ok=True)
    rec = pd.read_csv(out / '예측기록' / 'predictions_main.csv')
    rec['issue_time'] = pd.to_datetime(rec['issue_time'])
    rec['target_time'] = pd.to_datetime(rec['target_time'])
    perf = json.load(open(out / '11_조건별_성능표.json', encoding='utf-8'))
    main_summary = json.load(open(out / '12_주비교_7-9월.json', encoding='utf-8'))
    sel = json.load(open(out / '10_6월_설정선택.json', encoding='utf-8'))

    piv = rec.pivot_table(index='target_time', columns='model', values='prediction')
    actual = rec[rec['model'] == 'hgb'].set_index('target_time')['actual_official'].reindex(piv.index)
    month = rec[rec['model'] == 'hgb'].set_index('target_time')['month'].reindex(piv.index)

    # 그림 1: 7~9월 전체 시계열
    fig, ax = plt.subplots(figsize=(14, 5))
    mask = month.isin([7, 8, 9]).to_numpy()
    ax.plot(piv.index[mask], actual[mask], color='black', lw=1.2, label='공개 총유입량(사후 대조)')
    for key, label, color in MODELS[2:]:
        ax.plot(piv.index[mask], piv[key][mask], lw=0.9, alpha=.85, color=color, label=f'{label} 예측(3시간 뒤)')
    ax.set_title('7~9월 주평가: 3시간 뒤 공개 유입량 예측과 실제 (L=0, 기본 13 입력)')
    ax.set_ylabel('m³/s'); ax.grid(alpha=.3); ax.legend(loc='upper right')
    fig.tight_layout(); fig.savefig(fig_dir / 'F1_7-9월_시계열.png', dpi=150); plt.close(fig)

    # 그림 2: 최대 유입 사건 주변 7일 확대
    peak_time = actual.idxmax()
    lo, hi = peak_time - pd.Timedelta(days=3), peak_time + pd.Timedelta(days=4)
    zoom = (piv.index >= lo) & (piv.index <= hi)
    fig, ax = plt.subplots(figsize=(12, 5))
    ax.plot(piv.index[zoom], actual[zoom], color='black', lw=1.6, label='공개 총유입량')
    for key, label, color in MODELS:
        ax.plot(piv.index[zoom], piv[key][zoom], lw=1.1, alpha=.9, color=color, label=label)
    ax.axhline(perf['high_inflow_threshold_m3s_p90_jan_jun'], color='gray', ls='--', lw=.8, label='고유입 기준(1~6월 90백분위)')
    ax.set_title(f'최대 유입 사건 주변 7일 (최대 {actual.max():.0f} m³/s, {peak_time:%Y-%m-%d %H:%M} 목표 시각)')
    ax.set_ylabel('m³/s'); ax.grid(alpha=.3); ax.legend(loc='upper left')
    fig.autofmt_xdate(); fig.tight_layout(); fig.savefig(fig_dir / 'F2_최대사건_확대.png', dpi=150); plt.close(fig)

    # 그림 3: 월별 MAE
    months = [6, 7, 8, 9, 10, 11, 12]
    fig, ax = plt.subplots(figsize=(11, 4.8))
    width = 0.2
    for k, (key, label, color) in enumerate(MODELS):
        vals = [perf['conditions']['main']['monthly'][str(m)][key]['MAE'] for m in months]
        ax.bar(np.arange(len(months)) + (k - 1.5) * width, vals, width, label=label, color=color)
    ax.set_xticks(np.arange(len(months)), [f'{m}월' + (' (조정)' if m == 6 else '') for m in months])
    ax.set_ylabel('MAE (m³/s)'); ax.set_title('월별 MAE: 3시간 뒤 유입량 (6월은 설정 선택에 쓴 달)')
    ax.grid(axis='y', alpha=.3); ax.legend()
    fig.tight_layout(); fig.savefig(fig_dir / 'F3_월별_MAE.png', dpi=150); plt.close(fig)

    # 그림 4: 산점도 (7~9월)
    fig, axes = plt.subplots(1, 2, figsize=(11, 5), sharex=True, sharey=True)
    lim = max(actual[mask].max(), piv['ridge'][mask].max(), piv['hgb'][mask].max()) * 1.05
    for ax, (key, label, color) in zip(axes, MODELS[2:]):
        ax.scatter(actual[mask], piv[key][mask], s=6, alpha=.5, color=color)
        ax.plot([0, lim], [0, lim], color='black', lw=.8)
        ax.set_title(f'{label}: 예측 대 실제 (7~9월)'); ax.set_xlabel('실제 공개 유입량 (m³/s)'); ax.grid(alpha=.3)
    axes[0].set_ylabel('예측 (m³/s)')
    fig.tight_layout(); fig.savefig(fig_dir / 'F4_산점도_7-9월.png', dpi=150); plt.close(fig)

    # 그림 5: 조건별 7~9월 / 10~12월 MAE
    conds = list(perf['conditions'].keys())
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8), sharey=True)
    for ax, period in zip(axes, ['주평가_7-9월', '보조평가_10-12월']):
        for k, (key, label, color) in enumerate(MODELS):
            vals = [perf['conditions'][c]['periods'][period][key]['MAE'] for c in conds]
            ax.bar(np.arange(len(conds)) + (k - 1.5) * width, vals, width, label=label, color=color)
        ax.set_xticks(np.arange(len(conds)), conds); ax.set_title(period.replace('_', ' ')); ax.grid(axis='y', alpha=.3)
    axes[0].set_ylabel('MAE (m³/s)'); axes[0].legend()
    fig.suptitle('조건별 MAE (mean3 는 평균 목표라서 다른 조건과 직접 비교하지 않음)')
    fig.tight_layout(); fig.savefig(fig_dir / 'F5_조건별_MAE.png', dpi=150); plt.close(fig)

    # 요약표 Markdown ------------------------------------------------------
    lines = ['# TWIN AI v1 결과 요약 (자동 생성)', '',
             '최종 공개자료(K-water 2024)를 이용한 후향 평가다. L=0 은 즉시 가용을 가정한 값이다. 숫자는 `11_조건별_성능표.json`, `12_주비교_7-9월.json` 과 같다.', '',
             '## 6월 설정 선택 (주비교 조건, 학습 1~5월)', '',
             f"- 학습 표본 {sel['train_samples']}, 6월 조정 표본 {sel['tuning_samples']}",
             f"- Ridge alpha 후보 6월 MAE: " + ', '.join(f"{r['alpha']}→{r['june_MAE']:.3f}" for r in sel['ridge']) + f"  → 선택 alpha={sel['selected']['ridge']['alpha']}",
             f"- 부스팅 후보 6월 MAE: " + ', '.join(f"({h['max_leaf_nodes']},{h['min_samples_leaf']},{h['l2_regularization']})→{h['june_MAE']:.3f}" for h in sel['hgb']) + f"  → 선택 {sel['selected']['hgb']}",
             f"- 6월 기준선 MAE: 현재값 유지 {sel['persistence_june_MAE']:.3f}, 최근 6행 평균 {sel['mean6_june_MAE']:.3f}", '',
             '## 주비교: 7~9월, h=3, L=0, 기본 13 입력', '', '| 방법 | n | MAE | RMSE | 평균 편향(예측−실제) | 현재값 유지 대비 MAE 개선 | 고유입(≥{:.1f}) 과소예측 평균 | 학습 범위 초과 목표 n / MAE |'.format(perf['high_inflow_threshold_m3s_p90_jan_jun']),
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    p = perf['conditions']['main']['periods']['주평가_7-9월']
    for key, label, _ in MODELS:
        v = p[key]
        impr = v.get('MAE_improvement_vs_persistence_pct')
        lines.append(f"| {label} | {v['n']} | {v['MAE']:.2f} | {v['RMSE']:.1f} | {v['bias_mean_pred_minus_actual']:+.2f} | "
                     f"{(f'{impr:+.1f}%' if impr is not None else '-')} | {v['high_inflow']['underprediction_mean_m3s']:.1f} (n={v['high_inflow']['n']}) | "
                     f"{v['target_above_training_range']['n']} / {(v['target_above_training_range']['MAE'] or 0):.0f} |")
    lines += ['', f"주비교 차이 (HGB MAE − Ridge MAE) = **{main_summary['primary_difference_MAE_hgb_minus_ridge']:+.2f} m³/s** (양수면 Ridge 가 더 정확)", '',
              '### 짝지은 절대오차 차이의 블록 부트스트랩 (2000회, 95% 범위)', '', '| 비교 | 점추정 | 24시간 블록 | 168시간 블록 | 0 포함 여부(24h/168h) |', '|---|---:|---|---|---|']
    for name, v in main_summary['paired_block_bootstrap'].items():
        b24, b168 = v['24'], v['168']
        lines.append(f"| {name.replace('_absolute_error','').replace('_minus_',' − ')} | {b24['point_estimate']:+.2f} | [{b24['ci95'][0]:+.2f}, {b24['ci95'][1]:+.2f}] | [{b168['ci95'][0]:+.2f}, {b168['ci95'][1]:+.2f}] | {b24['contains_zero_95']} / {b168['contains_zero_95']} |")
    lines += ['', '## 월별 MAE (주비교 조건)', '', '| 월 | n | ' + ' | '.join(l for _, l, _ in MODELS) + ' |', '|---|---:|' + '---:|' * len(MODELS)]
    for m in months:
        row = perf['conditions']['main']['monthly'][str(m)]
        lines.append(f"| {m}월{' (조정)' if m == 6 else ''} | {row['hgb']['n']} | " + ' | '.join(f"{row[k]['MAE']:.1f}" for k, _, _ in MODELS) + ' |')
    lines += ['', '## 조건별 MAE', '', '| 조건 | 기간 | ' + ' | '.join(l for _, l, _ in MODELS) + ' |', '|---|---|' + '---:|' * len(MODELS)]
    for c in conds:
        for period in ['주평가_7-9월', '보조평가_10-12월']:
            row = perf['conditions'][c]['periods'][period]
            lines.append(f"| {c} ({perf['conditions'][c]['label']}) | {period.replace('_',' ')} | " + ' | '.join(f"{row[k]['MAE']:.1f}" for k, _, _ in MODELS) + ' |')
    excl = json.load(open(out / '13_문제시각_제외분석.json', encoding='utf-8'))
    lines += ['', '## 문제 시각 제외 분석 (주비교 조건, 같은 깨끗한 시험 표본에서 비교)', '',
              f"영향받는 표본 수 {excl['affected_samples_total']} (전체 표본 중). 월별 깨끗한 시험 표본 수와 MAE:", '',
              '| 월 | 시험 n(원래→깨끗) | 학습 n(원래→깨끗) | 현재값 유지 | Ridge 원래학습 | Ridge 깨끗학습 | HGB 원래학습 | HGB 깨끗학습 |', '|---|---|---|---:|---:|---:|---:|---:|']
    for m, r in excl['months'].items():
        lines.append(f"| {m}월 | {r['n_eval_original']}→{r['n_eval_clean']} | {r['n_train_original']}→{r['n_train_clean']} | {r['MAE_persistence_clean_samples']:.1f} | "
                     f"{r['ridge_MAE_original_fit_on_clean_samples']:.1f} | {r['ridge_MAE_clean_fit_on_clean_samples']:.1f} | {r['hgb_MAE_original_fit_on_clean_samples']:.1f} | {r['hgb_MAE_clean_fit_on_clean_samples']:.1f} |")
    lines += ['', '## 그래프', '', '- `그래프/F1_7-9월_시계열.png` 주평가 기간 실제와 예측', '- `그래프/F2_최대사건_확대.png` 최대 유입 사건 주변 7일',
              '- `그래프/F3_월별_MAE.png` 월별 MAE', '- `그래프/F4_산점도_7-9월.png` 예측 대 실제', '- `그래프/F5_조건별_MAE.png` 조건별 MAE', '']
    (out / '20_결과요약_자동생성.md').write_text('\n'.join(lines), encoding='utf-8')
    print('그래프와 요약 완료')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
