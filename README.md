# Primitive_Live_Search
프리미티브의 전래식단 이야기 채널 영상 자막 검색기입니다.

## 자동 자막 업데이트 (일 1회)
이 저장소에는 신규 업로드 영상을 감지해서 자막/매핑/업데이트 로그를 자동 반영하는 스크립트가 포함됩니다.

- 스크립트: `scripts/auto_update_subtitles.mjs`
- 워크플로우: `.github/workflows/daily-subtitle-update.yml`

### 동작 순서
1. YouTube Data API로 채널 업로드 목록을 조회
2. `subtitles/subtitle_mapping.json`에 없는 신규 영상 ID만 추림
3. 업로드 후 최소 7일이 지난 신규 영상만 `yt-dlp`로 한국어 자동 자막(`ko`) 다운로드
4. `subtitles/NNN.srt` 추가 및 매핑 JSON 갱신
5. `index.html` 업데이트 로그에 당일 자동 업데이트 항목 추가
6. `subtitles/subtitles.zip` 재생성

### GitHub 설정
Repository Secret에 아래 값을 추가하세요.

- `YOUTUBE_API_KEY`: YouTube Data API v3 키 (GitHub Secret로만 관리, 소스에 하드코딩 금지)
- `MIN_VIDEO_AGE_DAYS`: 자막 다운로드 시도 최소 경과일 (기본값 7)

### 수동 실행
```bash
YOUTUBE_API_KEY=YOUR_KEY MIN_VIDEO_AGE_DAYS=7 node scripts/auto_update_subtitles.mjs
```

테스트 모드(파일 미반영):
```bash
YOUTUBE_API_KEY=YOUR_KEY MIN_VIDEO_AGE_DAYS=7 node scripts/auto_update_subtitles.mjs --dry-run
```
