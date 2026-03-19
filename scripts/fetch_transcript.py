#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

import requests
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    CouldNotRetrieveTranscript,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)
from youtube_transcript_api.formatters import SRTFormatter
from youtube_transcript_api.proxies import GenericProxyConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch YouTube transcript and write SRT")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lang", default="ko")
    parser.add_argument("--proxy", default="")
    return parser.parse_args()


def _build_api(proxy: str) -> YouTubeTranscriptApi:
    http_client = requests.Session()
    http_client.trust_env = False

    if proxy:
        return YouTubeTranscriptApi(
            proxy_config=GenericProxyConfig(http_url=proxy, https_url=proxy),
            http_client=http_client,
        )

    return YouTubeTranscriptApi(http_client=http_client)


def _fetch_with_fallback(api: YouTubeTranscriptApi, video_id: str, lang: str):
    transcript_list = api.list(video_id)

    try:
        return transcript_list.find_transcript([lang]).fetch()
    except NoTranscriptFound:
        if lang != "ko":
            raise

    # ko가 없으면 자동 생성/번역 가능한 자막에서 한국어로 폴백
    candidates = []
    for preferred in ("ko", "en", "ja"):
        try:
            candidates.append(transcript_list.find_transcript([preferred]))
        except NoTranscriptFound:
            continue

    for transcript in transcript_list:
        if transcript not in candidates:
            candidates.append(transcript)

    for transcript in candidates:
        if transcript.is_translatable:
            try:
                return transcript.translate("ko").fetch()
            except Exception:
                continue

    raise NoTranscriptFound(video_id, [lang], transcript_list)


def _deduplicate_transcript(transcript: list) -> list:
    """YouTube 자동 생성 자막 등에서 발생하는 중복 텍스트 제거"""
    if not transcript:
        return transcript

    deduped = []
    
    for entry in transcript:
        text = entry.get("text", "").strip()
        if not text:
            continue

        if not deduped:
            deduped.append(entry)
            continue

        prev = deduped[-1]
        prev_text = prev.get("text", "").strip()

        # 1. 완전 동일한 경우 건너뜀
        if text == prev_text:
            continue

        # 2. 'A' + 'A B' -> 'A B' (접두어 중복)
        if text.startswith(prev_text):
            # 이전 항목을 현재 항목으로 대체 (시간/텍스트 업데이트)
            deduped[-1] = entry
            continue

        # 3. 'A B' + 'B' -> 'A B' (접미어 중복)
        if prev_text.endswith(text):
            # 현재 항목을 무시하고 이전 항목의 시간을 연장
            prev["duration"] += entry.get("duration", 0)
            continue

        # 4. 'A B' + 'B C' -> 'A B C' (부분 겹침 - 자동자막의 흔한 패턴)
        # 단어 단위로 쪼개서 겹치는지 확인
        prev_words = prev_text.split()
        curr_words = text.split()
        
        overlap_found = False
        # 최소 1단어 이상 겹치는지 확인 (뒤에서부터)
        for i in range(1, min(len(prev_words), len(curr_words)) + 1):
            if prev_words[-i:] == curr_words[:i]:
                # 겹치는 부분을 제외하고 합침
                new_text = " ".join(prev_words + curr_words[i:])
                prev["text"] = new_text
                prev["duration"] += entry.get("duration", 0)
                overlap_found = True
                break
        
        if not overlap_found:
            deduped.append(entry)

    return deduped


def main() -> int:
    args = parse_args()

    try:
        api = _build_api(args.proxy)
        transcript = _fetch_with_fallback(api, args.video_id, args.lang)
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable, CouldNotRetrieveTranscript) as exc:
        print(f"{exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1
    except requests.RequestException as exc:
        print(f"RequestException: {exc}", file=sys.stderr)
        return 1

    # 중복 제거 로직 적용
    transcript = _deduplicate_transcript(transcript)

    srt_text = SRTFormatter().format_transcript(transcript)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(srt_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
