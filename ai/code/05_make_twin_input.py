# -*- coding: utf-8 -*-
"""5단계: K-water 원문 CSV -> TWIN 3D 프로그램 '데이터 연결' 입력 CSV (docs/data-format.md 형식).

실행: python3 05_make_twin_input.py <원문23열.csv> <출력폴더>

변환 가정 (프로그램에서 자료 출처 설명에 그대로 적을 것):
- timestamp: 원문 YYYYMMDDHH 의 24시를 다음 날 00:00 으로 바꾼 달력 라벨에 +09:00 을 붙였다.
  프로그램은 timestamp 를 '구간 시작' 으로 해석한다. 원문 시각이 구간 시작인지 끝인지는 K-water 확인 전이므로 가정이다.
- 유입과 방류는 그 구간의 평균, 저수량과 수위는 구간 시작 상태라는 프로그램 규약을 따른다고 가정한다.
- observedGenerationMWh = (1호기 + 2호기 발전량 kWh) / 1000.
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from twin_ai_common import load_kwater_csv

SOURCE_TEXT = 'K-water 다목적댐 발전량 및 수문운영 2024 (공공데이터포털 15150943, 소양강댐 시트). 시각: 원문 24시를 다음날 00:00으로 환산, 구간 시작 가정'


def main(src: Path, out: Path) -> None:
    df = load_kwater_csv(src)
    twin = pd.DataFrame({
        'timestamp': df['t_label'].dt.strftime('%Y-%m-%dT%H:%M:00+09:00'),
        'inflowCms': df['q'],
        'observedReleaseCms': df['release'],
        'observedTurbineCms': df['turbine_release'],
        'observedStorageMcm': df['storage'],
        'observedLevelM': df['level'],
        'observedGenerationMWh': (df['gen_mwh']).round(6),
        'sourceKind': 'observed',
        'source': SOURCE_TEXT,
        'rawTimeLabel': df['raw_label'],
    })
    if (twin['observedTurbineCms'] > twin['observedReleaseCms'] + 1e-9).any():
        raise SystemExit('발전방류량이 총방류량보다 큰 행이 있어 프로그램이 거부합니다.')
    out.mkdir(parents=True, exist_ok=True)
    path = out / '30_TWIN_입력_소양강댐2024.csv'
    twin.to_csv(path, index=False, encoding='utf-8')
    print('저장:', path, len(twin), '행')


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
