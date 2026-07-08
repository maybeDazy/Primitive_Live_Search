let chunksCache = null;
let chunksPromise = null;

async function getChunks(env) {
  if (chunksCache) return chunksCache;
  if (chunksPromise) return chunksPromise;
  chunksPromise = (async () => {
    const resp = await fetch(env.CHUNKS_URL);
    const data = await resp.json();
    chunksCache = data.chunks;
    return chunksCache;
  })();
  return chunksPromise;
}

function buildNgramSet(text, n = 2) {
  const clean = text.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i <= clean.length - n; i++) {
    set.add(clean.slice(i, i + n));
  }
  return set;
}

function searchChunks(chunks, question, topK = 15) {
  const qNgrams = buildNgramSet(question);
  const qSize = qNgrams.size || 1;
  const scored = chunks.map(chunk => {
    const cNgrams = buildNgramSet(chunk.x);
    let matches = 0;
    for (const ng of qNgrams) {
      if (cNgrams.has(ng)) matches++;
    }
    return { score: matches / qSize, chunk };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function buildContextText(topChunks) {
  return topChunks.map((c, i) => {
    const ch = c.chunk;
    return `[출처 ${i + 1}]
영상: ${ch.t}
시간: ${ch.ts}
내용: ${ch.x}`;
  }).join('\n\n');
}

async function generateAnswer(question, topChunks, env) {
  const context = buildContextText(topChunks);
  const systemPrompt = `당신은 유튜버 "프리미티브"의 Q&A 영상 자막 데이터를 기반으로 질문에 답변하는 AI 어시스턴트입니다.

아래는 질문과 관련된 자막 컨텍스트입니다. 이 컨텍스트를 바탕으로 질문에 답변해주세요.

규칙:
1. 컨텍스트에 있는 정보만 사용해서 답변하세요.
2. 컨텍스트에 없는 내용은 "컨텍스트에서 찾을 수 없는 내용입니다"라고 말하세요.
3. 답변은 한국어로 해주세요.
4. 답변 마지막에 관련 출처(영상 제목과 타임스탬프)를 표시해주세요.
5. 답변은 간결하고 정확하게 해주세요.

컨텍스트:
${context}`;

  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.NVIDIA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.LLM_MODEL || 'deepseek-ai/deepseek-v4-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      temperature: 0.3,
      max_tokens: 1024
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`NVIDIA API error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.choices[0].message.content;
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
        const { question, topK = 10 } = await request.json();
        if (!question || typeof question !== 'string' || !question.trim()) {
          return new Response(
            JSON.stringify({ error: 'question is required' }),
            { status: 400, headers: corsHeaders }
          );
        }

        const chunks = await getChunks(env);
        const topChunks = searchChunks(chunks, question, topK)
          .filter(c => c.score > 0.01);

        if (topChunks.length === 0) {
          return new Response(JSON.stringify({
            answer: '관련된 자막 내용을 찾을 수 없습니다.',
            sources: []
          }), { headers: corsHeaders });
        }

        const answer = await generateAnswer(question, topChunks, env);

        return new Response(JSON.stringify({
          answer,
          sources: topChunks.map(c => ({
            videoTitle: c.chunk.t,
            videoUrl: c.chunk.u,
            startTime: c.chunk.ts,
            text: c.chunk.x.slice(0, 200)
          }))
        }), { headers: corsHeaders });
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
