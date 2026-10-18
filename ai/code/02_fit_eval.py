# -*- coding: utf-8 -*-
"""2단계: 네 가지 방법을 같은 발행 시각에 맞추고, 6월 설정 선택 -> 월초 재학습 -> 월별 평가.

실행: python3 02_fit_eval.py <원문23열.csv> <출력폴더>

계획서 규칙 요약
- 방법: 현재값 유지, 최근 6행 평균 유지, Ridge(표준화는 학습 구간으로만), 작은 HistGradientBoosting.
- 6월: 주목표(h=3, L=0, 기본 13 입력) MAE 로 Ridge alpha 와 부스팅 설정을 각각 선택. 동률이면 먼저 적은 설정.
- 7~12월: 매월 1일 00:00 에 그때까지 가용한 표본으로 계수만 다시 학습. 방법, 설정, 지표는 고정.
- 예측값은 0 이상으로 제한하고, 제한 전 음수 예측 수를 기록한다.
- 지평 1과 6, 상태 입력, 평균 목표, 지연 1과 3은 주분석에서 고른 설정을 재사용한다.
- 문제 시각을 참조하는 표본을 뺀 별도 분석을 같은 깨끗한 시험 표본에서 비교한다.
- 24시간과 168시간 블록 부트스트랩으로 짝지은 오차 차이의 범위를 구한다(달 경계를 넘어 잇지 않음).
"""
import itertools
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.path.insert(0, str(Path(__file__).resolve().parent))
from twin_ai_common import build_samples, eval_mask, load_kwater_csv, month_start, train_mask, write_json

RIDGE_ALPHAS = [0.1, 1.0, 10.0, 100.0]
HGB_GRID = [dict(max_leaf_nodes=leaf, min_samples_leaf=msl, l2_regularization=l2)
            for leaf in (7, 15) for msl in (24, 72) for l2 in (0.0, 1.0)]
HGB_FIXED = dict(learning_rate=0.05, max_iter=200, random_state=42, early_stopping=False)
MODEL_VERSION = 'twin-ai-v1.0 (2026-10-18)'
SOURCE = 'K-water 다목적댐 발전량과 수문운영 2024 (공공데이터포털 XLSX, 소양강댐 시트 추출 CSV)'
EVAL_MONTHS = [7, 8, 9, 10, 11, 12]
MAIN_MONTHS = [7, 8, 9]
SECONDARY_MONTHS = [10, 11, 12]
BOOT_REPS = 2000
BOOT_SEED = 42

CONDITIONS = [
    dict(name='main', label='주비교: h=3, L=0, 기본 13 입력, 점 목표', h=3, L=0, state=False, kind='point'),
    dict(name='h1', label='보조 지평: h=1, L=0, 기본 입력', h=1, L=0, state=False, kind='point'),
    dict(name='h6', label='보조 지평: h=6, L=0, 기본 입력', h=6, L=0, state=False, kind='point'),
    dict(name='state', label='추가 상태 입력 6개 포함: h=3, L=0', h=3, L=0, state=True, kind='point'),
    dict(name='mean3', label='평균 목표(다음 3행 평균): h=3 구성, L=0, 기본 입력', h=3, L=0, state=False, kind='mean3'),
    dict(name='L1', label='지연 민감도: h=3, L=1, 기본 입력', h=3, L=1, state=False, kind='point'),
    dict(name='L3', label='지연 민감도: h=3, L=3, 기본 입력', h=3, L=3, state=False, kind='point'),
]


def make_model(kind: str, config: dict):
    if kind == 'ridge':
        return make_pipeline(StandardScaler(), Ridge(alpha=config['alpha']))
    if kind == 'hgb':
        return HistGradientBoostingRegressor(**config, **HGB_FIXED)
    raise ValueError(kind)


def metrics(actual: np.ndarray, pred: np.ndarray, pred_raw: np.ndarray, q_issue: np.ndarray,
            high_threshold: float, train_max: np.ndarray, persistence: np.ndarray | None = None) -> dict:
    err = pred - actual
    out = {'n': int(len(actual)), 'MAE': float(np.mean(np.abs(err))), 'RMSE': float(np.sqrt(np.mean(err ** 2))),
           'bias_mean_pred_minus_actual': float(np.mean(err)), 'negative_predictions_before_clip': int(np.sum(pred_raw < 0))}
    if persistence is not None:
        p_mae = float(np.mean(np.abs(persistence - actual)))
        out['MAE_persistence_same_samples'] = p_mae
        out['MAE_improvement_vs_persistence_abs'] = p_mae - out['MAE']
        out['MAE_improvement_vs_persistence_pct'] = (100.0 * (p_mae - out['MAE']) / p_mae) if p_mae > 0 else None
    zero = actual == 0
    out['zero_target'] = {'n': int(zero.sum()), 'MAE': float(np.mean(np.abs(err[zero]))) if zero.any() else None}
    out['positive_target'] = {'n': int((~zero).sum()), 'MAE': float(np.mean(np.abs(err[~zero]))) if (~zero).any() else None}
    rising = actual > q_issue
    out['rising_subset_post_hoc'] = {'n': int(rising.sum()), 'MAE': float(np.mean(np.abs(err[rising]))) if rising.any() else None,
                                     'definition': '실제 목표 유입량 > 발행 시각 유입량 (사후 분류, 입력 아님)'}
    high = actual >= high_threshold
    under = np.maximum(actual - pred, 0)
    out['high_inflow'] = {'threshold_m3s': float(high_threshold), 'n': int(high.sum()),
                          'underprediction_sum_m3s': float(under[high].sum()) if high.any() else 0.0,
                          'underprediction_mean_m3s': float(under[high].mean()) if high.any() else None,
                          'MAE': float(np.mean(np.abs(err[high]))) if high.any() else None}
    oor = actual > train_max
    out['target_above_training_range'] = {'n': int(oor.sum()), 'MAE': float(np.mean(np.abs(err[oor]))) if oor.any() else None}
    return out


def block_bootstrap_mean(diff: np.ndarray, runs: list[np.ndarray], block: int, reps: int, seed: int) -> dict:
    """runs: 연속 구간별 표본 위치 배열(달 경계를 넘지 않음). 각 구간 안에서 이동 블록을 복원추출한다."""
    rng = np.random.default_rng(seed)
    means = np.empty(reps)
    for r in range(reps):
        pieces = []
        for run in runs:
            n = len(run)
            if n == 0:
                continue
            b = min(block, n)
            starts = rng.integers(0, n - b + 1, size=int(np.ceil(n / b)))
            idx = np.concatenate([run[s:s + b] for s in starts])[:n]
            pieces.append(diff[idx])
        means[r] = np.mean(np.concatenate(pieces))
    return {'block_hours': block, 'replicates': reps, 'point_estimate': float(diff.mean()),
            'ci95': [float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))],
            'ci90': [float(np.percentile(means, 5)), float(np.percentile(means, 95))],
            'contains_zero_95': bool(np.percentile(means, 2.5) <= 0 <= np.percentile(means, 97.5))}


def main(src: Path, out: Path) -> None:
    t_start = time.time()
    out.mkdir(parents=True, exist_ok=True)
    (out / '예측기록').mkdir(exist_ok=True)
    df = load_kwater_csv(src)
    table = build_samples(df)
    frame = table.frame
    high_threshold = float(np.percentile(df.loc[df['t_label'].dt.month <= 6, 'q'], 90))

    # ------------------------------------------------------------------
    # 6월 설정 선택 (주비교 조건만). 학습: r = 6월 1일 00:00 기준 가용 표본.
    # ------------------------------------------------------------------
    main_cond = CONDITIONS[0]
    feats = table.features(main_cond['L'], main_cond['state'])
    target = table.target(main_cond['h'], main_cond['kind'])
    r_june = month_start(2024, 6)
    tr = train_mask(frame, r_june, main_cond['h'], main_cond['L'], main_cond['kind'])
    ev = eval_mask(frame, 6)
    X_tr, y_tr = frame.loc[tr, feats].to_numpy(), frame.loc[tr, target].to_numpy()
    X_ev, y_ev = frame.loc[ev, feats].to_numpy(), frame.loc[ev, target].to_numpy()
    selection = {'tuning_month': '2024-06', 'train_samples': int(tr.sum()), 'tuning_samples': int(ev.sum()),
                 'criterion': '6월 MAE (0 이상 제한 후), 동률이면 목록의 앞 설정', 'ridge': [], 'hgb': []}
    best_ridge, best_hgb = None, None
    for alpha in RIDGE_ALPHAS:
        m = make_model('ridge', {'alpha': alpha}).fit(X_tr, y_tr)
        mae = float(np.mean(np.abs(np.maximum(m.predict(X_ev), 0) - y_ev)))
        selection['ridge'].append({'alpha': alpha, 'june_MAE': mae})
        if best_ridge is None or mae < best_ridge[1] - 1e-12:
            best_ridge = ({'alpha': alpha}, mae)
    for cfg in HGB_GRID:
        m = make_model('hgb', cfg).fit(X_tr, y_tr)
        mae = float(np.mean(np.abs(np.maximum(m.predict(X_ev), 0) - y_ev)))
        selection['hgb'].append({**cfg, 'june_MAE': mae})
        if best_hgb is None or mae < best_hgb[1] - 1e-12:
            best_hgb = (cfg, mae)
    selection['selected'] = {'ridge': best_ridge[0], 'ridge_june_MAE': best_ridge[1], 'hgb': best_hgb[0], 'hgb_june_MAE': best_hgb[1],
                             'hgb_fixed': HGB_FIXED, 'note': '선택 후 특징, 설정, 주지표 고정. 이후 달은 계수만 재학습.'}
    for base_name, col in [('persistence', f'L0_q_latest'), ('mean6', f'L0_mean6_persist')]:
        selection[f'{base_name}_june_MAE'] = float(np.mean(np.abs(frame.loc[ev, col].to_numpy() - y_ev)))
    write_json(out / '10_6월_설정선택.json', selection)
    ridge_cfg, hgb_cfg = best_ridge[0], best_hgb[0]
    print('6월 선택:', ridge_cfg, hgb_cfg, f'({time.time()-t_start:.0f}s)')

    # ------------------------------------------------------------------
    # 조건별 월초 재학습과 예측 기록
    # ------------------------------------------------------------------
    all_records = []
    condition_summaries = {}
    for cond in CONDITIONS:
        feats = table.features(cond['L'], cond['state'])
        target = table.target(cond['h'], cond['kind'])
        target_problem = f"target_problem_h{cond['h']}" if cond['kind'] == 'point' else 'target_problem_mean3'
        target_time_col = f"target_time_h{cond['h']}" if cond['kind'] == 'point' else 'target_time_h3'
        records = []
        for month in [6] + EVAL_MONTHS:
            r = month_start(2024, month)
            tr = train_mask(frame, r, cond['h'], cond['L'], cond['kind'])
            ev = eval_mask(frame, month)
            X_tr, y_tr = frame.loc[tr, feats].to_numpy(), frame.loc[tr, target].to_numpy()
            X_ev, y_ev = frame.loc[ev, feats].to_numpy(), frame.loc[ev, target].to_numpy()
            sub = frame.loc[ev]
            preds = {
                'persistence': (sub[f"L{cond['L']}_q_latest"].to_numpy(), None),
                'mean6': (sub[f"L{cond['L']}_mean6_persist"].to_numpy(), None),
            }
            for kind, cfg in [('ridge', ridge_cfg), ('hgb', hgb_cfg)]:
                model = make_model(kind, cfg).fit(X_tr, y_tr)
                raw = model.predict(X_ev)
                preds[kind] = (np.maximum(raw, 0), raw)
            affected = (sub[f"L{cond['L']}_feature_problem"] | sub[target_problem]).to_numpy()
            for model_name, (p, raw) in preds.items():
                rec = pd.DataFrame({
                    'condition': cond['name'], 'horizon_h': cond['h'], 'delay_L': cond['L'],
                    'feature_set': 'base13+state6' if cond['state'] else 'base13', 'target_kind': cond['kind'],
                    'model': model_name, 'model_version': MODEL_VERSION,
                    'month': month, 'role': '조정월(6월)' if month == 6 else ('주평가' if month in MAIN_MONTHS else '보조평가'),
                    'i': sub['i'].to_numpy(), 'raw_issue_label': sub['raw_issue_label'].to_numpy(),
                    'issue_time': sub['issue_time'].to_numpy(), 'latest_input_time': sub[f"L{cond['L']}_latest_input_time"].to_numpy(),
                    'target_time': sub[target_time_col].to_numpy(),
                    'prediction': p, 'prediction_before_clip': raw if raw is not None else p, 'actual_official': y_ev,
                    'q_at_issue_time': sub['q_issue'].to_numpy(),
                    'refit_time': r, 'n_train': int(tr.sum()), 'train_target_max': float(y_tr.max()),
                    'quality_affected_sample': affected, 'data_source': 'KWATER_2024_SOYANG_HOURLY',
                })
                records.append(rec)
        rec = pd.concat(records, ignore_index=True)
        all_records.append(rec)
        rec_out = rec.copy()
        for col in ['issue_time', 'latest_input_time', 'target_time', 'refit_time']:
            rec_out[col] = pd.DatetimeIndex(rec_out[col]).strftime('%Y-%m-%d %H:%M')
        for col in ['prediction', 'prediction_before_clip', 'actual_official', 'q_at_issue_time', 'train_target_max']:
            rec_out[col] = rec_out[col].round(4)
        rec_out.to_csv(out / '예측기록' / f"predictions_{cond['name']}.csv", index=False, encoding='utf-8-sig')

        # 조건별 요약: 월별 + 기간별
        summary = {'label': cond['label'], 'monthly': {}, 'periods': {}}
        for month in [6] + EVAL_MONTHS:
            summary['monthly'][month] = {}
            for model_name in ['persistence', 'mean6', 'ridge', 'hgb']:
                s = rec[(rec['month'] == month) & (rec['model'] == model_name)]
                pers = rec[(rec['month'] == month) & (rec['model'] == 'persistence')]['prediction'].to_numpy()
                summary['monthly'][month][model_name] = metrics(s['actual_official'].to_numpy(), s['prediction'].to_numpy(),
                                                               s['prediction_before_clip'].to_numpy(), s['q_at_issue_time'].to_numpy(),
                                                               high_threshold, s['train_target_max'].to_numpy(), pers)
        for period_name, months in [('주평가_7-9월', MAIN_MONTHS), ('보조평가_10-12월', SECONDARY_MONTHS)]:
            summary['periods'][period_name] = {}
            for model_name in ['persistence', 'mean6', 'ridge', 'hgb']:
                s = rec[(rec['month'].isin(months)) & (rec['model'] == model_name)]
                pers = rec[(rec['month'].isin(months)) & (rec['model'] == 'persistence')]['prediction'].to_numpy()
                summary['periods'][period_name][model_name] = metrics(s['actual_official'].to_numpy(), s['prediction'].to_numpy(),
                                                                     s['prediction_before_clip'].to_numpy(), s['q_at_issue_time'].to_numpy(),
                                                                     high_threshold, s['train_target_max'].to_numpy(), pers)
        condition_summaries[cond['name']] = summary
        print('조건 완료:', cond['name'], f'({time.time()-t_start:.0f}s)')

    write_json(out / '예측기록' / '_열설명.json', {
        'data_source': {'KWATER_2024_SOYANG_HOURLY': SOURCE},
        'evaluation_type': '최종 공개자료를 이용한 후향 평가 (L=0 은 즉시 가용 가정). 실시간 운용 검증이 아님.',
        'columns': {
            'condition': '조건 이름 (main, h1, h6, state, mean3, L1, L3)', 'horizon_h': '지평 h (시간)', 'delay_L': '지연 L (시간)',
            'feature_set': 'base13 또는 base13+state6', 'target_kind': 'point=q(t+h), mean3=다음 3행 평균',
            'model': 'persistence, mean6, ridge, hgb', 'model_version': MODEL_VERSION, 'month': '발행 시각의 달(분석 라벨)',
            'role': '조정월(6월) / 주평가(7~9월) / 보조평가(10~12월)', 'i': '발행 행 번호(원문 0행 = 2024010101)',
            'raw_issue_label': '원문 발행 시각 YYYYMMDDHH', 'issue_time': '발행 시각 분석 라벨', 'latest_input_time': '입력에 쓴 최신 행의 시각 (t-L)',
            'target_time': '목표 시각 (t+h; 평균 목표는 t+3)', 'prediction': '0 이상 제한 후 예측값 m³/s', 'prediction_before_clip': '제한 전 예측값',
            'actual_official': '나중에 대조한 공개 총유입량 m³/s', 'q_at_issue_time': '발행 시각의 공개 유입량(사후 분류용)',
            'refit_time': '이 예측에 쓴 모형의 재학습 시각', 'n_train': '학습 표본 수', 'train_target_max': '학습 목표 최댓값(학습 범위 초과 판정용)',
            'quality_affected_sample': '문제 시각을 입력 또는 목표 원천 행으로 쓰는 표본이면 true', 'data_source': '자료 출처 키',
        },
    })
    write_json(out / '11_조건별_성능표.json', {'high_inflow_threshold_m3s_p90_jan_jun': high_threshold,
                                             'selected': selection['selected'], 'conditions': condition_summaries})

    # ------------------------------------------------------------------
    # 주비교: 7~9월 HGB 대 Ridge MAE 차이 + 블록 부트스트랩
    # ------------------------------------------------------------------
    main_rec = all_records[0]
    main_eval = main_rec[main_rec['month'].isin(MAIN_MONTHS)]
    pivot = main_eval.pivot_table(index='i', columns='model', values='prediction')
    actual = main_eval[main_eval['model'] == 'hgb'].set_index('i')['actual_official'].reindex(pivot.index)
    months_of_i = main_eval[main_eval['model'] == 'hgb'].set_index('i')['month'].reindex(pivot.index)
    abs_err = {m: np.abs(pivot[m].to_numpy() - actual.to_numpy()) for m in pivot.columns}
    # 연속 구간: 각 달의 평가 표본은 i 가 연속이므로 달별 한 구간. 달 경계를 넘어 잇지 않는다.
    positions = np.arange(len(pivot))
    runs = [positions[months_of_i.to_numpy() == m] for m in MAIN_MONTHS]
    for run in runs:
        assert np.all(np.diff(pivot.index.to_numpy()[run]) == 1), '평가 표본이 달 안에서 연속이어야 한다'
    boot = {}
    for a, b in [('hgb', 'ridge'), ('hgb', 'persistence'), ('hgb', 'mean6'), ('ridge', 'persistence'), ('ridge', 'mean6')]:
        diff = abs_err[a] - abs_err[b]
        boot[f'{a}_minus_{b}_absolute_error'] = {str(block): block_bootstrap_mean(diff, runs, block, BOOT_REPS, BOOT_SEED) for block in (24, 168)}
    main_summary = {
        'definition': '7~9월, L=0, h=3, 기본 13 입력, 점 목표. 같은 발행 시각과 같은 정보에서 네 방법 비교. 예측은 0 이상 제한.',
        'n_samples': int(len(pivot)),
        'MAE': {m: float(abs_err[m].mean()) for m in pivot.columns},
        'RMSE': {m: float(np.sqrt(np.mean((pivot[m].to_numpy() - actual.to_numpy()) ** 2))) for m in pivot.columns},
        'bias': {m: float(np.mean(pivot[m].to_numpy() - actual.to_numpy())) for m in pivot.columns},
        'primary_difference_MAE_hgb_minus_ridge': float(abs_err['hgb'].mean() - abs_err['ridge'].mean()),
        'paired_block_bootstrap': boot,
        'reading_rule': '점추정 차이가 음수(HGB 오차가 더 작음)이고 95% 범위가 0을 포함하지 않을 때만 개선 근거가 있다고 적는다. '
                        '최근 6행 평균보다 나쁘면 단순 방법 전체보다 우수하다고 쓰지 않는다.',
    }
    write_json(out / '12_주비교_7-9월.json', main_summary)
    print('주비교 MAE:', main_summary['MAE'], f'({time.time()-t_start:.0f}s)')

    # ------------------------------------------------------------------
    # 문제 시각 제외 분석 (주비교 조건)
    # ------------------------------------------------------------------
    cond = main_cond
    feats = table.features(cond['L'], cond['state'])
    target = table.target(cond['h'], cond['kind'])
    affected_all = (frame[f"L{cond['L']}_feature_problem"] | frame[f"target_problem_h{cond['h']}"]).to_numpy()
    excl = {'definition': '문제 시각(교차확인.json 의 21개)을 입력 또는 목표의 원천 행으로 쓰는 표본 전체를 학습과 평가에서 제외. '
                          '시간 격자는 유지하고, 영향받는 표본만 뺀다(행 삭제 후 당기기 금지).',
            'affected_samples_total': int(affected_all.sum()), 'months': {}}
    for month in MAIN_MONTHS + SECONDARY_MONTHS:
        r = month_start(2024, month)
        tr = train_mask(frame, r, cond['h'], cond['L'], cond['kind'])
        ev = eval_mask(frame, month)
        ev_clean = ev & ~affected_all
        tr_clean = tr & ~affected_all
        X_ev, y_ev = frame.loc[ev_clean, feats].to_numpy(), frame.loc[ev_clean, target].to_numpy()
        pers = frame.loc[ev_clean, f"L{cond['L']}_q_latest"].to_numpy()
        res = {'n_eval_original': int(ev.sum()), 'n_eval_clean': int(ev_clean.sum()),
               'n_train_original': int(tr.sum()), 'n_train_clean': int(tr_clean.sum()),
               'MAE_persistence_clean_samples': float(np.mean(np.abs(pers - y_ev)))}
        for kind, cfg in [('ridge', ridge_cfg), ('hgb', hgb_cfg)]:
            m_orig = make_model(kind, cfg).fit(frame.loc[tr, feats].to_numpy(), frame.loc[tr, target].to_numpy())
            m_clean = make_model(kind, cfg).fit(frame.loc[tr_clean, feats].to_numpy(), frame.loc[tr_clean, target].to_numpy())
            res[f'{kind}_MAE_original_fit_on_clean_samples'] = float(np.mean(np.abs(np.maximum(m_orig.predict(X_ev), 0) - y_ev)))
            res[f'{kind}_MAE_clean_fit_on_clean_samples'] = float(np.mean(np.abs(np.maximum(m_clean.predict(X_ev), 0) - y_ev)))
        excl['months'][month] = res
    write_json(out / '13_문제시각_제외분석.json', excl)
    print('제외 분석 완료', f'({time.time()-t_start:.0f}s)')

    # ------------------------------------------------------------------
    # TWIN 프로그램 연결용 내보내기 (주비교 조건, 6~12월 전체)
    # ------------------------------------------------------------------
    export_rows = []
    piv = main_rec.pivot_table(index='i', columns='model', values='prediction')
    meta_i = main_rec[main_rec['model'] == 'hgb'].set_index('i')
    for i, row in piv.iterrows():
        m = meta_i.loc[i]
        export_rows.append({
            'raw_issue_label': str(m['raw_issue_label']),
            'issue_time': pd.Timestamp(m['issue_time']).strftime('%Y-%m-%d %H:%M'),
            'latest_input_time': pd.Timestamp(m['latest_input_time']).strftime('%Y-%m-%d %H:%M'),
            'target_time': pd.Timestamp(m['target_time']).strftime('%Y-%m-%d %H:%M'),
            'horizon_h': 3, 'delay_L': 0, 'role': m['role'],
            'actual_official_m3s': float(m['actual_official']),
            'persistence': float(row['persistence']), 'mean6': float(row['mean6']), 'ridge': float(row['ridge']), 'hgb': float(row['hgb']),
            'quality_affected_sample': bool(m['quality_affected_sample']),
        })
    export = {
        'kind': 'TWIN AI v1 예측 기록 (3D 프로그램 표시용)',
        'generated_on': datetime.now().strftime('%Y-%m-%d %H:%M'),
        'model_version': MODEL_VERSION, 'data_source': SOURCE,
        'time_convention': '원문 YYYYMMDDHH 보존, 분석 라벨은 24시를 다음 날 00:00 으로 환산. 시간대와 구간 의미 미확인.',
        'delay_assumption': 'L=0: 이상적인 즉시 가용 가정',
        'labels': {'actual_official_m3s': '공개 총유입량(사후 대조)', 'persistence': '현재값 유지', 'mean6': '최근 6행 평균 유지',
                   'ridge': f"Ridge alpha={ridge_cfg['alpha']}", 'hgb': 'HistGradientBoosting ' + json.dumps(hgb_cfg)},
        'display_notes': ['과거 공개자료 기반 예측 시연', '자동 방류 명령이 아님', '실시간 아님(2024년 자료)',
                          '오차 띠는 검증 전이므로 생략', '예측 유입량을 발전량 증가로 환산하지 않음'],
        'summary_main_jul_sep': {'MAE': main_summary['MAE'], 'n': main_summary['n_samples']},
        'series': export_rows,
    }
    write_json(out / '14_TWIN연결_예측기록_주비교.json', export)
    pd.DataFrame(export_rows).to_csv(out / '14_TWIN연결_예측기록_주비교.csv', index=False, encoding='utf-8-sig')
    print('완료', f'({time.time()-t_start:.0f}s)')


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
