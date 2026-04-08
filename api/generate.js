export const config = { runtime: 'edge' };

function extractText(html, url) {
  // Strip scripts, styles, and noise via regex (no DOM in edge runtime)
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const getTag = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  const pageTitle = getTag(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const existingDesc = getTag(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i)
    || getTag(/<meta[^>]*content=["']([^"']*)[^>]*name=["']description["']/i);

  // Strip remaining tags, decode basic entities, collapse whitespace
  const text = clean
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  return { text, pageTitle, existingDesc };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { url } = body;
  if (!url) {
    return new Response(JSON.stringify({ error: 'Missing url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Try direct fetch first, fall back to Jina.ai Reader
  let pageContent;

  async function tryDirect() {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MetaTagBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!pageRes.ok) throw new Error(`Page returned ${pageRes.status}`);
    const html = await pageRes.text();
    const content = extractText(html, url);
    if (!content.text || content.text.length < 50) throw new Error('Too little content');
    return content;
  }

  async function tryJina() {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
      },
    });
    if (!jinaRes.ok) throw new Error(`Jina returned ${jinaRes.status}`);
    const text = (await jinaRes.text()).slice(0, 6000);
    if (!text || text.length < 50) throw new Error('Too little content from Jina');
    return { text, pageTitle: '', existingDesc: '' };
  }

  try {
    pageContent = await tryDirect();
  } catch {
    try {
      pageContent = await tryJina();
    } catch (err) {
      return new Response(JSON.stringify({ error: `Could not fetch page content: ${err.message}` }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  const prompt = `You are an SEO expert. Analyze the following webpage content and generate optimized meta tags.

URL: ${url}
Page Title: ${pageContent.pageTitle}
Existing Description: ${pageContent.existingDesc || 'none'}

Content excerpt:
${pageContent.text}

Generate meta tags following these rules:
- title: 50-60 characters, compelling, includes main keyword
- description: 140-160 characters, includes CTA or value prop
- keywords: 5-8 relevant comma-separated keywords
- og_title: Same as or slight variation of title (50-60 chars)
- og_description: 150-200 chars, engaging for social sharing
- og_type: "website" unless clearly a blog post/article (use "article")
- twitter_card: always "summary_large_image"
- twitter_title: Same as og_title
- twitter_description: 150-200 chars, punchy for Twitter

Respond with ONLY a valid JSON object (no markdown, no explanation):
{
  "title": "...",
  "description": "...",
  "keywords": "...",
  "og_title": "...",
  "og_description": "...",
  "og_type": "...",
  "twitter_card": "...",
  "twitter_title": "...",
  "twitter_description": "..."
}`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json().catch(() => ({}));
    return new Response(JSON.stringify({ error: err.error?.message || `Claude API error ${claudeRes.status}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const claudeData = await claudeRes.json();
  const text = claudeData.content?.[0]?.text || '';

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return new Response(JSON.stringify({ error: 'Could not parse Claude response' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let metaData;
  try {
    metaData = JSON.parse(match[0]);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON from Claude' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify(metaData), {
    headers: { 'Content-Type': 'application/json' },
  });
}
