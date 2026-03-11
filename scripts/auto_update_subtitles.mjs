import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SUBTITLES_DIR = path.join(ROOT_DIR, 'subtitles');
const MAPPING_PATH = path.join(SUBTITLES_DIR, 'subtitle_mapping.json');
const INDEX_HTML_PATH = path.join(ROOT_DIR, 'index.html');
const ZIP_PATH = path.join(SUBTITLES_DIR, 'subtitles.zip');


function loadEnvFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFileIfExists(path.join(ROOT_DIR, '.env.local'));
loadEnvFileIfExists(path.join(ROOT_DIR, '.env'));

const CHANNEL_ID = process.env.CHANNEL_ID || 'UCqaSH5Js_s80nIY3P_wqCcg';
const API_KEY = process.env.YOUTUBE_API_KEY;
const SUB_LANG = process.env.SUBTITLE_LANG || 'ko';
const DRY_RUN = process.argv.includes('--dry-run');
const MIN_VIDEO_AGE_DAYS = Number.parseInt(process.env.MIN_VIDEO_AGE_DAYS || '7', 10);

if (!API_KEY) {
  throw new Error('YOUTUBE_API_KEY 환경변수가 필요합니다.');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr}`));
    });
  });
}

async function fetchJson(url, params = {}) {
  const search = new URLSearchParams(params);
  const res = await fetch(`${url}?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`API 실패: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchUploadsPlaylistId(channelId) {
  const json = await fetchJson('https://www.googleapis.com/youtube/v3/channels', {
    key: API_KEY,
    id: channelId,
    part: 'contentDetails'
  });
  const item = json.items?.[0];
  if (!item?.contentDetails?.relatedPlaylists?.uploads) {
    throw new Error('업로드 플레이리스트를 찾지 못했습니다.');
  }
  return item.contentDetails.relatedPlaylists.uploads;
}

async function fetchAllVideos(uploadsPlaylistId) {
  const videos = [];
  let pageToken = undefined;

  do {
    const json = await fetchJson('https://www.googleapis.com/youtube/v3/playlistItems', {
      key: API_KEY,
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: '50',
      pageToken
    });

    for (const item of json.items || []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      const publishedAt = item.snippet?.publishedAt;
      if (!videoId || !title) continue;
      videos.push({ videoId, title, publishedAt });
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  videos.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  return videos;
}

function nextSubtitleNumber(mappingData) {
  let maxNum = 0;
  for (const video of mappingData.videos || []) {
    const file = video.subtitles?.[0]?.filename || '';
    const num = Number.parseInt(file.replace(/\D/g, ''), 10);
    if (Number.isFinite(num)) maxNum = Math.max(maxNum, num);
  }
  return maxNum + 1;
}

function ytDlpBinary() {
  return process.env.YT_DLP_BIN || 'yt-dlp';
}

async function downloadSubtitle(videoId, number) {
  const basename = String(number).padStart(3, '0');
  const outputTpl = path.join(SUBTITLES_DIR, basename);
  const command = ytDlpBinary();

  await runCommand(command, [
    '--skip-download',
    '--write-auto-sub',
    '--sub-lang', SUB_LANG,
    '--sub-format', 'vtt',
    '--output', outputTpl,
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  const candidate = path.join(SUBTITLES_DIR, `${basename}.${SUB_LANG}.vtt`);
  const target = path.join(SUBTITLES_DIR, `${basename}.srt`);

  if (!fs.existsSync(candidate)) {
    throw new Error(`자막 파일 누락: ${path.basename(candidate)}`);
  }

  fs.renameSync(candidate, target);
  return `${basename}.srt`;
}

function updateIndexLog(indexHtml, count, dateText) {
  const marker = '<div class="update-log-content">';
  const pos = indexHtml.indexOf(marker);
  if (pos < 0) return indexHtml;

  const insertPos = pos + marker.length;
  const message = `\n      <div class="update-item">\n        <span class="update-date">${dateText}</span>\n        자동 업데이트: 새 영상 ${count}개 자막을 추가했습니다\n      </div>`;
  return `${indexHtml.slice(0, insertPos)}${message}${indexHtml.slice(insertPos)}`;
}

async function rebuildZip() {
  if (process.platform === 'win32') {
    // GitHub Actions는 Linux이므로 윈도우에서는 스킵
    console.warn('Windows 환경에서는 subtitles.zip 자동 재생성을 건너뜁니다.');
    return;
  }

  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
  await runCommand('zip', ['-q', '-j', ZIP_PATH, ...fs.readdirSync(SUBTITLES_DIR)
    .filter((f) => /\.(srt|vtt)$/i.test(f))
    .map((f) => path.join(SUBTITLES_DIR, f))
  ]);
}

async function main() {
  const mapping = readJson(MAPPING_PATH);
  const knownVideoIds = new Set((mapping.videos || []).map((v) => v.id));

  const uploadsPlaylistId = await fetchUploadsPlaylistId(CHANNEL_ID);
  const allVideos = await fetchAllVideos(uploadsPlaylistId);

  const cutoffDate = new Date(Date.now() - MIN_VIDEO_AGE_DAYS * 24 * 60 * 60 * 1000);
  const eligibleNewVideos = allVideos.filter((v) => {
    if (knownVideoIds.has(v.videoId)) return false;
    if (!v.publishedAt) return false;
    return new Date(v.publishedAt) <= cutoffDate;
  });

  if (eligibleNewVideos.length === 0) {
    console.log(`처리 가능한 신규 영상 없음 (업로드 ${MIN_VIDEO_AGE_DAYS}일 경과 기준).`);
    return;
  }

  console.log(`신규 영상 ${eligibleNewVideos.length}개 발견 (업로드 ${MIN_VIDEO_AGE_DAYS}일 경과).`);

  let nextNum = nextSubtitleNumber(mapping);
  const addedEntries = [];

  for (const video of eligibleNewVideos) {
    const filename = `${String(nextNum).padStart(3, '0')}.srt`;
    const filePath = path.join(SUBTITLES_DIR, filename);

    if (!DRY_RUN) {
      if (!fs.existsSync(filePath)) {
        await downloadSubtitle(video.videoId, nextNum);
      }
    }

    addedEntries.push({
      id: video.videoId,
      title: video.title,
      subtitles: [{
        filename,
        language: SUB_LANG,
        language_name: SUB_LANG === 'ko' ? '한국어' : SUB_LANG,
        filepath: `subtitles\\${filename}`
      }]
    });

    nextNum += 1;
  }

  mapping.videos.push(...addedEntries);
  mapping.totalVideos = mapping.videos.length;
  mapping.totalSubtitles = mapping.videos.length;
  mapping.updatedAt = new Date().toISOString();

  const today = new Date().toISOString().slice(0, 10);

  if (!DRY_RUN) {
    writeJson(MAPPING_PATH, mapping);

    const currentHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
    const updatedHtml = updateIndexLog(currentHtml, addedEntries.length, today);
    fs.writeFileSync(INDEX_HTML_PATH, updatedHtml, 'utf-8');

    await rebuildZip();
  }

  console.log(`완료: ${addedEntries.length}개 자막/매핑/업데이트 로그 갱신.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
