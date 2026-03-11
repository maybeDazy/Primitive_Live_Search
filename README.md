# Primitive_Live_Search
프리미티브의 전래식단 이야기 채널 영상 자막 검색기입니다.

## 자동 자막 업데이트 (일 1회)
이 저장소에는 신규 업로드 영상을 감지해서 자막/매핑/업데이트 로그를 자동 반영하는 스크립트가 포함됩니다.

- 스크립트: `scripts/auto_update_subtitles.mjs`
- 자막 수집기: `scripts/fetch_transcript.py` (`youtube-transcript-api` 사용)
- 워크플로우: `.github/workflows/daily-subtitle-update.yml`

### 동작 순서
1. YouTube Data API로 채널 업로드 목록을 조회
2. `subtitles/subtitle_mapping.json`(id/url)과 대조해 이미 등록된 영상은 즉시 스킵
3. 업로드 후 최소 7일이 지난 신규 영상을 최신 업로드부터(내림차순) `youtube-transcript-api`로 한국어(`ko`) 자막을 SRT로 저장
4. `subtitles/NNN.srt` 추가 및 매핑 JSON 갱신
5. `index.html` 업데이트 로그에 당일 자동 업데이트 항목 추가
6. `subtitles/subtitles.zip` 재생성
- 일부 영상에서 자막 접근이 제한되거나 제공되지 않는 경우, 해당 영상은 건너뛰고 나머지 처리를 계속합니다.

### GitHub 설정
Repository Secret에 아래 값을 추가하세요.

- `YOUTUBE_API_KEY`: YouTube Data API v3 키 (GitHub Secret로만 관리, 소스에 하드코딩 금지)
- `MIN_VIDEO_AGE_DAYS`: 자막 다운로드 시도 최소 경과일 (기본값 7)

### 수동 실행
```bash
python -m pip install -r scripts/requirements.txt
YOUTUBE_API_KEY=YOUR_KEY MIN_VIDEO_AGE_DAYS=7 node scripts/auto_update_subtitles.mjs
```

테스트 모드(파일 미반영):
```bash
python -m pip install -r scripts/requirements.txt
YOUTUBE_API_KEY=YOUR_KEY MIN_VIDEO_AGE_DAYS=7 node scripts/auto_update_subtitles.mjs --dry-run
```

### 로컬 env 파일 사용 (권장)
커맨드 기록에 키가 남지 않도록 프로젝트 루트에 `.env.local` 파일을 만들고 사용하세요.

```bash
cat > .env.local <<'ENV'
YOUTUBE_API_KEY=YOUR_KEY
MIN_VIDEO_AGE_DAYS=7
CHANNEL_ID=UCqaSH5Js_s80nIY3P_wqCcg
SUBTITLE_LANG=ko
PYTHON_BIN=python3
ENV

python -m pip install -r scripts/requirements.txt
node scripts/auto_update_subtitles.mjs --dry-run
```

`.env`, `.env.local`은 `.gitignore`에 추가되어 커밋되지 않습니다.
