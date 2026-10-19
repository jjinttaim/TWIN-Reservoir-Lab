# dist

배포 묶음 본체(Mac zip, Windows zip)는 용량 때문에 저장소가 아니라 [Releases](../../../releases)에 있습니다. 이 폴더에는 묶음과 함께 나눠 주는 안내문과 확인값만 둡니다.

- `읽어주세요.txt`: 어느 파일을 받을지, 한 줄 설치법, 보안 경고 처리, SHA-256
- `설치안내_Mac.txt`, `설치안내_Windows.txt`: 운영체제별 설치와 제거 안내
- `SHA256SUMS.txt`: 팀 Mac에서 만든 두 묶음의 SHA-256 (Releases의 묶음은 GitHub Actions가 만든 것이라 값이 다르며, 그 값은 Releases의 SHA256SUMS.txt에 있습니다)
- `RELEASE_NOTES_v1.6.1.md`: Releases 본문

Releases 묶음은 `.github/workflows/release.yml`이 main에 app 또는 dist 변경이 푸시될 때 자동으로 만듭니다.
