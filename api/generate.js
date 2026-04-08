export const config = { runtime: 'edge' };

function extractText(html) {
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const pageTitle = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';
  const existingDesc =
    (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i) || [])[1] ||
    (html.match(/<meta[^>]*content=["']([^"']*)[^>]*name=["']description["']/i) || [])[1] || '';

  const text = clean
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 6000);

  return { text, pageTitle, existingDesc };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

    const firecrawlKey = process.env.FIRECRAWL_API_KEY;

    let body;
    try { body = await req.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400); }

    const { url } = body;
    if (!url) return json({ error: 'Missing url' }, 400);

    // --- Fetch page content ---
    let pageContent = null;

    // 1. Try direct fetch
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MetaTagBot/1.0)', 'Accept': 'text/html' },
        redirect: 'follow',
      });
      if (res.ok) {
        const html = await res.text();
        const content = extractText(html);
        if (content.text.length >= 100) pageContent = content;
      }
    } catch { /* fall through */ }

    // 2. Try Jina.ai Reader
    if (!pageContent) {
      try {
        const res = await fetch(`https://r.jina.ai/${url}`, {
          headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
        });
        if (res.ok) {
          const text = (await res.text()).slice(0, 6000);
          if (text.length >= 100) pageContent = { text, pageTitle: '', existingDesc: '' };
        }
      } catch { /* fall through */ }
    }

    // 3. Try Firecrawl
    if (!pageContent && firecrawlKey) {
      try {
        const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${firecrawlKey}`,
          },
          body: JSON.stringify({ url, formats: ['markdown'] }),
        });
        if (res.ok) {
          const data = await res.json();
          const text = (data?.data?.markdown || '').slice(0, 6000);
          if (text.length >= 100) {
            pageContent = {
              text,
              pageTitle: data?.data?.metadata?.title || '',
              existingDesc: data?.data?.metadata?.description || '',
            };
          }
        }
      } catch { /* fall through */ }
    }

    if (!pageContent) {
      return json({ error: 'Could not extract content from that page. It may be fully JavaScript-rendered or heavily protected.' }, 422);
    }

    // --- Call Claude ---
    const prompt = `You are an SEO expert. Analyze the following webpage content and generate optimized meta tags.

URL: ${url}
Page Title: ${pageContent.pageTitle}
Existing Description: ${pageContent.existingDesc || 'none'}

Content:
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
      return json({ error: err.error?.message || `Claude API error ${claudeRes.status}` }, 502);
    }

    const claudeData = await claudeRes.json();
    const responseText = claudeData.content?.[0]?.text || '';
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: 'Could not parse Claude response' }, 502);

    let metaData;
    try { metaData = JSON.parse(match[0]); }
    catch { return json({ error: 'Invalid JSON from Claude' }, 502); }

    return json(metaData);

  } catch (err) {
    return json({ error: `Unexpected error: ${err.message}` }, 500);
  }
}
