# Termux Drive Worker

사용자 소유 Android Termux의 Google Drive 명령 실행 및 ACTIVE/STANDBY 운영을 위한 **비공개 권위원본**입니다.

- 권위 저장소: `shaterguy/termux-drive-worker` (GitHub private).
- 현재 소스 계보: `v0.2.18-dev7` (2026-10-14).
- 태블릿 `Galaxy-Tab-S11-Ultra`: ACTIVE; 휴대폰 `Galaxy-S25`: STANDBY (배포 당시 확인 기준).
- 운영 소스 `worker.mjs` SHA-256: `f654eec54097fc64a26e79816f249eb6b2e1148980522f9fc23204854f691564`.
- Node.js ESM 엔트리포인트 `worker.mjs`. 나머지 모듈은 상대 import로 사용됩니다.
- 회귀 테스트: `node --test worker.regression.test.mjs` (10개).
- 기존 검증된 릴리스 폴더는 이력으로 보존합니다. 현재 실행 릴리스는 각 장치의 `~/bin/drive-worker-run`에서 확인합니다.

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

## 주요 프로그램의 기능 자동 인덱싱 (dev6)
- `capabilities.mjs`는 기존 전체 실행파일·경로·스킬 목록을 유지하면서 `programs.records` 기능 카탈로그를 생성합니다.
- `program-catalog.mjs`는 주요 도구의 설명과 사용 예시, 추가로 설치된 Termux(DPKG)·npm 패키지의 설명, `~/bin` 사용자 실행파일을 자동 반영합니다.
- 허용된 고정 CLI에만 비파괴적 `--help`를 실행해 하위 명령과 옵션을 추출합니다. 병렬 실행은 최대 2개, 명령당 제한시간과 캐시가 적용됩니다.
- `help.status`는 도움말 명령 실행 여부이고 `operation_tested`는 실제 업무 명령 실행의 검증 여부입니다. 참고 예시를 실사용 성공으로 간주하지 않습니다.
- ACTIVE Drive Worker는 약 5분마다 `TERMUX_CAPABILITIES.md`와 `capabilities.json`을 동일 Drive 파일 ID로 갱신하고 readback합니다.
- 신규 패키지는 다음 인벤토리 갱신 때 반영되며, 내장 설명이 없는 사용자 스크립트는 상세 기능을 임의로 추측하지 않습니다.

## TMCP별 자동 사용법 문서 (dev7)
- 기존 mcp-inventory-refresh의 tools/list 결과를 재사용하여 민감값을 제거한 schema 캐시를 생성합니다.
- 기존 ACTIVE Worker inventory 동기화가 MCP_INDEX의 짧은 MANUAL 실행 안내와 TMCP별 사용법 링크를 같은 파일 ID로 갱신합니다.
- 문서는 required/type/nested/union 입력, 교체형 CLI 템플릿, 출력 계약, 버전·schema hash·상태를 포함합니다.
- ID를 공유 manifest에 조건부 예약하고 동일 ID 생성·회수·readback합니다. ETag 충돌과 사용자 자동구역 편집은 덮어쓰지 않습니다.
- 자세한 보존·실패 처리·배포 계약은 TDOC_USAGE_PUBLICATION.md를 참조합니다.
