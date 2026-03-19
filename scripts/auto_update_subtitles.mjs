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
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const TRANSCRIPT_PROXY = process.env.YT_TRANSCRIPT_PROXY || process.env.YT_DLP_PROXY || '';
const RETRY_WITHOUT_PROXY_ON_BLOCK = process.env.RETRY_WITHOUT_PROXY_ON_BLOCK !== 'false';

if (!API_KEY) {
  throw new Error('YOUTUBE_API_KEY 환경변수가 필요합니다.');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function redactSensitiveText(input) {
  return String(input || '').replace(/:\/\/([^:@\s]+):([^@\/\s]+)@/g, '://***:***@');
}

function formatErrorForLog(error) {
  if (!error) return '알 수 없는 오류';

  const lines = [];
  lines.push(`message: ${String(error.message || error)}`);

  if (error.command || error.args) {
    const cmdLine = [error.command, ...(error.args || [])].filter(Boolean).join(' ');
    if (cmdLine) lines.push(`command: ${cmdLine}`);
  }

  if (error.code !== undefined) {
    lines.push(`exit_code: ${error.code}`);
  }

  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();

  if (stderr) {
    lines.push('stderr:');
    lines.push(stderr);
  }

  if (stdout) {
    lines.push('stdout:');
    lines.push(stdout);
  }

  return redactSensitiveText(lines.join('\n')).trim();
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
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`${command} ${args.join(' ')} failed (${code})`);
      error.command = command;
      error.args = args;
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function isSkippableTranscriptError(error) {
  const msg = String(error?.message || '').toLowerCase();
  const stderr = String(error?.stderr || '').toLowerCase();
  return (
    msg.includes('transcriptsdisabled') ||
    msg.includes('notranscriptfound') ||
    msg.includes('transcriptunavailable') ||
    msg.includes('videounavailable') ||
    msg.includes('requests blocked') ||
    msg.includes('ip is blocked') ||
    msg.includes('could not retrieve a transcript') ||
    msg.includes('requestexception') ||
    msg.includes('proxyerror') ||
    msg.includes('tunnel connection failed') ||
    msg.includes('403 forbidden') ||
    stderr.includes('transcriptsdisabled') ||
    stderr.includes('notranscriptfound') ||
    stderr.includes('could not retrieve a transcript')
  );
}

function isProxyRetryableTranscriptError(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('requests blocked') ||
    msg.includes('ip is blocked') ||
    msg.includes('could not retrieve a transcript') ||
    msg.includes('requestexception') ||
    msg.includes('proxyerror') ||
    msg.includes('tunnel connection failed') ||
    msg.includes('403 forbidden')
  );
}

async function fetchJson(url, params = {}) {
  const cleanedParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  const search = new URLSearchParams(cleanedParams);
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
  let recoveredInvalidToken = false;

  while (true) {
    let json;
    const params = {
      key: API_KEY,
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: '50'
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    try {
      json = await fetchJson('https://www.googleapis.com/youtube/v3/playlistItems', params);
    } catch (error) {
      const message = String(error?.message || '');
      if (pageToken && !recoveredInvalidToken && message.includes('invalidPageToken')) {
        console.warn('invalidPageToken 감지: pageToken 없이 1회 재시도합니다.');
        pageToken = undefined;
        recoveredInvalidToken = true;
        continue;
      }
      throw error;
    }

    for (const item of json.items || []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      const publishedAt = item.snippet?.publishedAt;
      if (!videoId || !title) continue;
      videos.push({
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title,
        publishedAt
      });
    }

    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }

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

async function downloadSubtitle(videoId, number) {
  const basename = String(number).padStart(3, '0');
  const target = path.join(SUBTITLES_DIR, `${basename}.srt`);

  const buildArgs = (useProxy) => {
    const args = [
      path.join(ROOT_DIR, 'scripts', 'fetch_transcript.py'),
      '--video-id', videoId,
      '--output', target,
      '--lang', SUB_LANG
    ];

    if (useProxy && TRANSCRIPT_PROXY) {
      args.push('--proxy', TRANSCRIPT_PROXY);
    }

    return args;
  };

  try {
    await runCommand(PYTHON_BIN, buildArgs(true));
  } catch (error) {
    if (TRANSCRIPT_PROXY && RETRY_WITHOUT_PROXY_ON_BLOCK && isProxyRetryableTranscriptError(error)) {
      console.warn(`프록시 경로 실패, 무프록시 1회 재시도: ${videoId}\n${formatErrorForLog(error)}`);
      await runCommand(PYTHON_BIN, buildArgs(false));
    } else {
      throw error;
    }
  }

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
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);

  if (process.platform === 'win32') {
    const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('subtitles', 'subtitles/subtitles.zip', [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
    await runCommand('powershell', ['-Command', psCommand]);
    return;
  }

  await runCommand('zip', ['-q', '-j', ZIP_PATH, ...fs.readdirSync(SUBTITLES_DIR)
    .filter((f) => /\.(srt|vtt)$/i.test(f))
    .map((f) => path.join(SUBTITLES_DIR, f))
  ]);
}

function extractVideoIdFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') || '';
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.replace('/', '').trim();
    }
    return '';
  } catch {
    return '';
  }
}

function buildKnownVideoKeySet(mapping) {
  const keys = new Set();
  for (const video of mapping.videos || []) {
    const id = (video.id || '').trim();
    if (id) {
      keys.add(id);
      keys.add(`https://www.youtube.com/watch?v=${id}`);
    }

    const url = (video.url || '').trim();
    if (url) {
      keys.add(url);
      const urlId = extractVideoIdFromUrl(url);
      if (urlId) keys.add(urlId);
    }
  }
  return keys;
}

async function main() {
  const mapping = readJson(MAPPING_PATH);
  const knownVideoKeys = buildKnownVideoKeySet(mapping);

  const uploadsPlaylistId = await fetchUploadsPlaylistId(CHANNEL_ID);
  const allVideos = await fetchAllVideos(uploadsPlaylistId);

  const cutoffDate = new Date(Date.now() - MIN_VIDEO_AGE_DAYS * 24 * 60 * 60 * 1000);
  const eligibleNewVideos = allVideos.filter((v) => {
    if (knownVideoKeys.has(v.videoId) || knownVideoKeys.has(v.url)) return false;
    if (!v.publishedAt) return false;
    return new Date(v.publishedAt) <= cutoffDate;
  }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  if (eligibleNewVideos.length === 0) {
    console.log(`처리 가능한 신규 영상 없음 (업로드 ${MIN_VIDEO_AGE_DAYS}일 경과 기준).`);
    return;
  }

  console.log(`신규 영상 ${eligibleNewVideos.length}개 발견 (업로드 ${MIN_VIDEO_AGE_DAYS}일 경과).`);

  let nextNum = nextSubtitleNumber(mapping);
  const addedEntries = [];
  const skippedVideos = [];

  for (const video of eligibleNewVideos) {
    const currentNum = nextNum;
    nextNum += 1;

    const filename = `${String(currentNum).padStart(3, '0')}.srt`;
    const filePath = path.join(SUBTITLES_DIR, filename);

    try {
      if (!DRY_RUN) {
        if (!fs.existsSync(filePath)) {
          await downloadSubtitle(video.videoId, currentNum);
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

    } catch (error) {
      if (isSkippableTranscriptError(error)) {
        const detailed = formatErrorForLog(error);
        console.warn(`건너뜀 [${video.videoId}] ${video.title}\n${detailed}`);
        skippedVideos.push(video.videoId);
        continue;
      }
      throw error;
    }
  }

  if (addedEntries.length === 0) {
    console.log(`추가된 자막이 없습니다. 건너뜀: ${skippedVideos.length}개`);
    return;
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

  console.log(`완료: ${addedEntries.length}개 자막/매핑/업데이트 로그 갱신. 건너뜀 ${skippedVideos.length}개.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
