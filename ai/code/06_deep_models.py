# -*- coding: utf-8 -*-
"""6단계: LSTM 과 Transformer 유입 예측 모형. 02단계와 같은 규약으로 학습, 선택, 재학습, 평가한다.

실행: python3 06_deep_models.py <원문23열.csv> <출력폴더> [--quick]

규약 (02_fit_eval.py 와 같은 틀)
- 입력: 발행 시각 t 까지의 48시간 창. 채널은 표준화한 log1p(유입량)과 시각(hour) sin, cos.
  'state' 변형은 log1p(총방류량), 저수위, 저수량을 표준화해 채널로 추가한다. 표준화 통계는 학습 구간에서만 계산한다.
- 목표: h = 1..24 시간 뒤 유입량을 한 번에 예측한다(24 출력). 출력은 log1p 공간의 변화량
  d_h = log1p(q(t+h)) - log1p(q(t)) 이며, 예측값은 expm1(log1p(q(t)) + d_h) 를 0 이상으로 제한한 값이다.
- 손실: 원 단위 MAE 를 학습 표준편차로 나눈 값(평가 지표와 같은 단위), 지평 24개 동일 가중.
- 6월 선택: 6월 1일 00:00 기준 가용 표본으로 학습하고 6월 표본의 h=3 MAE 가 가장 작은 (설정, 에폭) 을 고른다.
  이후 설정과 에폭 수를 고정하고, 7~9월(주평가)과 10~12월(보조평가)은 매월 1일 00:00 기준 가용 표본으로
  가중치만 다시 학습한다. 시드 3개를 각각 학습해 평균(앙상블)을 모형의 예측으로 쓰고 시드별 편차를 기록한다.
- 비교: 02단계가 저장한 같은 발행 시각의 유지, 6행 평균, Ridge, HGB 예측기록과 짝지어 비교한다(h=1, 3, 6).
  h=12, 24 는 Ridge 기록이 없으므로 유지 기준선과만 비교하고, 발행 시각과 t+24 가 같은 달인 표본으로 제한한다.
- 내보내기: 6월 선택에서 이긴 구조의 7월 1일 재학습 모형(학습 2024-01~06, 시드 0)을 가중치 JSON 으로 저장해
  TWIN 프로그램이 브라우저 안에서 같은 계산을 재현하게 한다. 검증 벡터 64개를 함께 저장한다.
이 코드는 최종 공개자료를 이용한 후향 평가용이다. 실시간 운용 검증이 아니다.
"""
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from twin_ai_common import build_samples, eval_mask, label_to_index, load_kwater_csv, month_start, write_json  # noqa: E402

QUICK = '--quick' in sys.argv
WINDOW = 48
HORIZONS_ALL = list(range(1, 25))
MAIN_H = (1, 3, 6)
EXT_H = (12, 24)
MAIN_MONTHS = [7, 8, 9]
SECONDARY_MONTHS = [10, 11, 12]
SEEDS = [0, 1, 2]
MAX_EPOCHS = 6 if QUICK else 40
MIN_EPOCH = 1 if QUICK else 5
BATCH = 64
MODEL_VERSION = 'twin-ai-v2 deep (2026-10-19)'
BOOT_REPS = 2000
BOOT_SEED = 42
torch.set_num_threads(2)

GRID = {
    'lstm': [dict(hidden=32, layers=1), dict(hidden=64, layers=1), dict(hidden=32, layers=2), dict(hidden=64, layers=2)],
    'transformer': [dict(d_model=32, layers=1, heads=4), dict(d_model=64, layers=1, heads=4),
                    dict(d_model=32, layers=2, heads=4), dict(d_model=64, layers=2, heads=4)],
}
if QUICK:
    GRID = {'lstm': GRID['lstm'][:1], 'transformer': GRID['transformer'][:1]}
LR = {'lstm': 2e-3, 'transformer': 1e-3}
WEIGHT_DECAY = 1e-4
CLIP = 1.0


# ----------------------------------------------------------------------------- data
class Channels:
    """시계열 채널 생성. 표준화 통계는 학습 구간 행(refit 시각 이전)에서만 계산한다."""

    def __init__(self, df: pd.DataFrame, with_state: bool):
        self.with_state = with_state
        self.logq = np.log1p(df['q'].to_numpy(dtype=float))
        self.logrel = np.log1p(np.maximum(df['release'].to_numpy(dtype=float), 0.0))
        self.level = df['level'].to_numpy(dtype=float)
        self.storage = df['storage'].to_numpy(dtype=float)
        hours = pd.DatetimeIndex(df['t_label']).hour.to_numpy()
        self.hsin = np.sin(2 * np.pi * hours / 24.0)
        self.hcos = np.cos(2 * np.pi * hours / 24.0)
        self.q = df['q'].to_numpy(dtype=float)

    def stats(self, upto_index: int) -> dict:
        sl = slice(0, upto_index)
        st = {'logq_mean': float(self.logq[sl].mean()), 'logq_std': float(self.logq[sl].std() + 1e-6),
              'q_std': float(self.q[sl].std() + 1e-6)}
        if self.with_state:
            st.update({'logrel_mean': float(self.logrel[sl].mean()), 'logrel_std': float(self.logrel[sl].std() + 1e-6),
                       'level_mean': float(self.level[sl].mean()), 'level_std': float(self.level[sl].std() + 1e-6),
                       'storage_mean': float(self.storage[sl].mean()), 'storage_std': float(self.storage[sl].std() + 1e-6)})
        return st

    def names(self) -> list[str]:
        base = ['logq_z', 'hour_sin', 'hour_cos']
        return base + (['logrel_z', 'level_z', 'storage_z'] if self.with_state else [])

    def windows(self, idx: np.ndarray, st: dict) -> np.ndarray:
        """idx: 발행 행 번호 배열 -> (N, WINDOW, C) 배열. 창은 [i-47, i]."""
        offs = np.arange(-WINDOW + 1, 1)
        rows = idx[:, None] + offs[None, :]
        chans = [(self.logq[rows] - st['logq_mean']) / st['logq_std'], self.hsin[rows], self.hcos[rows]]
        if self.with_state:
            chans += [(self.logrel[rows] - st['logrel_mean']) / st['logrel_std'],
                      (self.level[rows] - st['level_mean']) / st['level_std'],
                      (self.storage[rows] - st['storage_mean']) / st['storage_std']]
        return np.stack(chans, axis=-1).astype(np.float32)

    def targets(self, idx: np.ndarray) -> np.ndarray:
        rows = idx[:, None] + np.array(HORIZONS_ALL)[None, :]
        return self.q[rows].astype(np.float32)


def deep_train_mask(frame: pd.DataFrame, refit_time: datetime) -> np.ndarray:
    """재학습 시각 r 에 허용되는 학습 표본: 가장 먼 목표 행 i+24 의 시각 < r (L=0)."""
    r_index = label_to_index(refit_time)
    i = frame['i'].to_numpy()
    return (i + HORIZONS_ALL[-1]) < r_index


# ----------------------------------------------------------------------------- models
class LSTMForecaster(nn.Module):
    def __init__(self, n_in: int, hidden: int, layers: int, n_out: int):
        super().__init__()
        self.lstm = nn.LSTM(n_in, hidden, num_layers=layers, batch_first=True, dropout=0.1 if layers > 1 else 0.0)
        self.head = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, n_out))

    def forward(self, x):
        out, _ = self.lstm(x)
        return self.head(out[:, -1, :])


class TransformerForecaster(nn.Module):
    def __init__(self, n_in: int, d_model: int, layers: int, heads: int, n_out: int, seq_len: int = WINDOW):
        super().__init__()
        self.proj = nn.Linear(n_in, d_model)
        self.pos = nn.Parameter(torch.zeros(seq_len, d_model))
        nn.init.normal_(self.pos, std=0.02)
        layer = nn.TransformerEncoderLayer(d_model, heads, dim_feedforward=2 * d_model, dropout=0.1,
                                           activation='gelu', batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, num_layers=layers, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d_model)
        self.head = nn.Sequential(nn.Linear(d_model, d_model), nn.GELU(), nn.Linear(d_model, n_out))

    def forward(self, x):
        h = self.proj(x) + self.pos
        h = self.encoder(h)
        h = self.norm(h[:, -1, :])
        return self.head(h)


def build_model(kind: str, cfg: dict, n_in: int) -> nn.Module:
    if kind == 'lstm':
        return LSTMForecaster(n_in, cfg['hidden'], cfg['layers'], len(HORIZONS_ALL))
    return TransformerForecaster(n_in, cfg['d_model'], cfg['layers'], cfg['heads'], len(HORIZONS_ALL))


def predict_raw(model: nn.Module, x: torch.Tensor, logq_t: torch.Tensor) -> torch.Tensor:
    """log 변화량 출력을 원 단위 예측(0 이상)으로 바꾼다."""
    d = torch.clamp(model(x), -4.0, 4.0)
    return torch.clamp(torch.expm1(logq_t[:, None] + d), min=0.0)


def train_one(kind: str, cfg: dict, X: np.ndarray, Y: np.ndarray, logq_t: np.ndarray, q_std: float, epochs: int, seed: int,
              eval_fn=None) -> tuple[nn.Module, list]:
    torch.manual_seed(seed)
    np.random.seed(seed)
    model = build_model(kind, cfg, X.shape[-1])
    opt = torch.optim.AdamW(model.parameters(), lr=LR[kind], weight_decay=WEIGHT_DECAY)
    Xt, Yt, Lt = torch.from_numpy(X), torch.from_numpy(Y), torch.from_numpy(logq_t.astype(np.float32))
    n = len(Xt)
    history = []
    gen = torch.Generator().manual_seed(seed)
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n, generator=gen)
        total = 0.0
        for b in range(0, n, BATCH):
            sel = perm[b:b + BATCH]
            pred = predict_raw(model, Xt[sel], Lt[sel])
            loss = torch.mean(torch.abs(pred - Yt[sel])) / q_std
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), CLIP)
            opt.step()
            total += float(loss) * len(sel)
        rec = {'epoch': epoch, 'train_loss': total / n}
        if eval_fn is not None:
            rec.update(eval_fn(model))
        history.append(rec)
    return model, history


def predict_numpy(model: nn.Module, X: np.ndarray, logq_t: np.ndarray) -> np.ndarray:
    model.eval()
    with torch.no_grad():
        out = []
        for b in range(0, len(X), 512):
            out.append(predict_raw(model, torch.from_numpy(X[b:b + 512]), torch.from_numpy(logq_t[b:b + 512].astype(np.float32))).numpy())
    return np.concatenate(out) if out else np.zeros((0, len(HORIZONS_ALL)), dtype=np.float32)


# ----------------------------------------------------------------------------- helpers
def block_bootstrap_mean(diff: np.ndarray, runs: list, block: int, reps: int, seed: int) -> dict:
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


def mae(a, b):
    return float(np.mean(np.abs(np.asarray(a) - np.asarray(b))))


def rmse(a, b):
    return float(np.sqrt(np.mean((np.asarray(a) - np.asarray(b)) ** 2)))


def state_dict_json(model: nn.Module) -> dict:
    return {k: v.detach().cpu().numpy().round(7).tolist() for k, v in model.state_dict().items()}


# ----------------------------------------------------------------------------- main
def main(src: Path, out: Path) -> None:
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    (out / '예측기록').mkdir(exist_ok=True)
    df = load_kwater_csv(src)
    frame = build_samples(df).frame
    i_all = frame['i'].to_numpy()
    month_t24 = pd.DatetimeIndex(df['t_label']).month.to_numpy()[np.minimum(i_all + 24, len(df) - 1)]
    frame['eligible_ext24'] = (frame['month'].to_numpy() == month_t24) & ((i_all + 24) < len(df))
    channel_sets = {'base': Channels(df, False), 'state': Channels(df, True)}
    logq_all = channel_sets['base'].logq

    # 02단계의 기준선 예측기록(같은 발행 시각)을 읽는다.
    baseline = {}
    for cond, h in [('h1', 1), ('main', 3), ('h6', 6)]:
        rec = pd.read_csv(out / '예측기록' / f'predictions_{cond}.csv')
        baseline[h] = rec.pivot_table(index=['month', 'i'], columns='model', values='prediction')

    # ------------------------------------------------------------------ 6월 선택
    r_june = month_start(2024, 6)
    selection = {'tuning_month': '2024-06', 'criterion': '6월 h=3 MAE (0 이상 제한 후, 에폭 >= %d), 동률이면 먼저 나온 설정' % MIN_EPOCH,
                 'window_hours': WINDOW, 'horizons': HORIZONS_ALL, 'max_epochs': MAX_EPOCHS, 'batch': BATCH, 'lr': LR,
                 'weight_decay': WEIGHT_DECAY, 'grad_clip': CLIP, 'runs': []}
    tr = deep_train_mask(frame, r_june)
    ev = eval_mask(frame, 6)
    best = {}
    for feat_name, ch in channel_sets.items():
        st = ch.stats(label_to_index(r_june))
        X_tr, Y_tr = ch.windows(i_all[tr], st), ch.targets(i_all[tr])
        X_ev, Y_ev = ch.windows(i_all[ev], st), ch.targets(i_all[ev])
        L_tr, L_ev = logq_all[i_all[tr]], logq_all[i_all[ev]]
        for kind, cfgs in GRID.items():
            if feat_name == 'state' and kind == 'transformer' and not QUICK:
                pass  # 두 구조 모두 상태 채널 변형을 돌린다
            for cfg in cfgs:
                def eval_fn(model):
                    p = predict_numpy(model, X_ev, L_ev)
                    return {f'june_MAE_h{h}': mae(p[:, h - 1], Y_ev[:, h - 1]) for h in MAIN_H}
                _, hist = train_one(kind, cfg, X_tr, Y_tr, L_tr, st['q_std'], MAX_EPOCHS, seed=0, eval_fn=eval_fn)
                run = {'model': kind, 'features': feat_name, 'config': cfg, 'history': hist}
                selection['runs'].append(run)
                ok = [r for r in hist if r['epoch'] >= MIN_EPOCH]
                b = min(ok, key=lambda r: r['june_MAE_h3'])
                key = (kind, feat_name)
                if key not in best or b['june_MAE_h3'] < best[key]['june_MAE_h3'] - 1e-9:
                    best[key] = {'config': cfg, 'epochs': b['epoch'], 'june_MAE_h3': b['june_MAE_h3'], 'june_MAE_h1': b['june_MAE_h1'], 'june_MAE_h6': b['june_MAE_h6']}
                print(f'선택 실행 {kind} {feat_name} {cfg}: best epoch {b["epoch"]} MAE_h3 {b["june_MAE_h3"]:.2f} ({time.time()-t0:.0f}s)', flush=True)
    selection['selected'] = {f'{k}/{f}': v for (k, f), v in best.items()}
    for h in MAIN_H:
        bl = baseline[h].loc[6]
        selection[f'june_MAE_h{h}_baselines'] = {m: mae(bl[m].to_numpy(), frame.loc[ev, f'y_h{h}'].to_numpy()) for m in ['persistence', 'mean6', 'ridge', 'hgb']}
    # 주비교에 쓰는 구조별 설정: 기본 채널(base) 중 6월 MAE 가 더 작은 것
    main_choice = {kind: best[(kind, 'base')] for kind in GRID}
    winner = min(main_choice, key=lambda k: main_choice[k]['june_MAE_h3'])
    selection['main_choice_base_features'] = main_choice
    selection['winner_by_june'] = winner
    write_json(out / '40_6월_딥러닝_설정선택.json', selection)
    print('6월 선택 완료:', {k: (v['config'], v['epochs'], round(v['june_MAE_h3'], 2)) for k, v in main_choice.items()}, '승자', winner, flush=True)

    # ------------------------------------------------------------------ 월초 재학습 (3 시드) + 예측기록
    eval_months = MAIN_MONTHS + ([] if QUICK else SECONDARY_MONTHS)
    records = []  # (model, features, month, seed or 'ens', i, horizon, prediction, actual)
    ensembles = {}  # (kind, feat, month) -> (i_ev, pred_ens (N,24), per-seed list)
    shipped = None
    for kind in GRID:
        for feat_name in ['base', 'state']:
            choice = best[(kind, feat_name)]
            ch = channel_sets[feat_name]
            for month in eval_months:
                r = month_start(2024, month)
                st = ch.stats(label_to_index(r))
                tr = deep_train_mask(frame, r)
                ev = eval_mask(frame, month) | ((frame['month'].to_numpy() == month) & frame['eligible_ext24'].to_numpy())
                X_tr, Y_tr, L_tr = ch.windows(i_all[tr], st), ch.targets(i_all[tr]), logq_all[i_all[tr]]
                X_ev, L_ev = ch.windows(i_all[ev], st), logq_all[i_all[ev]]
                seed_preds = []
                for seed in SEEDS:
                    model, _ = train_one(kind, choice['config'], X_tr, Y_tr, L_tr, st['q_std'], choice['epochs'], seed=seed)
                    seed_preds.append(predict_numpy(model, X_ev, L_ev))
                    if kind == winner and feat_name == 'base' and month == 7 and seed == 0:
                        shipped = {'model': model, 'stats': st, 'config': choice['config'], 'epochs': choice['epochs'],
                                   'features': ch.names(), 'n_train': int(tr.sum()), 'refit_time': r,
                                   'X_ev': X_ev, 'L_ev': L_ev, 'i_ev': i_all[ev]}
                ens = np.mean(seed_preds, axis=0)
                ensembles[(kind, feat_name, month)] = (i_all[ev], ens, seed_preds)
                print(f'재학습 {kind}/{feat_name} {month}월 완료 (n_train={int(tr.sum())}, n_eval={int(ev.sum())}) ({time.time()-t0:.0f}s)', flush=True)

    # ------------------------------------------------------------------ 지표표: 같은 표본에서 기준선과 비교
    def period_table(kind, feat_name, months, horizons):
        res = {}
        for h in horizons:
            rows_a, rows_p, rows_b = [], [], {m: [] for m in ['persistence', 'mean6', 'ridge', 'hgb']}
            seeds_abs = []
            for month in months:
                i_ev, ens, seed_preds = ensembles[(kind, feat_name, month)]
                if h in MAIN_H:
                    bl = baseline[h].loc[month]
                    common = np.intersect1d(i_ev, bl.index.to_numpy())
                else:
                    elig = frame.set_index('i').loc[i_ev, 'eligible_ext24'].to_numpy()
                    common = i_ev[elig]
                pos = np.searchsorted(i_ev, common)
                actual = df['q'].to_numpy()[common + h]
                rows_a.append(actual); rows_p.append(ens[pos, h - 1])
                seeds_abs.append(np.stack([np.abs(sp[pos, h - 1] - actual) for sp in seed_preds]))
                for m in rows_b:
                    if h in MAIN_H:
                        rows_b[m].append(bl.loc[common, m].to_numpy())
                    elif m == 'persistence':
                        rows_b[m].append(df['q'].to_numpy()[common])
            a, p = np.concatenate(rows_a), np.concatenate(rows_p)
            entry = {'n': int(len(a)), 'MAE': mae(p, a), 'RMSE': rmse(p, a), 'bias_mean_pred_minus_actual': float(np.mean(p - a)),
                     'seed_MAE': [float(x) for x in np.concatenate(seeds_abs, axis=1).mean(axis=1)]}
            for m, parts in rows_b.items():
                if parts:
                    b = np.concatenate(parts)
                    entry[f'MAE_{m}_same_samples'] = mae(b, a)
            if 'MAE_persistence_same_samples' in entry:
                pm = entry['MAE_persistence_same_samples']
                entry['MAE_improvement_vs_persistence_pct'] = 100.0 * (pm - entry['MAE']) / pm if pm > 0 else None
            if 'MAE_ridge_same_samples' in entry:
                rm_ = entry['MAE_ridge_same_samples']
                entry['MAE_improvement_vs_ridge_pct'] = 100.0 * (rm_ - entry['MAE']) / rm_ if rm_ > 0 else None
            res[f'h{h}'] = entry
        return res

    perf = {'model_version': MODEL_VERSION, 'selected': selection['selected'], 'winner_by_june': winner, 'conditions': {}}
    for kind in GRID:
        for feat_name in ['base', 'state']:
            key = f'{kind}/{feat_name}'
            perf['conditions'][key] = {'monthly': {}, 'periods': {}}
            for month in eval_months:
                perf['conditions'][key]['monthly'][month] = period_table(kind, feat_name, [month], MAIN_H + EXT_H)
            perf['conditions'][key]['periods']['주평가_7-9월'] = period_table(kind, feat_name, MAIN_MONTHS, MAIN_H + EXT_H)
            if not QUICK:
                perf['conditions'][key]['periods']['보조평가_10-12월'] = period_table(kind, feat_name, SECONDARY_MONTHS, MAIN_H + EXT_H)
    write_json(out / '41_딥러닝_조건별_성능표.json', perf)

    # ------------------------------------------------------------------ 주비교 (7~9월, h=3, base 채널): 블록 부트스트랩
    main_cmp = {'definition': '7~9월, L=0, h=3, 48시간 창 기본 채널, 시드 3개 평균. 02단계 기준선과 같은 발행 시각에서 비교. 예측은 0 이상 제한.'}
    i_list, pred_cols = [], {k: [] for k in ['lstm', 'transformer', 'persistence', 'mean6', 'ridge', 'hgb']}
    months_of = []
    for month in MAIN_MONTHS:
        bl = baseline[3].loc[month]
        i_l, ens_l, _ = ensembles[('lstm', 'base', month)]
        i_t, ens_t, _ = ensembles[('transformer', 'base', month)]
        common = np.intersect1d(np.intersect1d(i_l, i_t), bl.index.to_numpy())
        pred_cols['lstm'].append(ens_l[np.searchsorted(i_l, common), 2])
        pred_cols['transformer'].append(ens_t[np.searchsorted(i_t, common), 2])
        for m in ['persistence', 'mean6', 'ridge', 'hgb']:
            pred_cols[m].append(bl.loc[common, m].to_numpy())
        i_list.append(common); months_of.append(np.full(len(common), month))
    i_arr = np.concatenate(i_list); months_arr = np.concatenate(months_of)
    actual = df['q'].to_numpy()[i_arr + 3]
    preds = {k: np.concatenate(v) for k, v in pred_cols.items()}
    abs_err = {k: np.abs(v - actual) for k, v in preds.items()}
    positions = np.arange(len(i_arr))
    runs = [positions[months_arr == m] for m in MAIN_MONTHS]
    for run in runs:
        assert np.all(np.diff(i_arr[run]) == 1)
    boot = {}
    for a, b in [('lstm', 'ridge'), ('lstm', 'persistence'), ('transformer', 'ridge'), ('transformer', 'persistence'), ('lstm', 'transformer')]:
        diff = abs_err[a] - abs_err[b]
        boot[f'{a}_minus_{b}_absolute_error'] = {str(block): block_bootstrap_mean(diff, runs, block, BOOT_REPS, BOOT_SEED) for block in (24, 168)}
    main_cmp.update({'n_samples': int(len(i_arr)), 'MAE': {k: float(v.mean()) for k, v in abs_err.items()},
                     'RMSE': {k: rmse(preds[k], actual) for k in preds}, 'bias': {k: float(np.mean(preds[k] - actual)) for k in preds},
                     'paired_block_bootstrap': boot,
                     'reading_rule': '점추정 차이가 음수(딥러닝 오차가 더 작음)이고 95% 범위가 0을 포함하지 않을 때만 개선 근거가 있다고 적는다.'})
    write_json(out / '42_딥러닝_주비교_7-9월.json', main_cmp)
    print('주비교 MAE:', {k: round(v, 2) for k, v in main_cmp['MAE'].items()}, flush=True)

    # ------------------------------------------------------------------ 예측기록 CSV (base 채널, 앙상블, h=1..24)
    rows = []
    for kind in GRID:
        for month in eval_months:
            i_ev, ens, seed_preds = ensembles[(kind, 'base', month)]
            spread = np.std(np.stack(seed_preds), axis=0)
            for n, i in enumerate(i_ev):
                row = {'model': kind, 'features': 'base', 'month': month, 'i': int(i),
                       'issue_time': df['t_label'].iloc[i].strftime('%Y-%m-%d %H:%M'), 'q_at_issue_time': round(float(df['q'].iloc[i]), 3)}
                for h in HORIZONS_ALL:
                    row[f'pred_h{h:02d}'] = round(float(ens[n, h - 1]), 3)
                    row[f'actual_h{h:02d}'] = round(float(df['q'].iloc[i + h]), 3) if i + h < len(df) else None
                row['seed_spread_h03'] = round(float(spread[n, 2]), 3)
                rows.append(row)
    pd.DataFrame(rows).to_csv(out / '예측기록' / 'predictions_deep_base.csv', index=False, encoding='utf-8-sig')

    # ------------------------------------------------------------------ 내보내기: 승자 구조의 7월 1일 재학습 모형 (시드 0)
    assert shipped is not None
    model = shipped['model']
    model.eval()
    X_ev, L_ev, i_ev = shipped['X_ev'], shipped['L_ev'], shipped['i_ev']
    pick = np.linspace(0, len(X_ev) - 1, 64).astype(int)
    with torch.no_grad():
        vec_out = predict_raw(model, torch.from_numpy(X_ev[pick]), torch.from_numpy(L_ev[pick].astype(np.float32))).numpy()
        vec_delta = torch.clamp(model(torch.from_numpy(X_ev[pick])), -4.0, 4.0).numpy()
    # 6월 검증 잔차 분위수 (선택 단계의 승자 설정을 6월 1일 기준으로 다시 학습해 계산)
    ch = channel_sets['base']
    st6 = ch.stats(label_to_index(r_june))
    tr6 = deep_train_mask(frame, r_june)
    ev6 = eval_mask(frame, 6)
    m6, _ = train_one(winner, shipped['config'], ch.windows(i_all[tr6], st6), ch.targets(i_all[tr6]), logq_all[i_all[tr6]], st6['q_std'], shipped['epochs'], seed=0)
    p6 = predict_numpy(m6, ch.windows(i_all[ev6], st6), logq_all[i_all[ev6]])
    resid = ch.targets(i_all[ev6]) - p6
    quant = {f'h{h}': {'p10': float(np.percentile(resid[:, h - 1], 10)), 'p50': float(np.percentile(resid[:, h - 1], 50)),
                       'p90': float(np.percentile(resid[:, h - 1], 90)), 'MAE': float(np.mean(np.abs(resid[:, h - 1])))} for h in HORIZONS_ALL}
    export = {
        'kind': 'TWIN AI v2 deep forecaster', 'model_version': MODEL_VERSION, 'architecture': winner, 'config': shipped['config'],
        'epochs': shipped['epochs'], 'seed': 0, 'window_hours': WINDOW, 'horizons': HORIZONS_ALL,
        'features': shipped['features'], 'feature_note': 'logq_z = (log1p(q) - logq_mean) / logq_std; hour_sin/cos = 발행 시각의 시(0~23) 기준',
        'output_note': 'd_h = clamp(model, -4, 4); q_hat = max(0, expm1(log1p(q_t) + d_h))',
        'stats': shipped['stats'], 'training': {'refit_time': shipped['refit_time'].strftime('%Y-%m-%d %H:%M'), 'n_train': shipped['n_train'],
                                                 'period': '2024-01-03 ~ 2024-06-30 (목표 포함)', 'data_source': 'K-water 소양강댐 2024 시간자료'},
        'residual_quantiles_june_validation': quant,
        'layer_norm_eps': 1e-5, 'activation': 'gelu (erf)',
        'weights': state_dict_json(model),
        'test_vectors': {'inputs': X_ev[pick].round(6).tolist(), 'logq_t': L_ev[pick].round(6).tolist(), 'i': i_ev[pick].tolist(),
                         'delta_outputs': vec_delta.round(6).tolist(), 'outputs': vec_out.round(4).tolist()},
        'display_notes': ['과거 공개자료 기반 예측 시연', '자동 방류 명령이 아님', '7월 1일 재학습 모형이므로 2024년 7월 이후 예측은 학습 범위 밖',
                          '오차 띠는 6월 검증 잔차의 10~90% 분위수(경험적)이며 보정된 예측구간이 아님'],
    }
    write_json(out / f'43_모형_{winner}_7월재학습.json', export)
    print('내보내기 완료', winner, f'({time.time()-t0:.0f}s)', flush=True)


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
