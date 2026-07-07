# 📖 사용 가이드 (Fork Tools Guide)

이 포크에는 원본 public-apis 목록(1,500개 이상의 무료 API)을 **훨씬 편하게 쓰기 위한 도구**가 추가되어 있습니다.
README.md의 거대한 표를 스크롤할 필요 없이, 아래 3가지 방법으로 원하는 API를 바로 찾을 수 있습니다.

*English summary at the bottom.*

---

## 1. 🖥️ 웹 브라우저로 탐색 — `index.html`

**가장 편한 방법입니다.** 저장소의 `index.html` 파일을 브라우저로 열기만 하면 됩니다 (서버 불필요, 오프라인 동작).

```bash
# macOS
open index.html
# Windows
start index.html
# Linux
xdg-open index.html
```

지원 기능:

| 기능 | 설명 |
|:---|:---|
| 🔍 실시간 검색 | 이름·설명·카테고리를 즉시 검색 (`/` 키로 검색창 포커스) |
| 🏷️ 필터 | 카테고리, 인증 방식(키 없음 / apiKey / OAuth), HTTPS, CORS |
| ⭐ 즐겨찾기 | 별을 눌러 저장 — 브라우저에 유지되며 "즐겨찾기만 보기" 가능 |
| 🎲 랜덤 추천 | 현재 필터 안에서 무작위로 하나 추천 |
| 🌓 다크 모드 | 시스템 설정 자동 감지 + 수동 전환 |
| 한/EN | 한국어·영어 UI 전환 |

> 💡 GitHub Pages를 켜면(Settings → Pages → branch 선택) 웹사이트로도 쓸 수 있습니다.

## 2. ⌨️ 터미널에서 검색 — `./apis`

저장소 루트의 `./apis` 명령으로 즉시 검색합니다. 파이썬 3만 있으면 되고, 설치할 패키지는 없습니다.

```bash
./apis weather                      # 키워드 검색 (이름 + 설명 + 카테고리)
./apis cat --category animals       # 카테고리 안에서 검색
./apis music --auth no --cors yes   # 키 없이 + CORS 되는 API만
./apis --random 5                   # 무작위 5개 추천
./apis --list-categories            # 전체 카테고리와 개수 보기
./apis qr code --json               # JSON으로 출력 (스크립트 연동용)
./apis jokes --urls                 # URL만 출력 (파이프 연결용)
```

주요 옵션:

| 옵션 | 값 | 설명 |
|:---|:---|:---|
| `-c`, `--category` | 문자열 | 카테고리 이름 일부 일치 |
| `--auth` | `no` / `required` / `apikey` / `oauth` | 인증 필터 (`no` = 키 불필요) |
| `--https` | `yes` / `no` | HTTPS 지원 여부 |
| `--cors` | `yes` / `no` / `unknown` | CORS 지원 여부 |
| `--random N` | 숫자 | 결과 중 무작위 N개 |
| `--limit N` | 숫자 | 최대 N개까지만 표시 |
| `--json` / `--urls` | - | 기계가 읽기 좋은 출력 |

결과의 배지 의미: 🟢 `free` = 키 없이 바로 사용, 🟡 `apiKey`/`OAuth` = 인증 필요, 🔴 `http-only` = HTTPS 미지원, 🔵 `cors` = 브라우저에서 직접 호출 가능.

## 3. 📊 데이터 파일로 활용 — `data/`

README 전체가 구조화된 데이터로 변환되어 있어 프로그램에서 바로 쓸 수 있습니다.

| 파일 | 용도 |
|:---|:---|
| `data/apis.json` | 전체 데이터 + 메타데이터 (`count`, `categories`, `entries`) |
| `data/apis.csv` | 엑셀·구글시트에서 바로 열기 |
| `data/apis.js` | `index.html`이 사용하는 데이터 (`window.APIS_DATA`) |

```python
import json
apis = json.load(open('data/apis.json'))['entries']
free_apis = [a for a in apis if a['auth'] is None and a['https']]
```

```bash
# jq 예시: 키 없이 쓸 수 있는 날씨 API의 URL만
jq -r '.entries[] | select(.category=="Weather" and .auth==null) | .url' data/apis.json
```

## 🔄 데이터 갱신

README.md가 바뀌면(원본 저장소 동기화 등) 한 줄로 데이터를 다시 생성합니다:

```bash
python3 scripts/parse_apis.py
```

CLI(`./apis`)는 README.md를 매번 직접 읽으므로 **갱신 없이도 항상 최신**입니다.
`data/` 파일과 웹 UI만 위 명령으로 다시 생성하면 됩니다.

## ✅ 테스트

```bash
python3 -m unittest scripts.tests.test_parse_apis
```

---

## English Summary

This fork adds three ways to use the public-apis list conveniently:

1. **`index.html`** — an offline web explorer. Just open the file in a browser: instant search, filters (category / auth / HTTPS / CORS), favorites, dark mode, Korean/English UI. No server needed.
2. **`./apis`** — a zero-dependency terminal search CLI. Examples: `./apis weather --auth no`, `./apis --random 5`, `./apis --list-categories`, `./apis qr --json`.
3. **`data/`** — the whole README as structured data: `apis.json`, `apis.csv`, and `apis.js`.

Regenerate the data after README changes with `python3 scripts/parse_apis.py`.
The CLI always parses README.md directly, so it never goes stale.
