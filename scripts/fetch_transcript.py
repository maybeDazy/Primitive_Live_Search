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

    srt_text = SRTFormatter().format_transcript(transcript)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(srt_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
