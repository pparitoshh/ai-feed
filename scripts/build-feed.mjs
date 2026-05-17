#!/usr/bin/env node
// Fetches all RSS feeds + GitHub trending repos, writes data/feed.json.
// Runs in GitHub Actions on a cron schedule (no browser, no CORS proxies needed).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'data', 'feed.json');
const MAX_ITEMS = 8;

const FEEDS = [
  { id:'tdab',  name:'To Data & Beyond',  author:'Youssef Hosni', url:'https://todatabeyond.substack.com/feed',       type:'substack' },
  { id:'decml', name:'Decoding ML',        author:'Paul Iusztin',  url:'https://decodingml.substack.com/feed',         type:'substack' },
  { id:'llmw',  name:'LLM Watch',          author:'Pascal Biese',  url:'https://xaiguy.substack.com/feed',             type:'substack' },
  { id:'decai', name:'Decoding AI Mag',    author:'',              url:'https://decodingaimagazine.substack.com/feed', type:'substack' },
  { id:'chip',  name:'Chip Huyen',         author:'Chip Huyen',    url:'https://huyenchip.com/feed.xml',               type:'chip' },
  { id:'imf',   name:'IM Founder',         author:'',              url:'https://imfounder.com/feed/',                  type:'news' },
  { id:'mprof', name:'MarketingProfs',     author:'',              url:'https://feeds.feedblitz.com/marketingprofs-all-in-one', type:'news' },
];

const TAG_MAP = [
  [/\brag\b/i,             'RAG'],
  [/agent|agentic/i,       'agents'],
  [/\bllm\b|large.lang/i,  'LLM'],
  [/fine.?tun/i,           'fine-tuning'],
  [/inference/i,           'inference'],
  [/eval|benchmark/i,      'eval'],
  [/mlops|deploy|prod/i,   'mlops'],
  [/transform|attention/i, 'transformers'],
  [/graph/i,               'graph'],
  [/interview/i,           'career'],
  [/distrib|parallel/i,    'distributed'],
  [/open.source/i,         'open-source'],
];

const tagsFor = (text) => {
  const out = [];
  for (const [re, l] of TAG_MAP) { if (re.test(text)) { out.push(l); if (out.length >= 3) break; } }
  return out;
};
const strip = (h) => (h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
const readMin = (t) => Math.max(1, Math.round((t || '').replace(/<[^>]+>/g, '').split(/\s+/).length / 200));
// 20-char slice was colliding on Substack URLs that share a long prefix.
// Use a stable FNV-1a hash of the full URL instead.
function uid(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Minimal XML extraction. Feeds are RSS 2.0 or Atom — both are well-formed,
// but we avoid a parser dependency by matching tags directly.
function extractItems(xml) {
  const items = [];
  const isAtom = /<feed[\s>][^]*?<entry[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>][^]*?<\/entry>/gi : /<item[\s>][^]*?<\/item>/gi;
  const blocks = xml.match(blockRe) || [];
  for (const b of blocks.slice(0, MAX_ITEMS)) {
    items.push(parseBlock(b, isAtom));
  }
  return items;
}

function tagText(block, name) {
  // CDATA or plain text — non-greedy capture.
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function atomLink(block) {
  // Prefer rel="alternate" or no rel; capture href.
  const links = block.match(/<link\b[^>]*>/gi) || [];
  for (const l of links) {
    const rel = (l.match(/\brel="([^"]+)"/i) || [])[1];
    if (!rel || rel === 'alternate') {
      const href = (l.match(/\bhref="([^"]+)"/i) || [])[1];
      if (href) return href;
    }
  }
  return tagText(block, 'link');
}

function parseBlock(b, isAtom) {
  const title = tagText(b, 'title');
  const description = tagText(b, 'description') || tagText(b, 'summary');
  const content = tagText(b, 'content:encoded') || tagText(b, 'content') || description;
  const pubDate = tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated');
  const author = tagText(b, 'dc:creator') || tagText(b, 'author').replace(/<[^>]+>/g, ' ').trim();
  const link = isAtom ? atomLink(b) : tagText(b, 'link');
  const categories = [...b.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map(m => m[1].trim());
  return { title, link, description, content, pubDate, author, categories };
}

// Browser-like UA — Substack and others 403 on bot UAs / datacenter IPs.
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROXIES = [
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];

async function tryFetch(url, label) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!r.ok) { console.warn(`${label} ${r.status}`); return null; }
    const txt = await r.text();
    if (!txt || !txt.includes('<')) { console.warn(`${label} no xml body`); return null; }
    return txt;
  } catch (e) {
    console.warn(`${label} ${e.message}`);
    return null;
  }
}

// Direct first, then CORS proxies (they fetch from residential / mixed IPs).
async function fetchText(url) {
  const direct = await tryFetch(url, `direct ${url}`);
  if (direct) return direct;
  for (const px of PROXIES) {
    const via = await tryFetch(px(url), `proxy ${url}`);
    if (via) return via;
  }
  return null;
}

async function loadFeed(feed) {
  const xml = await fetchText(feed.url);
  if (!xml) { console.warn(`no xml: ${feed.name}`); return []; }
  const items = extractItems(xml);
  if (!items.length) { console.warn(`no items: ${feed.name}`); return []; }
  return items.map(item => ({
    id:     uid(item.link),
    type:   feed.type,
    title:  item.title || '(no title)',
    desc:   strip(item.description || item.content || ''),
    link:   item.link,
    date:   item.pubDate,
    source: feed.name,
    author: feed.author || item.author || feed.name,
    tags:   tagsFor(item.title + ' ' + (item.categories || []).join(' ')),
    min:    readMin(item.content || item.description || ''),
  }));
}

async function loadGitHub() {
  try {
    const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const url = `https://api.github.com/search/repositories?q=llm+generative-ai+created:>${since}&sort=stars&order=desc&per_page=8`;
    const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'ainews-feed-builder/1.0' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(url, { headers });
    if (!r.ok) { console.warn(`github api ${r.status}`); return []; }
    const d = await r.json();
    return (d.items || []).map(repo => ({
      id:     uid(repo.html_url),
      type:   'github',
      title:  repo.full_name,
      desc:   repo.description || 'No description.',
      link:   repo.html_url,
      date:   repo.created_at,
      source: 'GitHub',
      author: repo.owner.login,
      tags:   ['⭐ ' + repo.stargazers_count.toLocaleString(), repo.language || ''].filter(Boolean),
      min:    null,
      stars:  repo.stargazers_count,
    }));
  } catch (e) {
    console.error(`github load failed: ${e.message}`);
    return [];
  }
}

// Drop repeats. Same source publishing a recurring title (e.g. weekly
// digests) collapses to the newest entry; identical links never appear twice.
function dedupe(cards) {
  const seenLink = new Set();
  const byKey = new Map();
  for (const c of cards) {
    if (c.link && seenLink.has(c.link)) continue;
    if (c.link) seenLink.add(c.link);
    const key = `${c.source}|${(c.title || '').trim().toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || new Date(c.date) > new Date(prev.date)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

async function main() {
  const [feedResults, ghCards] = await Promise.all([
    Promise.all(FEEDS.map(loadFeed)),
    loadGitHub(),
  ]);

  const posts = dedupe(feedResults.flat());
  const merged = [];
  let gi = 0;
  posts.forEach((c, i) => {
    merged.push(c);
    if ((i + 1) % 5 === 0 && gi < ghCards.length) merged.push(ghCards[gi++]);
  });
  while (gi < ghCards.length) merged.push(ghCards[gi++]);

  const out = {
    generatedAt: new Date().toISOString(),
    count: merged.length,
    cards: merged,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`wrote ${merged.length} cards → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
