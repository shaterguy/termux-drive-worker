import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Major CLI programs: verified presence is required before a description is published.
// Usage examples are reference examples, not evidence that the operation was executed.
const ROWS = [
  ['git','버전 관리','Git 저장소의 변경 이력, 브랜치, 병합 및 원격 동기화를 관리합니다.','git status --short|git log -5 --oneline|git diff|git fetch origin'],
  ['gh','버전 관리','GitHub 저장소, 이슈, PR, 릴리스, Actions를 CLI로 관리합니다.','gh repo view|gh pr list|gh issue list|gh run list'],
  ['node','개발 언어','Node.js로 JavaScript 프로그램과 스크립트를 실행합니다.','node --version|node script.mjs|node --check script.mjs'],
  ['npm','패키지 관리','Node.js 패키지를 설치하고 프로젝트 스크립트를 실행합니다.','npm ls -g --depth=0|npm install|npm test'],
  ['npx','패키지 관리','설치된 npm 패키지의 실행 파일을 호출합니다.','npx --no-install <command>'],
  ['python','개발 언어','Python 스크립트와 모듈을 실행합니다.','python --version|python -m pip list|python script.py'],
  ['python3','개발 언어','Python 3 인터프리터입니다.','python3 --version|python3 -m unittest'],
  ['pip','패키지 관리','Python 패키지를 설치하고 관리합니다.','pip list|pip show <package>'],
  ['pip3','패키지 관리','Python 3 패키지를 설치하고 관리합니다.','pip3 list|pip3 show <package>'],
  ['java','개발 언어','Java 바이트코드 애플리케이션을 실행합니다.','java -version|java -jar app.jar'],
  ['javac','빌드','Java 소스코드를 컴파일합니다.','javac -version|javac Main.java'],
  ['jar','빌드','Java JAR 아카이브를 생성하고 내용을 조사합니다.','jar --list --file app.jar'],
  ['jarsigner','보안·서명','Java JAR 파일에 서명하고 서명을 검증합니다.','jarsigner -verify app.jar'],
  ['gradle','빌드','Gradle 빌드와 테스트 태스크를 실행합니다.','gradle tasks|gradle test|gradle assemble'],
  ['make','빌드','Makefile 규칙에 따라 네이티브 프로그램을 빌드합니다.','make -n|make -j2'],
  ['cmake','빌드','CMake로 프로젝트 빌드 구성을 생성합니다.','cmake -S . -B build|cmake --build build'],
  ['ninja','빌드','Ninja 빌드 파일을 병렬 실행합니다.','ninja -C build -n|ninja -C build'],
  ['clang','컴파일러','Clang C 컴파일러로 코드를 빌드합니다.','clang --version|clang main.c -o main'],
  ['clang++','컴파일러','Clang C++ 컴파일러로 코드를 빌드합니다.','clang++ --version|clang++ main.cpp -o main'],
  ['gcc','컴파일러','GCC C 컴파일러로 코드를 빌드합니다.','gcc --version|gcc main.c -o main'],
  ['g++','컴파일러','GCC C++ 컴파일러로 코드를 빌드합니다.','g++ --version|g++ main.cpp -o main'],
  ['rustc','개발 언어','Rust 소스코드를 컴파일합니다.','rustc --version|rustc main.rs'],
  ['cargo','패키지·빌드','Rust 프로젝트의 의존성, 빌드, 검사 및 테스트를 관리합니다.','cargo check|cargo test|cargo build'],
  ['rustfmt','코드 품질','Rust 소스코드 형식을 정리합니다.','rustfmt --check main.rs'],
  ['adb','Android','Android 장치·앱·로그·셸·파일 전송에 접근합니다.','adb devices|adb shell getprop|adb logcat -d'],
  ['fastboot','Android','Android 부트로더 연결 장치 정보를 조회하고 펌웨어 작업을 수행합니다.','fastboot devices'],
  ['aapt','Android','Android APK 패키지 리소스와 매니페스트 정보를 확인합니다.','aapt dump badging app.apk'],
  ['aapt2','Android','Android 리소스를 컴파일하고 APK 패키지 정보를 확인합니다.','aapt2 dump badging app.apk'],
  ['apktool','Android 역공학','APK 리소스와 Smali 바이트코드를 디코딩하고 재구성합니다.','apktool d app.apk -o unpacked'],
  ['apksigner','Android 서명','Android APK 서명을 생성·검증합니다.','apksigner verify --verbose app.apk'],
  ['zipalign','Android 패키징','APK ZIP 데이터의 정렬 상태를 검증하거나 정렬합니다.','zipalign -c -v 4 app.apk'],
  ['sdkmanager','Android SDK','Android SDK 플랫폼과 빌드 도구 패키지를 관리합니다.','sdkmanager --list'],
  ['avdmanager','Android SDK','Android 에뮬레이터 가상 기기(AVD) 구성을 관리합니다.','avdmanager list avd'],
  ['r8','Android 최적화','Android DEX 바이트코드 축소·최적화·난독화를 수행합니다.','r8 --help'],
  ['rea','역공학','REA로 네이티브 바이너리, APK, JavaScript, 펌웨어 등의 정적·동적 분석 결과를 수집합니다.','rea --version|rea doctor --json|rea inspect-artifact FILE --format json|rea decompile FILE main --provider ghidra'],
  ['rea-agents','역공학','REA의 동일 npm 패키지에 포함된 CLI 진입점입니다.','rea-agents --help'],
  ['rea-full','역공학','Termux에서 Ubuntu ARM64와 Ghidra를 통해 REA 분석 명령을 실행합니다.','rea-full doctor --json|rea-full decompile FILE main --provider ghidra --format json'],
  ['readelf','바이너리 검사','ELF 헤더, 섹션, 심볼 등 실행 파일 구조를 읽습니다.','readelf -h app.elf|readelf -S app.elf'],
  ['objdump','바이너리 검사','목적 파일과 실행 파일의 헤더·디스어셈블 결과를 출력합니다.','objdump -d app.elf|objdump -h app.elf'],
  ['strings','바이너리 검사','바이너리 안의 출력 가능한 문자열을 추출합니다.','strings app.elf'],
  ['file','파일 검사','파일 헤더를 근거로 형식과 아키텍처를 판별합니다.','file app.apk|file app.elf'],
  ['openssl','암호·보안','TLS, 인증서, 해시 및 공개키 도구를 제공합니다.','openssl version|openssl dgst -sha256 FILE|openssl x509 -in cert.pem -text -noout'],
  ['sha256sum','무결성','SHA-256 체크섬을 계산하고 검증합니다.','sha256sum FILE|sha256sum -c SHA256SUMS'],
  ['curl','네트워크','HTTP(S) API 요청과 URL 파일 다운로드를 수행합니다.','curl -I https://example.org|curl -fsSL URL -o FILE'],
  ['wget','네트워크','HTTP(S)에서 웹 리소스를 다운로드합니다.','wget -O FILE URL'],
  ['ssh','원격 접속','암호화된 SSH 원격 셸에 접속합니다.','ssh user@host'],
  ['sshd','원격 접속','SSH 서버를 실행합니다.','sshd -T'],
  ['scp','파일 전송','SSH를 이용하여 원격 파일을 복사합니다.','scp local.txt user@host:/tmp/'],
  ['sftp','파일 전송','SSH를 통한 대화형 파일 전송을 지원합니다.','sftp user@host'],
  ['rsync','파일 동기화','파일 변경분을 선택적으로 복사·동기화합니다.','rsync -av --dry-run SRC/ DEST/'],
  ['rclone','클라우드 전송','클라우드 저장소와 로컬 파일을 복사·동기화합니다.','rclone listremotes|rclone ls remote:path'],
  ['ffmpeg','미디어 처리','영상·오디오의 인코딩, 변환, 추출, 병합을 수행합니다.','ffmpeg -i input.mp4 output.webm|ffmpeg -i input.mp4 -vn audio.wav'],
  ['ffprobe','미디어 분석','영상·오디오 스트림의 코덱과 메타데이터를 분석합니다.','ffprobe -v error -show_streams input.mp4'],
  ['magick','이미지 처리','이미지 형식 변환, 크기 조절, 합성을 수행합니다.','magick input.png -resize 800x output.png'],
  ['identify','이미지 분석','이미지 크기, 포맷 및 메타데이터를 식별합니다.','identify input.png'],
  ['convert','이미지 처리','ImageMagick의 레거시 이미지 변환 명령입니다.','convert input.png output.webp'],
  ['pandoc','문서 처리','Markdown, HTML 등 텍스트 문서 형식을 변환합니다.','pandoc input.md -o output.html'],
  ['gs','문서 처리','Ghostscript로 PostScript 및 PDF를 해석·변환합니다.','gs --version'],
  ['ps2pdf','문서 처리','PostScript 문서를 PDF로 변환합니다.','ps2pdf input.ps output.pdf'],
  ['jq','데이터 처리','JSON 필드를 조회·필터링·변환합니다.','jq . file.json|jq -r .name file.json'],
  ['sqlite3','데이터 처리','SQLite DB에 질의를 실행하고 테이블을 조사합니다.','sqlite3 db.sqlite ".tables"|sqlite3 db.sqlite "SELECT 1"'],
  ['rg','검색','ripgrep으로 소스코드와 텍스트에서 패턴을 빠르게 검색합니다.','rg -n PATTERN PATH|rg --files'],
  ['fd','검색','파일 및 디렉터리 경로를 이름 패턴으로 검색합니다.','fd PATTERN DIRECTORY'],
  ['grep','검색','텍스트 파일에서 정규식 패턴을 검색합니다.','grep -R -n PATTERN DIR'],
  ['find','검색','파일시스템 경로를 조건에 따라 검색합니다.','find DIR -name "*.js"'],
  ['sed','텍스트 처리','스트림 텍스트를 선택·편집·치환합니다.','sed -n "1,40p" FILE'],
  ['awk','텍스트 처리','컬럼 기반 텍스트 데이터를 처리합니다.','awk "{print $1}" FILE'],
  ['tar','압축·백업','파일·디렉터리를 TAR 아카이브로 묶고 해제합니다.','tar -tf archive.tar|tar -xvf archive.tar'],
  ['zip','압축·백업','ZIP 압축 파일을 생성합니다.','zip -r archive.zip DIRECTORY'],
  ['unzip','압축·백업','ZIP 아카이브의 파일을 나열하거나 해제합니다.','unzip -l archive.zip'],
  ['zstd','압축·백업','Zstandard 형식의 빠른 압축·해제를 수행합니다.','zstd FILE|zstd -d FILE.zst'],
  ['bash','셸·자동화','Bash 셸로 스크립트와 명령을 실행합니다.','bash --version|bash -n script.sh'],
  ['tmux','셸·자동화','여러 터미널 세션을 유지하고 전환합니다.','tmux list-sessions|tmux new -s work'],
  ['timeout','셸·자동화','명령 실행 제한시간을 적용합니다.','timeout 10 COMMAND'],
  ['crontab','셸·자동화','반복 예약 실행 작업을 등록·조회합니다.','crontab -l'],
  ['proot','가상 환경','사용자 권한에서 별도 루트 파일시스템을 실행합니다.','proot --help'],
  ['proot-distro','가상 환경','Termux 안의 Linux 배포판을 설치·실행·관리합니다.','proot-distro list|proot-distro login ubuntu -- /bin/bash'],
  ['chromium-browser','브라우저','Chromium 브라우저 및 헤드리스 렌더링을 수행합니다.','chromium-browser --version'],
  ['chromedriver','브라우저','WebDriver로 Chromium 브라우저를 자동 제어합니다.','chromedriver --version'],
  ['vercel','배포','Vercel 프로젝트를 빌드·배포·관리합니다.','vercel --version|vercel project ls'],
  ['drive-worker-run','Termux 운영','Drive Worker가 Google Drive 명령을 수신·실행하는 런처입니다.','drive-worker-run'],
  ['mcp-call','MCP 도구','Termux MCP 서버의 도구 목록을 조회하거나 도구를 호출합니다.','mcp-call SERVER tools|mcp-call SERVER call TOOL "{}"'],
  ['mcp-inventory-refresh','MCP 도구','Termux의 MCP 서버 도구 목록과 연결 상태를 갱신합니다.','mcp-inventory-refresh'],
  ['service-daemon','Termux 운영','Termux 서비스의 상태·실행을 관리하는 서비스 래퍼입니다.','service-daemon --help'],
  ['selfrun4-status','Termux 운영','SelfRun 서버의 실행 상태를 확인합니다.','selfrun4-status'],
  ['selfrun4-start','Termux 운영','SelfRun 서버를 시작합니다.','selfrun4-start'],
  ['selfrun4-stop','Termux 운영','SelfRun 서버를 중지합니다.','selfrun4-stop'],
  ['termux-battery-status','Termux API','안드로이드 배터리 상태를 JSON으로 조회합니다.','termux-battery-status'],
  ['termux-location','Termux API','안드로이드 위치 정보를 요청합니다(권한 필요).','termux-location -p network'],
  ['termux-camera-photo','Termux API','안드로이드 카메라 사진을 촬영합니다(권한 필요).','termux-camera-photo image.jpg'],
  ['termux-wifi-connectioninfo','Termux API','현재 Wi-Fi 연결 정보를 조회합니다.','termux-wifi-connectioninfo'],
  ['termux-notification','Termux API','안드로이드 알림을 게시합니다.','termux-notification --title TITLE --content TEXT'],
  ['termux-clipboard-get','Termux API','안드로이드 클립보드 텍스트를 읽습니다.','termux-clipboard-get'],
  ['termux-clipboard-set','Termux API','안드로이드 클립보드 텍스트를 설정합니다.','termux-clipboard-set TEXT'],
  ['termux-sensor','Termux API','안드로이드 하드웨어 센서 측정을 조회합니다.','termux-sensor -l'],
  ['termux-wake-lock','Termux 운영','Termux 절전 방지 잠금 요청을 수행합니다.','termux-wake-lock'],
  ['termux-wake-unlock','Termux 운영','Termux 절전 방지 잠금을 해제합니다.','termux-wake-unlock']
];

// Only known, non-mutating help invocations may be executed. Custom scripts and
// arbitrary names from PATH are never executed during automatic collection.
const SAFE_HELP = new Set([
  'git','gh','node','npm','python','python3','pip','pip3','java','javac',
  'gradle','make','cmake','ninja','clang','gcc','g++','rustc','cargo',
  'adb','fastboot','aapt','aapt2','apktool','apksigner','sdkmanager',
  'rea','readelf','objdump','openssl','curl','wget','ssh','scp','rsync',
  'rclone','ffmpeg','ffprobe','magick','pandoc','jq','sqlite3','rg',
  'fd','grep','find','tar','zip','unzip','zstd','bash','tmux','proot'
]);

export const KNOWN_PROGRAMS = Object.freeze(Object.fromEntries(ROWS.map(([name,category,description,examples]) => [
  name, {category,description,examples:examples.split('|')}
])));

function normalizeHelp(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g,'')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').slice(0,36000);
}

export function parseHelp(text) {
  const lines = normalizeHelp(text).split('\n');
  const subcommands = [];
  const flags = [];
  let listing = false;
  for (const line of lines) {
    if (/^\s*(?:commands|available commands|core commands|additional commands|other commands|management commands)\s*:?\s*$/i.test(line)) {
      listing = true;
      continue;
    }
    if (listing && /^\s*[A-Z][A-Z /&-]{3,}\s*:?\s*$/.test(line)) listing = false;
    if (listing) {
      const m = line.match(/^\s{2,}([a-z][a-z0-9-]{1,58})\s*(?::|\s{2,})\s*\S/i);
      if (m && !subcommands.includes(m[1])) subcommands.push(m[1]);
    }
    if (/^\s+--?[a-z]/i.test(line)) {
      for (const flag of line.match(/--[a-z][a-z0-9-]*/gi) || []) {
        if (!flags.includes(flag)) flags.push(flag);
      }
    }
  }
  return {subcommands:subcommands.slice(0,160), options:flags.slice(0,24)};
}

async function systemHelp(file) {
  try {
    const result = await execFileAsync(file, ['--help'], {
      timeout: file.endsWith('/rea') ? 7500 : 1700, maxBuffer: 48 * 1024, windowsHide: true,
      env: { ...process.env, CI:'1', PAGER:'cat', GIT_PAGER:'cat', LESS:'FRX' },
    });
    return {status:'help_confirmed', ...parseHelp(result.stdout + '\n' + result.stderr)};
  } catch (error) {
    const output = normalizeHelp(String(error.stdout || '') + '\n' + String(error.stderr || ''));
    return {
      status: error.killed ? 'help_timeout' : output.trim() ? 'help_nonzero' : 'help_unavailable',
      ...parseHelp(output),
    };
  }
}

async function scanNpmMetadata(prefix, locations) {
  const root = path.join(prefix, 'lib', 'node_modules');
  const packages = new Map();
  async function readPackage(folder) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));
      const binaries = typeof pkg.bin === 'string' ? {[pkg.name?.split('/').pop()]:pkg.bin} : pkg.bin || {};
      for (const name of Object.keys(binaries)) {
        if (locations[name] && !packages.has(name)) {
          packages.set(name, {
            description:String(pkg.description || '').trim().slice(0,240),
            package: String(pkg.name || '').slice(0,100),
            version:String(pkg.version || '').slice(0,40)
          });
        }
      }
    } catch {}
  }
  try {
    const dirs = await fs.readdir(root, {withFileTypes:true});
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (!dir.name.startsWith('@')) {
        await readPackage(path.join(root,dir.name));
      } else {
        for (const child of await fs.readdir(path.join(root,dir.name),{withFileTypes:true})) {
          if (child.isDirectory()) await readPackage(path.join(root,dir.name,child.name));
        }
      }
    }
  } catch {}
  return packages;
}

async function scanTermuxPackages(prefix, locations) {
  const packages = new Map();
  const statusFile = path.join(prefix,'var','lib','dpkg','status');
  let status = '';
  try { status = await fs.readFile(statusFile,'utf8'); } catch { return packages; }
  for (const paragraph of status.split(/\n\s*\n/g)) {
    const name = paragraph.match(/^Package:\s*(\S+)/m)?.[1];
    if (!name || !locations[name] || !/^Status:\s*install ok installed$/m.test(paragraph)) continue;
    const description = paragraph.match(/^Description:\s*(.+)$/m)?.[1]?.trim();
    if (!description) continue;
    packages.set(name,{
      description:description.slice(0,220),
      package:name,
      version:(paragraph.match(/^Version:\s*(\S+)/m)?.[1] || '').slice(0,45)
    });
  }
  return packages;
}

async function signature(file) {
  try {
    const stat = await fs.stat(file);
    return file + ':' + stat.size + ':' + Math.trunc(stat.mtimeMs);
  } catch {return file + ':missing';}
}

export async function buildProgramInventory(locations, options = {}) {
  const home = options.home || process.env.HOME || '';
  const prefix = options.prefix || process.env.PREFIX || '';
  const cacheFile = options.cacheFile === undefined
    ? path.join(home, '.drive-worker','program-help-cache-v1.json')
    : options.cacheFile;
  const previous = cacheFile ? await fs.readFile(cacheFile,'utf8').then(JSON.parse).catch(()=>({})) : {};
  const npm = await scanNpmMetadata(prefix,locations);
  const termuxPackages = await scanTermuxPackages(prefix,locations);
  const candidates = new Set(Object.keys(KNOWN_PROGRAMS));
  for (const name of npm.keys()) candidates.add(name);
  for (const name of termuxPackages.keys()) candidates.add(name);
  for (const [name,file] of Object.entries(locations)) {
    if (home && file.startsWith(path.join(home,'bin') + '/')) candidates.add(name);
  }
  const selected = [...candidates].filter(name=>typeof locations[name] === 'string').sort();
  const records = [];
  const fresh = {};
  const probe = options.probeHelp || systemHelp;
  const makeRow = async (name) => {
    const definition = KNOWN_PROGRAMS[name];
    const packageInfo = npm.get(name) || termuxPackages.get(name);
    const packageSource = npm.has(name) ? 'npm_package' : 'termux_package';
    const file = locations[name];
    const row = {
      name, executable: file,
      category: definition?.category || (packageInfo ? '패키지 프로그램' : '사용자 스크립트'),
      description: definition?.description || packageInfo?.description || '사용자 정의 실행 파일로, 구체적인 기능 설명은 확인되지 않았습니다.',
      description_source: definition ? 'curated' : packageInfo?.description ? packageSource : 'unknown',
      ...(packageInfo ? {package:packageInfo.package,package_version:packageInfo.version} : {}),
      usage_examples:definition?.examples || [],
      usage_examples_source:definition?'curated_reference':'none',
      help: {status:'not_probed',subcommands:[],options:[]},
      operation_tested:false
    };
    if (SAFE_HELP.has(name) && (file.startsWith(prefix + '/') || file.startsWith(home + '/'))) {
      const sig = 'program-catalog-v2:' + await signature(file);
      const cached = previous[name];
      if (cached?.signature === sig && cached?.help?.status &&
          (cached.help.status === 'help_confirmed' || Date.now() - (cached.checked_at || 0) < 86400000)) {
        row.help = cached.help;
      } else {
        row.help = await probe(file,name);
      }
      fresh[name] = {signature:sig,help:row.help,checked_at:cached?.signature === sig && row.help === cached.help ? cached.checked_at : Date.now()};
    }
    return row;
  };
  // Bounded batches prevent many concurrent process launches and CPU spikes.
  for (let i=0;i<selected.length;i+=2) {
    const pair = await Promise.all(selected.slice(i,i+2).map(makeRow));
    records.push(...pair);
  }
  if (cacheFile && JSON.stringify(previous) !== JSON.stringify(fresh)) {
    try {
      await fs.mkdir(path.dirname(cacheFile),{recursive:true,mode:0o700});
      const temp=cacheFile+'.'+process.pid+'.tmp';
      await fs.writeFile(temp,JSON.stringify(fresh));
      await fs.rename(temp,cacheFile);
    } catch {}
  }
  return {
    schema:'termux-program-inventory-v1',
    detected_count:records.length,
    documented_count:records.filter(p=>p.description_source!=='unknown').length,
    help_confirmed_count:records.filter(p=>p.help.status==='help_confirmed').length,
    records
  };
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ').trim();
}

export function renderProgramInventoryMarkdown(inventory) {
  const rows = inventory?.records || [];
  if (!rows.length) return '- none';
  return [
    '설명은 내장 기능 카탈로그 또는 설치된 npm 패키지 메타데이터에 근거합니다. 대표 명령어는 참고 예시이며 실제 실행 성공을 뜻하지 않습니다.',
    '자동 help 확인은 허용된 프로그램에만 제한적으로 수행합니다. 미확인 프로그램을 임의로 실행하지 않습니다.',
    '',
    '- detected_program_count: ' + rows.length,
    '- documented_program_count: ' + (inventory.documented_count || 0),
    '- help_confirmed_count: ' + (inventory.help_confirmed_count || 0),
    '',
    '| 프로그램 | 분류 | 주요 기능 | 대표 명령어 | 도움말 확인 |',
    '|---|---|---|---|---|',
    ...rows.map(p=>[
      '|',escapeCell(p.name),'|',escapeCell(p.category),'|',
      escapeCell(p.description),'|',
      escapeCell((p.usage_examples || []).slice(0,2).join(' ; ') || (p.help.subcommands || []).slice(0,3).join(', ') || '확인 필요'),'|',
      escapeCell(p.help.status),'|'
    ].join(' ')),
    '',
    '상세 경로, 버전, 발견된 하위 명령 및 옵션은 TERMUX_CAPABILITIES.json의 programs.records를 참조합니다.'
  ].join('\n');
}
