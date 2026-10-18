# -*- coding: utf-8 -*-
"""설명용 그림 2장: 시간 규칙(입력, 발행, 목표)과 평가 달력. 실행: python3 04_diagrams.py <결과폴더>"""
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import FancyBboxPatch, Rectangle


def setup_font():
    for name in ['Noto Sans CJK KR', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'NanumGothic', 'AppleGothic', 'Malgun Gothic']:
        if any(f.name == name for f in font_manager.fontManager.ttflist):
            plt.rcParams['font.family'] = name
            break
    plt.rcParams['axes.unicode_minus'] = False


def time_rule(out: Path):
    # 축은 등간격이 아니다: 먼 과거를 압축해 발행 시각 주변을 읽기 쉽게 그린다.
    ticks = [-48, -24, -12, -6, -3, -1, 0, 1, 3, 6]
    pos = {k: i for i, k in enumerate(ticks)}
    fig, ax = plt.subplots(figsize=(13, 4.6))
    ax.set_xlim(-0.8, 10.3); ax.set_ylim(-2.9, 2.9); ax.axis('off')
    ax.annotate('', xy=(10.1, 0), xytext=(-0.6, 0), arrowprops=dict(arrowstyle='-|>', lw=1.6, color='#333'))
    ax.text(10.15, -0.05, '시간', va='center', fontsize=11)
    for k in ticks:
        ax.plot([pos[k], pos[k]], [-0.18, 0.18], color='#333', lw=1)
        ax.text(pos[k], -0.55, f't{k:+d}' if k else 't', ha='center', fontsize=10.5)
    ax.add_patch(Rectangle((pos[-48] - 0.35, 0.35), pos[0] - pos[-48] + 0.7, 1.05, facecolor='#d7e8f7', edgecolor='#1f6fb2', lw=1.4))
    ax.text((pos[-48] + pos[0]) / 2, 0.88, '입력: t−L 까지의 공개 기록만 (L=0 이면 t 까지)\n최신값과 1, 3, 6, 12, 24, 48행 전 값, 3, 6, 24행 평균, 1, 3, 6행 차이 = 13개',
            ha='center', va='center', fontsize=10.5, color='#0b3d66')
    ax.add_patch(Rectangle((pos[0] - 0.08, -0.2), 0.16, 0.4, facecolor='#333', edgecolor='#333'))
    ax.text(pos[0], 1.95, '발행 시각 t\n(예측을 만드는 순간)', ha='center', va='center', fontsize=11, fontweight='bold')
    ax.add_patch(FancyBboxPatch((pos[3] - 0.3, 0.35), 0.6, 1.05, boxstyle='round,pad=0.05', facecolor='#f9d6d0', edgecolor='#c0392b', lw=1.6))
    ax.text(pos[3] + 0.9, 1.95, '목표 q(t+3)\n(3시간 뒤 공개 유입량)', ha='center', va='center', fontsize=11, color='#7b1d12', fontweight='bold')
    ax.add_patch(Rectangle((pos[1] - 0.4, -1.35), pos[6] - pos[1] + 0.8, 0.55, facecolor='#f3f3f3', edgecolor='#999', lw=1, ls='--'))
    ax.text((pos[1] + pos[6]) / 2, -1.07, '미래 구간: 어떤 값도 입력으로 쓰지 않는다', ha='center', va='center', fontsize=10, color='#555')
    ax.text(-0.6, -1.95, '축의 간격은 실제 시간에 비례하지 않는다. 지연 L 을 1 또는 3 으로 두면 입력 창의 오른쪽 끝만 t−1, t−3 으로 물러나고 목표 t+3 은 그대로다.', fontsize=10, color='#333')
    ax.text(-0.6, -2.45, '월초 재학습: 재학습 시각 r 이전에 목표까지 공개된 표본(목표 시각+L ≤ r)만 학습에 쓴다.', fontsize=10, color='#333')
    fig.tight_layout(); fig.savefig(out / 'D1_시간규칙.png', dpi=150); plt.close(fig)


def calendar(out: Path):
    fig, ax = plt.subplots(figsize=(13, 3.9))
    ax.set_xlim(0.5, 13.2); ax.set_ylim(-1.6, 2.4); ax.axis('off')
    blocks = [(1, 5, '#d7e8f7', '#1f6fb2', '학습과 개발 (1~5월)\n6월 1일 기준으로 계수 적합'),
              (6, 6, '#fff1c2', '#b8860b', '설정 선택\n(6월 MAE)'),
              (7, 9, '#f9d6d0', '#c0392b', '주평가 (7~9월)\n매월 1일 계수만 재학습\n방법, 설정, 지표는 그대로'),
              (10, 12, '#e3f0e0', '#2e7d32', '보조평가 (10~12월)\n같은 규칙, 계절 차이 확인')]
    for start, end, fc, ec, label in blocks:
        ax.add_patch(Rectangle((start - 0.45, 0.2), end - start + 0.9, 1.0, facecolor=fc, edgecolor=ec, lw=1.6))
        ax.text((start + end) / 2, 0.7, label, ha='center', va='center', fontsize=10.5)
    for m in range(1, 13):
        ax.text(m, -0.15, f'{m}월', ha='center', fontsize=10.5)
    for m in range(7, 13):
        ax.annotate('', xy=(m - 0.45, 1.25), xytext=(m - 0.45, 1.85), arrowprops=dict(arrowstyle='-|>', lw=1.2, color='#444'))
    ax.text(9.5, 2.05, '재학습 시각 r = 각 달 1일 00:00 (그 전에 공개된 표본만 학습)', ha='center', fontsize=10, color='#444')
    ax.text(6, 1.55, 'Ridge alpha 와 부스팅 설정을 6월 MAE 로 각각 선택한 뒤 고정', ha='center', fontsize=9.5, color='#7a5a00')
    ax.text(0.55, -0.85, '각 달의 평가 표본: 발행 시각과 최대 목표 시각 t+6 이 모두 그 달 안에 있는 시각 (달마다 마지막 6개 발행 시각 제외).', fontsize=10, color='#333')
    ax.text(0.55, -1.3, '7월 결과를 보고 설정을 바꾸는 것은 금지. 10~12월에 순위가 뒤집히면 계절에 따른 한계로 그대로 적는다.', fontsize=10, color='#333')
    fig.tight_layout(); fig.savefig(out / 'D2_평가달력.png', dpi=150); plt.close(fig)


if __name__ == '__main__':
    setup_font()
    out = Path(sys.argv[1]) / '그래프'
    out.mkdir(exist_ok=True)
    time_rule(out); calendar(out)
    print('설명 그림 완료')
