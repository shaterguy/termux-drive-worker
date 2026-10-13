# Termux Drive Worker

사용자 소유 Android Termux의 Google Drive 명령 실행 및 ACTIVE/STANDBY 운영을 위한 **비공개 권위원본**입니다.

- 권위 저장소: `shaterguy/termux-drive-worker` (GitHub private).
- 현재 운영 계보: `v0.2.18-dev4` (2026-10-11).
- 태블릿 `Galaxy-Tab-S11-Ultra`: ACTIVE; 휴대폰 `Galaxy-S25`: STANDBY (배포 당시 확인 기준).
- 운영 소스 `worker.mjs` SHA-256: `41698337c9e7480ea81c85ce45997e89b7ad988e52063217596e28c2c086bff5`.
- Node.js ESM 엔트리포인트 `worker.mjs`. 나머지 모듈은 상대 import로 사용됩니다.
- 회귀 테스트: `node --test worker.regression.test.mjs` (10개).
- 기존 장치별 검증된 릴리스는 `~/.drive-worker/releases/v0.2.18-dev4-stale-exit-20261011/`이며, 이 저장소의 내용이 원본입니다.

## 소스 관리 절차
1. 향후 소스 변경은 **GitHub `main`의 최신 커밋에서 시작**합니다. 장치의 릴리스 디렉터리나 Google Drive 자료를 더 최신의 소스 원본으로 간주하지 않습니다.
2. 변경 사항은 별도 로컬 Git 체크아웃에서 검증한 뒤 GitHub에 커밋·푸시하고, 원격 커밋 SHA를 확인합니다.
3. 배포는 검증된 원격 commit/tag에 연결된 파일을 복제해 해시·회귀 테스트·실서비스 상태를 확인하는 방식으로 진행합니다. `worker.mjs`의 실행 SHA를 기록합니다.
4. 기존 운영 서비스는 새 소스가 GitHub에 푸시되었다는 이유만으로 자동 변경하지 않습니다.
5. OAuth 토큰·자격증명·실행 로그·실행 결과·개인 데이터 등은 커밋하지 않습니다. `.gitignore`는 보조 필터이며 게시 전 비밀정보 검사를 추가로 수행합니다.
6. Google Drive 프로젝트 문서는 운영 지침·배포 결과·커밋 링크를 보존하되 GitHub 소스의 권위를 대체하지 않습니다.

## 배포 정보
- `deploy/RELEASE_MANIFEST.Galaxy-Tab-S11-Ultra.json`: 배포 당시 릴리스 메타데이터 사본.
- `deploy/drive-worker-run.Galaxy-Tab-S11-Ultra.sh`: 검증된 태블릿 런처 설정 사본. 사용자 기기 경로를 포함하므로 자동으로 다른 장치에 적용하지 않습니다.
- `deploy/runit-run.sh`: 서비스 실행 래퍼 사본.
- 각 장치의 환경변수·인증·구성 파일은 로컬 보안 저장소가 담당합니다. Git 이력에 운영 자격증명을 넣지 않습니다.

## Watchdog resume command fence

The active Watchdog Termux mode controller writes `~/.termux-watchdog/command-resume-fence-v1.json` before restarting services from sleep. Commands admitted before that per-device cutoff are excluded without creating an INVALID, CLAIMED or RUNNING Result. The original source file creation timestamp, not `modifiedTime`, is authoritative for previously submitted commands; clients that create in another folder and move later should stamp an immutable `appProperties.dw_commands_admitted_at` upon admission to Commands. Without a trusted admission stamp, ambiguous precreated files fail closed. Routed commands preserve original source identity and use its metadata. Failures to read trusted provider metadata or a resume fence defer execution rather than causing replay.
