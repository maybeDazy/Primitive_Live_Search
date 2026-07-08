import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const SUBTITLES_DIR = path.join(ROOT_DIR, 'subtitles');
const MAPPING_PATH = path.join(SUBTITLES_DIR, 'subtitle_mapping.json');
const OUTPUT_PATH = path.join(SUBTITLES_DIR, 'chunks.json');

const CHUNK_LINES = Number.parseInt(process.env.CHUNK_LINES || '80', 10);
const CHUNK_OVERLAP = Number.parseInt(process.env.CHUNK_OVERLAP || '15', 10);

function timeToSeconds(ts) {
  const m = ts.match(/(\d+):(\d+):(\d+)(?:[.,](\d+))?/);
  if (!m) return 0;
  return Number.parseInt(m[1]) * 3600 + Number.parseInt(m[2]) * 60 + Number.parseInt(m[3]) + (m[4] ? Number.parseInt(m[4].padEnd(3, '0')) / 1000 : 0);
}

function secondsToTimeStr(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseSrtPlainText(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const entries = [];
  let currentTime = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'WEBVTT' || trimmed.startsWith('Kind:') || trimmed.startsWith('Language:')) continue;

    const timeMatch = trimmed.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (timeMatch) {
      currentTime = { start: timeToSeconds(timeMatch[1]), end: timeToSeconds(timeMatch[2]) };
      continue;
    }

    if (currentTime && !trimmed.includes('<c>')) {
      const cleanText = trimmed.replace(/<[^>]+>/g, '').trim();
      if (cleanText) {
        entries.push({ time: { ...currentTime }, text: cleanText });
      }
      currentTime = null;
    }
  }

  return entries;
}

function groupIntoChunks(entries, linesPerChunk, overlap) {
  const chunks = [];
  let i = 0;

  while (i < entries.length) {
    const slice = entries.slice(i, i + linesPerChunk);
    if (slice.length === 0) break;

    let lastText = '';
    const uniqueTexts = [];
    for (const e of slice) {
      const t = e.text.trim();
      if (t && t !== lastText) {
        uniqueTexts.push(t);
        lastText = t;
      }
    }

    const text = uniqueTexts.join(' ');
    if (text.length < 20) {
      i += linesPerChunk;
      continue;
    }

    chunks.push({
      start: slice[0].time.start,
      end: slice[slice.length - 1].time.end,
      text
    });

    i += linesPerChunk - overlap;
  }

  return chunks;
}

async function main() {
  console.log('Loading subtitle mapping...');
  const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8'));

  const videoMap = new Map();
  for (const v of mapping.videos) {
    for (const sub of v.subtitles) {
      videoMap.set(sub.filename, {
        videoId: v.id,
        title: v.title,
        url: `https://www.youtube.com/watch?v=${v.id}`
      });
    }
  }

  const chunkResults = [];

  for (const [filename, videoInfo] of videoMap) {
    const filePath = path.join(SUBTITLES_DIR, filename);
    if (!fs.existsSync(filePath)) continue;

    const entries = parseSrtPlainText(filePath);
    if (entries.length === 0) continue;

    const chunks = groupIntoChunks(entries, CHUNK_LINES, CHUNK_OVERLAP);

    for (let ci = 0; ci < chunks.length; ci++) {
      const c = chunks[ci];
      chunkResults.push({
        id: `${filename.replace('.srt', '')}_${ci}`,
        v: videoInfo.videoId,
        t: videoInfo.title,
        u: videoInfo.url,
        s: c.start,
        e: c.end,
        ts: secondsToTimeStr(c.start),
        te: secondsToTimeStr(c.end),
        x: c.text.slice(0, 800)
      });
    }

    if (chunkResults.length % 500 === 0) {
      console.log(`Processed ${chunkResults.length} chunks...`);
    }
  }

  const outputData = {
    version: 2,
    totalChunks: chunkResults.length,
    createdAt: new Date().toISOString(),
    chunks: chunkResults
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData));
  console.log(`Done: ${chunkResults.length} chunks written to ${OUTPUT_PATH}`);
  console.log(`File size: ${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch(err => { console.error(err); process.exit(1); });
