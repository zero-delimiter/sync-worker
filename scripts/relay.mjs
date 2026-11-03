const API = (process.env.API_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.API_TOKEN;
const USER_AGENT = process.env.USER_AGENT;
const BUDGET_MS = 40 * 60 * 1000;
const BATCH = 20;
const TIMEOUT_MS = 30_000;
const MAX_STREAK = 5;
const MAX_PAUSE_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, body) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  });
  if (!response.ok) {
    throw new Error(`${path} 返回 HTTP ${response.status}`);
  }
  return response.json();
}

async function download(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      body: await response.text(),
      retryAfter: Number(response.headers.get("retry-after")) || 0,
    };
  } catch {
    return { status: 0, type: "", body: "", retryAfter: 0 };
  }
}

function settled(status) {
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

async function main() {
  const missing = Object.entries({ API_URL: API, API_TOKEN: TOKEN, USER_AGENT })
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join("、")}`);
  }
  const started = Date.now();
  let done = 0;
  let failed = 0;
  let streak = 0;
  let pause = 0;
  let error = "";
  try {
    while (Date.now() - started < BUDGET_MS) {
      const plan = await api("/v1/ingest/next", { limit: BATCH });
      if (!Array.isArray(plan.jobs) || plan.jobs.length === 0) {
        break;
      }
      for (const job of plan.jobs) {
        if (Date.now() - started >= BUDGET_MS) {
          break;
        }
        if (done + failed > 0) {
          await sleep(pause);
        }
        const result = await download(job.url);
        await api("/v1/ingest/page", { key: job.key, status: result.status, type: result.type, body: result.body });
        if (settled(result.status)) {
          done++;
          streak = 0;
          pause = plan.delay;
        } else {
          failed++;
          streak++;
          pause = Math.min(MAX_PAUSE_MS, Math.max(plan.delay * 2 ** streak, result.retryAfter * 1000));
          if (streak >= MAX_STREAK) {
            throw new Error(`连续 ${streak} 次失败，最后一次 HTTP ${result.status}`);
          }
        }
      }
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  console.log(`完成 ${done} 项，失败 ${failed} 项，用时 ${Math.round((Date.now() - started) / 1000)} 秒`);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main().catch((failure) => {
  console.error(failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
