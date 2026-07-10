let chunksCache = null;
let chunksPromise = null;

async function getChunks(env) {
  if (chunksCache) return chunksCache;
  if (chunksPromise) return chunksPromise;
  chunksPromise = (async () => {
    const resp = await fetch(env.CHUNKS_URL);
    const data = await resp.json();
    if (data.version === 3) {
      const videos = data.videos;
      chunksCache = data.chunks.map(c => ({
        x: c.x,
        v: videos[c.i].v,
        s: c.s,
        t: videos[c.i].t,
        u: videos[c.i].u,
        ts: (() => {
          const h = Math.floor(c.s / 3600);
          const m = Math.floor((c.s % 3600) / 60);
          const sec = Math.floor(c.s % 60);
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        })()
      }));
    } else {
      chunksCache = data.chunks;
    }
    return chunksCache;
  })();
  return chunksPromise;
}

// Korean-friendly tokenization: character bigrams + words
function tokenize(text) {
  const s = text.toLowerCase().replace(/\s+/g, ' ');
  const bigrams = new Set();
  const words = new Set(s.split(' ').filter(w => w.length > 0));
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.slice(i, i + 2));
  }
  return { words, bigrams, raw: s };
}

function searchChunks(chunks, question, topK = 15) {
  const q = tokenize(question);
  const scored = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const t = tokenize(ch.x);

    let wordScore = 0;
    for (const w of q.words) {
      if (t.raw.includes(w)) wordScore++;
    }
    wordScore = q.words.size > 0 ? wordScore / q.words.size : 0;

    let bigramScore = 0;
    for (const b of q.bigrams) {
      if (t.bigrams.has(b)) bigramScore++;
    }
    bigramScore = q.bigrams.size > 0 ? bigramScore / q.bigrams.size : 0;

    // Combined score: bigram is more reliable for Korean
    const score = bigramScore * 0.6 + wordScore * 0.4;
    if (score > 0) scored.push({ score, chunk: ch, videoId: ch.v });
  }

  scored.sort((a, b) => b.score - a.score);

  // Diverse selection: prefer top results but limit per video
  const seen = new Set();
  const diverse = [];
  for (const s of scored) {
    if (diverse.length >= topK) break;
    if (seen.has(s.videoId) && s.score < 0.3) continue;
    seen.add(s.videoId);
    diverse.push(s);
  }

  return diverse;
}

function buildContextText(topChunks) {
  return topChunks.map((c, i) => {
    const ch = c.chunk;
    return `[출처 ${i + 1}]
내용: ${ch.x}`;
  }).join('\n\n---\n\n');
}

const SYSTEM_PROMPT = `당신은 유튜브 채널 "프리미티브"의 영상 자막을 기반으로 질문에 답변하는 AI 어시스턴트입니다. 이 채널은 키토제닉(저탄고지), 카니보어(육식), 전래식단, 재생농업, 건강, 영양, 소고기/양고기 등의 동물성 식품에 대해 다룹니다.

## 핵심 규칙
- 주어진 자막 컨텍스트만 사용하여 답변하세요.
- 컨텍스트에 없는 내용은 절대 추측하지 말고 "자막에서 찾을 수 없는 내용입니다"라고 말하세요.
- 답변은 한국어로 2~3문장으로 간결하게, 마치 영상을 본 사람이 자연스럽게 설명하는 듯한 말투로 작성하세요.
- 출처 영상 제목이나 타임스탬프는 절대 포함하지 마세요. 대신 "채널에서 설명하기를", "자막에 따르면", "영상에서는 ~라고 합니다" 등의 자연스러운 인용 표현을 사용하세요.
- 질문과 관련된 구체적인 용어나 수치가 컨텍스트에 있으면 반드시 활용하세요.
- 답변은 확신을 가지고 작성하되, 컨텍스트 범위를 넘지 마세요.

## 예시

질문: "계란 많이 먹어도 돼?"
컨텍스트: [출처 1] ...계란은 완전단백질 식품으로 콜레스테롤 수치에 큰 영향을 주지 않는다는 연구 결과들이 있습니다... [출처 2] ...하루에 계란을 5~6개씩 먹어도 건강에 문제없다는 내용을 다뤘습니다...
답변: 채널에서 계란은 완전단백질 식품이며, 하루 5~6개 정도 섭취해도 콜레스테롤 수치에 큰 영향을 주지 않는다고 설명합니다. 다만 개인별 건강 상태에 따라 차이가 있을 수 있습니다.

질문: "비트코인 시세가 어떻게 되?"
컨텍스트: [출처 1] ...오늘 날씨가 참 좋네요... [출처 2] ...고양이 키우는 법...
답변: 자막에서 찾을 수 없는 내용입니다. 제공된 자막 컨텍스트에 비트코인 관련 내용이 없습니다.`;

async function generateAnswer(question, topChunks, env) {
  const context = buildContextText(topChunks);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const model = env.LLM_MODEL || 'qwen/qwen3.5-122b-a10b';

  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `질문: ${question}\n\n컨텍스트:\n${context}` }
      ],
      temperature: 0.2,
      max_tokens: 1024
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NVIDIA API error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content;
}

function encodeSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function streamAnswer(question, topChunks, sources, env) {
  const context = buildContextText(topChunks);
  const model = env.LLM_MODEL || 'qwen/qwen3.5-122b-a10b';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `질문: ${question}\n\n컨텍스트:\n${context}` }
      ],
      temperature: 0.2,
      max_tokens: 1024,
      stream: true
    }),
    signal: controller.signal
  });
  clearTimeout(timeout);

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NVIDIA API error: ${resp.status} ${err}`);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      await writer.write(encoder.encode(encodeSSE('sources', sources)));

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasContent = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              hasContent = true;
              await writer.write(encoder.encode(encodeSSE('token', { content })));
            }
          } catch {}
        }
      }

      if (!hasContent) {
        await writer.write(encoder.encode(encodeSSE('token', { content: '자막에서 관련 내용을 찾을 수 없습니다.' })));
      }

      await writer.write(encoder.encode(encodeSSE('done', {})));
    } catch (err) {
      await writer.write(encoder.encode(encodeSSE('error', { message: err.message })));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), { headers: corsHeaders });
    }

    if (url.pathname === '/api/ask' && request.method === 'POST') {
      try {
        const { question, topK = 10, stream = false } = await request.json();
        if (!question || typeof question !== 'string' || !question.trim()) {
          return new Response(
            JSON.stringify({ error: 'question is required' }),
            { status: 400, headers: corsHeaders }
          );
        }

        const chunks = await getChunks(env);
        const topChunks = searchChunks(chunks, question, topK)
          .filter(c => c.score > 0.01);

        const sources = topChunks.map(c => ({
          videoTitle: c.chunk.t,
          videoUrl: c.chunk.u,
          startTime: c.chunk.ts,
          startSeconds: c.chunk.s || 0,
          text: c.chunk.x.slice(0, 200)
        }));

        if (topChunks.length === 0) {
          return new Response(JSON.stringify({
            answer: '관련된 자막 내용을 찾을 수 없습니다.',
            sources: []
          }), { headers: corsHeaders });
        }

        if (stream) {
          return streamAnswer(question, topChunks, sources, env);
        }

        const answer = await generateAnswer(question, topChunks, env);
        return new Response(JSON.stringify({ answer, sources }), { headers: corsHeaders });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    if (url.pathname === '/api/search' && request.method === 'GET') {
      try {
        const question = url.searchParams.get('q');
        if (!question || !question.trim()) {
          return new Response(
            JSON.stringify({ error: 'q parameter is required' }),
            { status: 400, headers: corsHeaders }
          );
        }

        const chunks = await getChunks(env);
        const topChunks = searchChunks(chunks, question, 10)
          .filter(c => c.score > 0.01);

        return new Response(JSON.stringify({
          results: topChunks.map(c => ({
            score: c.score,
            videoTitle: c.chunk.t,
            videoUrl: c.chunk.u,
            startTime: c.chunk.ts,
            startSeconds: c.chunk.s || 0,
            text: c.chunk.x.slice(0, 300)
          }))
        }), { headers: corsHeaders });
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response('Not found', { status: 404 });
  }
};
