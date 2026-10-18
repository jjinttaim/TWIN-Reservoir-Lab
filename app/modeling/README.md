# 모델 재생성

Blender 5.1.2에서 생성과 내보내기를 확인했습니다. 일반 앱 실행에는 Blender가 필요하지 않습니다.

`build_soyang.py`를 모듈로 불러와 `build(출력폴더, render_preview=False)`를 호출하면 새 장면을 생성하고 GLB, Blender 원본, 장면 JSON을 저장합니다. 기존 장면은 보존합니다. 같은 출력폴더를 사용하면 그 안의 이전 TWIN 모델 파일을 덮어쓰므로 수정본을 보관할 때는 새 출력폴더를 사용하세요.

기본 좌표는 Blender Z-up, 상류 +Y, 댐마루 X 방향입니다. GLB와 장면 JSON은 Y-up입니다. 미리보기 물은 Blender에만 포함하고 브라우저용 GLB에서는 제외합니다.

절차적으로 만든 외형 참고 모델입니다. 실제 측량 지형, 게이트 설계도, 수심 또는 CFD 격자가 아닙니다.

1.3.1은 접근수로와 양쪽 댐 접합부를 닫고, 물 경계를 높은 산지 안까지 연장한 모델입니다. 장면 JSON의 `boundaryContract`와 실제 GLB를 함께 검사하려면 `node --test tests/geometry-boundaries.test.mjs`를 실행합니다. 표시 수위 116~121.5는 상대 좌표이며 운영 계산의 실제 숫자 수위와 다릅니다.

## 1.2 질감

`textures/`에 원본 절차형 PBR 텍스처 4종의 색, 거칠기, 노멀맵이 있습니다. 외부 사진이나 유료 자산을 사용하지 않았습니다. `generate_materials.py`는 NumPy와 Pillow가 있을 때 텍스처 원본을 다시 만듭니다. 이미 생성된 텍스처를 사용하는 모델 생성에는 두 라이브러리가 필요하지 않습니다.

GLB에 텍스처를 포함하며 `.blend`에도 이미지를 묶어 저장합니다. UV는 미터 단위 반복 간격을 사용합니다. 숲, 사력, 지형의 색 변화와 형상은 절차적 근사입니다.

GUI 연결이 없어도 설치된 Blender의 background 모드에서 소스를 실행하고 `--` 뒤에 출력폴더 하나를 지정할 수 있습니다. 열려 있는 Blender 작업과 별개로 자산 파일을 생성합니다.

## 1.4 디테일 추가

`build_soyang.py`의 "1.4 detail pass" 구간이 취수탑 취수구와 수위표, 게이트 갠트리, 변전소와 송전탑, 하류 교량과 관측소, 전망광장과 연결 램프를 만든다. 새 보조 함수는 `oriented_box`(회전 상자), `sagging_line`(처진 전선), `lattice_tower`(격자 철탑)이다. 전망광장 카메라 `plaza`가 장면 JSON에 추가됐다.

1.4 자산은 PyPI의 `bpy==5.1.2` 모듈(Python 3.13, Linux)로 같은 스크립트를 실행해 만들었다. 수정 전 스크립트를 같은 모듈로 실행하면 1.3.1 자산과 삼각형 수 843,548개, GLB 42,570,456바이트가 그대로 재현되었으므로 Blender 5.1.2 앱과 결과가 같다고 본다. 1.4 결과는 삼각형 854,756개, GLB 43,424,884바이트다. 삼각형 예산 90만 개 검사는 유지된다.

재생성 명령 예: `python3 -c "import importlib.util,sys; s=importlib.util.spec_from_file_location('b','modeling/build_soyang.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.build('work/new-model')"` (Blender 앱에서는 background 모드로 `--` 뒤에 출력폴더를 지정).

## 1.5 정밀도 개선

`build_soyang.py`의 "1.5" 주석 구간이 레이디얼 게이트(`radial_gate`), 플립 버킷과 수맥 점열, 감세지, 2기 발전소, 지형 2배 격자와 높은 사면 기복, 좌안 관리동, 사면 성토(`embankment`)를 가진 계곡 도로와 방류 수로 교량, 케이블 덕트, 직선 구간으로 나눈 지그재그 도로를 만든다. 장면 JSON에는 카메라 `bucket`과 `powerhouse`, `powerhouseUnits`, `river.widths`, 여수로 채널의 `freeJetFrom`이 추가됐다.

1.5 자산도 PyPI의 `bpy==5.1.2` 모듈(Python 3.13, Linux)로 만들었다. 결과는 삼각형 768,604개, GLB 39,715,944바이트다. 수정 이력은 `docs/3D_장면_안내.md`의 1.5 항목과 `docs/검증결과.md`에 있다.
