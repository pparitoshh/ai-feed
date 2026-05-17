# AINews — Scrolling AI Feed

Personal, distraction-free scrolling feed for AI/GenAI news. HN-style UI. No algorithm, no noise.

**Live URL:** https://pparitoshh.github.io/ai-feed
**Repo:** https://github.com/pparitoshh/ai-feed

---

## What it does

- Snap-scroll cards (one post per screen, mobile-first)
- Sources: Substack newsletters + Chip Huyen blog + News sites + GitHub trending AI repos + hand-picked "picks"
- Gamification: daily streak, XP bar, levels tracked in localStorage
- Tabs: all / picks ★ / substack / chip huyen / news / github ⭐ / saved
- Keyboard: j/k or arrow keys to scroll, b to bookmark, Enter to open

## Sources (configured in `index.html`)

### RSS feeds (`FEEDS` array)

| ID    | Name                 | Type     | URL                                                            |
|-------|----------------------|----------|----------------------------------------------------------------|
| tdab  | To Data & Beyond     | substack | todatabeyond.substack.com/feed                                 |
| decml | Decoding ML          | substack | decodingml.substack.com/feed                                   |
| llmw  | LLM Watch            | substack | xaiguy.substack.com/feed                                       |
| decai | Decoding AI Magazine | substack | decodingaimagazine.substack.com/feed                           |
| chip  | Chip Huyen           | chip     | huyenchip.com/feed.xml *(verified)*                            |
| imf   | IM Founder           | news     | imfounder.com/feed/                                            |
| mprof | MarketingProfs       | news     | feeds.feedblitz.com/marketingprofs-all-in-one                  |

### Hand-picked items (`FEATURED` array)

These have no RSS feed, so they're added as static cards pinned to the top of the feed and to the **picks ★** tab:

- **Good AI List** — https://goodailist.com/
- **Chip Huyen's Cool LLM Repos** — https://github.com/stars/chiphuyen/lists/cool-llm-repos
- **What I learned from looking at 900 most popular open source AI tools** (Chip Huyen) — https://huyenchip.com/2024/03/14/ai-oss.html

### GitHub trending

GitHub Search API (`llm generative-ai`, sorted by stars, last 45 days). Interleaved every 5 posts.

---

## RSS fetching

`rss2json.com` was rate-limited and dropping feeds (Substack + Chip Huyen returned empty). It has been replaced with a **CORS proxy chain** that fetches raw XML, then parses it client-side with `DOMParser`. Both RSS 2.0 and Atom are supported.

Proxy chain (tried in order; first one returning XML wins):

1. `https://api.allorigins.win/raw?url=`
2. `https://corsproxy.io/?`
3. `https://api.codetabs.com/v1/proxy/?quest=`

If all three fail for a feed, the feed silently yields zero items (existing behaviour).

### Optional: self-hosted Cloudflare Worker

If the public proxies degrade, deploy a Worker at `workers.cloudflare.com` and add it to the chain:

```js
// worker.js
export default {
  async fetch(req) {
    const url = new URL(req.url).searchParams.get('url');
    if (!url) return new Response('missing url', { status: 400 });
    const res = await fetch(url, { headers: { 'User-Agent': 'AINews/1.0' } });
    const xml = await res.text();
    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=600',
      },
    });
  },
};
```

Then prepend to `PROXIES` in `index.html`:

```js
url => `https://<your-worker>.workers.dev/?url=${encodeURIComponent(url)}`,
```

---

## File structure

```
index.html    ← entire app, single file, no build step
README.md     ← this file
```

Everything is client-side. No framework, no dependencies, no build step. Deploy by pushing `index.html` to any static host.

---

## Adding a new source

**RSS feed:** append to `FEEDS` array in `index.html`:

```js
{ id:'myid', name:'My Source', author:'Name', url:'https://example.com/feed', color:'#ff6600', type:'news' },
```

Use one of the existing `type` values (`substack`, `chip`, `news`) so it lands in the right tab, or invent a new type and add it to `switchTab` + the `<div class="tabs">` block.

**Hand-picked (no RSS):** append to `FEATURED` array. Required fields: `id`, `type`, `title`, `desc`, `link`, `date`, `source`, `author`, `tags`, `min`, `featured: true`.

---

## Roadmap

1. PWA offline — service worker to cache last-seen cards
2. Source health badge — show which proxy succeeded per feed
3. Search across cached cards
4. RSS feed for Good AI List once one exists (currently a static card)
