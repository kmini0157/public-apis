# 📡 Info Radar — 개인 정보 모니터링 비서

관심 소스를 등록해두면 **알아서 크롤링 → AI 요약·관련도 점수 → 매일 다이제스트 푸시**,
그리고 쌓인 정보에 **질문(RAG 챗)** 까지 가능한 개인용 도구.

**서버 0원.** 전부 무료 티어로만 돌아갑니다:

| 단계 | 사용 리소스 | 비용 |
|---|---|---|
| 스케줄 실행 | GitHub Actions (cron) | 무료 |
| 본문 추출 | [Jina Reader](https://jina.ai) `r.jina.ai` (키 불필요) | 무료 |
| 요약·관련도 점수 | [Pollinations](https://pollinations.ai) text API (키 불필요) | 무료 |
| 저장소 | 레포에 커밋되는 `data/items.json` (버전관리=무료 DB) | 무료 |
| 알림 푸시 | [ntfy.sh](https://ntfy.sh) (키 불필요) | 무료 |
| 프론트엔드 | 정적 HTML (Cloudflare Pages 등) | 무료 |
| RAG 챗 | [Puter.js](https://puter.com) `puter.ai.chat` (브라우저, 키 불필요) | 무료 |

---

## 동작 흐름

```
config/sources.json  →  RSS 수집  →  중복 제거  →  Jina 본문 추출
   →  Pollinations 관련도 점수 + 요약  →  점수 통과분만 보관
   →  data/items.json & web/items.json 커밋  →  ntfy 다이제스트 푸시
                                              ↘  web/index.html 에서 열람 + 질문
```

수집기는 **외부 네트워크가 열린 GitHub Actions에서 실행**됩니다. (현재 개발 컨테이너는
송신 정책상 외부 호스트가 막혀 있어 로컬에서는 네트워크 호출이 403으로 실패합니다 — 정상입니다.)

---

## 설정 (5분)

### 1. 관심사·소스 편집
`config/sources.json` 의 `profile.interests` 에 본인 관심사를 한국어로 적고,
`sources` 에 원하는 RSS 피드를 추가하세요. `min_score` 로 엄격도를 조절합니다(기본 55).

### 2. ntfy 알림 연결
1. 휴대폰에 **ntfy** 앱 설치 → 추측 어려운 토픽 구독 (예: `info-radar-a8f3kq`)
2. GitHub 레포 → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `NTFY_TOPIC`, Value: 위 토픽 문자열

### 3. 스케줄 켜기
`.github/workflows/info-radar.yml` 이 이미 매일 07:00 KST 에 돌도록 설정돼 있습니다.
Actions 탭에서 **Run workflow** 로 즉시 한 번 돌려볼 수 있습니다.
(워크플로가 `data/items.json` 을 커밋하므로 Settings → Actions → Workflow permissions 가
**Read and write** 인지 확인하세요.)

### 4. 프론트엔드 배포 (선택)
Cloudflare Pages / Netlify / Vercel 에 **빌드 명령 없음**, **출력 디렉토리 `apps/info-radar/web`** 로 연결.
`web/index.html` 이 같은 폴더의 `items.json` 을 읽어 피드와 챗을 띄웁니다.

로컬 미리보기:
```bash
cd apps/info-radar/web && python3 -m http.server 8080
# http://localhost:8080
```

---

## 로컬 실행

```bash
cd apps/info-radar
NTFY_TOPIC=your-topic node src/collect.mjs
```
(개발 컨테이너에서는 외부 호출이 막혀 있으니 실제 수집은 Actions에서 확인하세요.)

### 환경변수
| 변수 | 설명 | 기본값 |
|---|---|---|
| `NTFY_TOPIC` | ntfy 푸시 토픽 (없으면 푸시 건너뜀) | — |
| `POLLINATIONS_MODEL` | 사용할 모델 | `openai` |

---

## 구조

```
apps/info-radar/
├─ config/sources.json   # 관심사 + 소스 (여기만 편집하면 됨)
├─ src/
│  ├─ collect.mjs        # 메인 파이프라인
│  └─ core/{rss,extract,llm,store,notify}.mjs
├─ data/items.json       # 전체 저장소 (seen 포함)
└─ web/
   ├─ index.html         # 피드 + RAG 챗
   └─ items.json         # 프론트용 공개 사본
```

## 확장 아이디어 (v2)
- **임베딩 RAG**: 현재 챗은 키워드 검색 기반. `transformers.js`(브라우저 로컬 임베딩) 또는
  Chroma/Qdrant 로 의미검색 강화.
- **소스 다양화**: RSS 외 검색 키워드 모니터링, 유튜브 자막, 채용/가격 페이지.
- **음성**: edge-tts 로 다이제스트 오디오 생성(출퇴근 청취), Whisper 로 음성메모 입력.
- **이메일 다이제스트**: Resend 추가.
