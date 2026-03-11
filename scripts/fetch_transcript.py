#!/usr/bin/env python3
import argparse
from pathlib import Path

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    CouldNotRetrieveTranscript,
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)
from youtube_transcript_api.formatters import SRTFormatter


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch YouTube transcript and write SRT")
    parser.add_argument("--video-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lang", default="ko")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        transcript = YouTubeTranscriptApi().fetch(args.video_id, languages=[args.lang])
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable, CouldNotRetrieveTranscript) as exc:
        raise SystemExit(f"{exc.__class__.__name__}: {exc}") from exc

    srt_text = SRTFormatter().format_transcript(transcript)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(srt_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
