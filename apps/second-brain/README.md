# 🧠 제2의 뇌 (Second Brain)

URL·메모·PDF를 넣어두면 **로컬 임베딩으로 의미검색**하고, 모아둔 지식에 대해
**AI에게 질문(RAG)** 할 수 있는 개인 지식 비서.

**완전 클라이언트사이드 — 서버·DB·API키 전부 0원, 데이터는 내 기기에만 저장됩니다.**

| 기능 | 사용 리소스 | 비용/키 |
|---|---|---|
| 본문 추출(URL) | [Jina Reader](https://jina.ai) `r.jina.ai` | 무료·키X |
| 임베딩(384차원) | [transformers.js](https://huggingface.co/docs/transformers.js) `all-MiniLM-L6-v2` (브라우저 로컬) | 무료·키X |
| 저장소 | 브라우저 **IndexedDB** (내 기기, 비공개) | 무료 |
| 의미검색 | 코사인 유사도 (JS, 로컬) | 무료 |
| AI 답변(RAG) | [Puter.js](https://puter.com) `puter.ai.chat` | 무료·키X |
| PDF 파싱 | [pdf.js](https://mozilla.github.io/pdf.js/) (브라우저) | 무료·키X |

> 백엔드가 없습니다. 정적 파일만 호스팅하면 끝(또는 그냥 로컬에서 열기).

---

## 바로 써보기

정적 파일이라 어떤 정적 서버로도 됩니다. (ES module·fetch 때문에 `file://` 직접 열기는
일부 브라우저에서 막히니 로컬 서버를 권장합니다.)

```bash
cd apps/second-brain
python3 -m http.server 8080
# http://localhost:8080
```

### 배포 (선택)
Cloudflare Pages / Netlify / Vercel 에 **빌드 명령 없음**, **출력 디렉토리 `apps/second-brain`** 로 연결.

---

## 사용법

1. **추가** — 왼쪽 위 탭에서:
   - **URL**: 기사·문서 주소 → Jina가 본문만 추출
   - **메모**: 생각·발췌를 직접 붙여넣기
   - **파일**: PDF / TXT / Markdown (브라우저에서 처리, 업로드 안 함)
2. 추가하면 텍스트를 청크로 나눠 **로컬에서 임베딩** 후 IndexedDB에 저장합니다.
   (첫 사용 시 임베딩 모델 ~25MB를 한 번 다운로드, 이후 캐시되어 즉시 동작)
3. **질문** — 오른쪽에서 모아둔 지식에 대해 물어보면, 의미검색으로 관련 노트를
   찾아 그것만 근거로 답합니다. "🔍 의미 검색 결과"에서 인용 근거를 확인할 수 있습니다.
4. **백업** — 내보내기로 JSON 백업, 다른 기기에서 가져오기. (데이터가 갇히지 않음)

---

## 구조

```
apps/second-brain/
├─ index.html        # UI
└─ js/
   ├─ app.js         # UI 컨트롤러 / 와이어링
   ├─ db.js          # IndexedDB (docs / chunks)
   ├─ embed.js       # transformers.js 로컬 임베딩 + 코사인
   ├─ extract.js     # URL(Jina)·PDF(pdf.js)·텍스트 → 청크
   └─ rag.js         # 의미검색 + Puter.js 답변
```

## 프라이버시
- 노트 원문과 임베딩은 **브라우저 IndexedDB에만** 저장됩니다(서버 전송 없음).
- URL 추가 시 해당 주소만 Jina로 전송되어 본문을 받아옵니다.
- 질문 시 검색된 노트 발췌가 Puter.js(LLM)로 전송됩니다.
- 모두 키 없이 동작하며, 데이터 소유권은 본인에게 있습니다(JSON 백업 제공).

## 확장 아이디어 (v2)
- **Info Radar 연동**: `info-radar`가 모은 항목을 한 번에 제2의 뇌로 가져오기.
- **음성 메모**: Whisper(브라우저)로 받아쓰기 → 자동 저장.
- **하이라이트 클리퍼**: 북마클릿/확장으로 웹에서 선택 텍스트 바로 저장.
- **공유 동기화**: 선택적으로 Supabase/Turso에 암호화 백업.
