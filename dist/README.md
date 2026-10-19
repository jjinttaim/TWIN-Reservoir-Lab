# dist

배포 묶음 본체(Mac zip, Windows zip)는 용량 때문에 저장소가 아니라 [Releases](../../../releases)에 있습니다. 이 폴더에는 묶음과 함께 나눠 주는 안내문과 확인값만 둡니다.

- `읽어주세요.txt`: 어느 파일을 받을지, 한 줄 설치법, 보안 경고 처리, SHA-256
- `설치안내_Mac.txt`, `설치안내_Windows.txt`: 운영체제별 설치와 제거 안내
- `SHA256SUMS.txt`: Releases v1.6.1 묶음 두 개의 SHA-256 (GitHub Actions가 만든 묶음과 같은 값)
- `RELEASE_NOTES_v1.6.1.md`: Releases 본문

Releases 묶음은 `.github/workflows/release.yml`이 `v*` 태그가 푸시될 때, 또는 Actions 탭에서 수동 실행할 때 자동으로 만듭니다. 새 버전을 내려면 app/desktop의 버전과 `dist/RELEASE_NOTES_v<버전>.md`를 준비한 뒤 태그를 푸시하거나 수동 실행합니다.
