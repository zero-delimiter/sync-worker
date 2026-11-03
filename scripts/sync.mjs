const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ENTRY =
  /<p class="name"><a href="\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a><\/p>\s*(?:<p class="ename"><a[^>]*>([\s\S]*?)<\/a><\/p>)?/g;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== "#") {
      return ENTITIES[code.toLowerCase()] ?? whole;
    }
    const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}

function clean(text) {
  return decode(text.replace(/<[^>]+>/g, ""))
    .replace(/[\s\u00a0]+/g, " ")
    .trim();
}

function parseList(html) {
  const mods = [];
  for (const match of html.matchAll(ENTRY)) {
    let name = clean(match[2]);
    let en = clean(match[3] ?? "");
    let abbr = "";
    const short = name.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (short) {
      abbr = short[1].trim();
      name = short[2].trim();
    }
    const zh = HAN.test(name) ? name : "";
    if (!zh && !en) {
      en = name;
    }
    mods.push({ id: Number(match[1]), zh, en, abbr });
  }
  const pages = html.match(/当前\s*\d+\s*\/\s*(\d+)\s*页/);
  return { mods, pages: pages ? Number(pages[1]) : 0 };
}

const POST_EVERY = 10;

function number(value, fallback) {
  const parsed = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const API = (process.env.API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.API_TOKEN;
const SOURCE_URL = process.env.SOURCE_URL;
const USER_AGENT = process.env.USER_AGENT;
const HEAD_PAGES = number(process.env.HEAD_PAGES, 2);
const FILL_PAGES = number(process.env.FILL_PAGES, 2000);
const SWEEP_PAGES = number(process.env.SWEEP_PAGES, 20);
const DELAY_MS = number(process.env.DELAY_MS, 1000);

async function api(path, body) {
  const response = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path} 返回 HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

let requests = 0;

async function list(params) {
  if (requests++ > 0) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  const url = new URL(SOURCE_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "zh-CN,zh;q=0.9" },
  });
  const html = await response.text();
  if (!response.ok) {
    const body = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw new Error(`${url.search} 返回 HTTP ${response.status}：${body}`);
  }
  const parsed = parseList(html);
  if (parsed.mods.length === 0) {
    throw new Error(`${url.search} 没有解析到模组`);
  }
  return parsed;
}

async function main() {
  const missing = Object.entries({ API_URL: API, API_TOKEN: TOKEN, SOURCE_URL, USER_AGENT })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join("、")}`);
  }
  const state = await api("/v1/ingest/state");
  let cursor = Math.max(1, state.cursor || 1);
  let pages = state.pages || 0;
  let filled = state.filled;
  const budget = filled ? SWEEP_PAGES : FILL_PAGES;
  const pending = new Map();
  let received = 0;
  let changed = 0;
  let visited = 0;
  let error = "";

  const flush = async (extra) => {
    const mods = [...pending.values()];
    pending.clear();
    const result = await api("/v1/ingest", { mods, state: { cursor, pages, filled, ...extra } });
    changed += result.changed;
  };
  const take = async (params) => {
    const parsed = await list(params);
    for (const mod of parsed.mods) {
      pending.set(mod.id, mod);
    }
    received += parsed.mods.length;
    visited++;
    if (visited % POST_EVERY === 0) {
      await flush({});
    }
    return parsed;
  };

  try {
    for (let page = 1; page <= HEAD_PAGES; page++) {
      await take({ sort: "lastedittime", page });
    }
    await take({ sort: "createtime", page: 1 });
    for (let i = 0; i < budget; i++) {
      const parsed = await take({ sort: "createtime", page: cursor });
      pages = parsed.pages || pages;
      cursor++;
      if (pages > 0 && cursor > pages) {
        cursor = 1;
        filled = true;
        break;
      }
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }

  await flush({ lastRun: new Date().toISOString(), lastError: error });
  await api("/v1/ingest", { mods: [], state: { lastChanged: changed } });
  console.log(`抓取 ${visited} 页，解析 ${received} 项，写入 ${changed} 项，下次从第 ${cursor}/${pages} 页继续`);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main().catch((failure) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
