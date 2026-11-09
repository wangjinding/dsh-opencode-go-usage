/**
 * dsh-opencode-usage — OpenCode Go 套餐用量查看（服务端）。
 *
 * 两个出口：
 *   ① GET /plugin/opencode-usage —— 给设置页卡片用（同源，免鉴权，只依赖 DSH 自身的
 *      loopback ∪ trustedHost 网络栅栏；前端拿到的是三条百分比，不含任何凭证）。
 *   ② opencode_usage 工具 —— 让 agent 也能查（用户直接问「opencode 用了多少」）。
 *
 * 数据源：直连 https://opencode.ai/zen/go/v1/usage（Bearer + UA），不依赖任何中间服务。
 *   凭证按 apiKey → envFile 里的 OPENCODE_API_KEY → 进程环境变量 的顺序找，
 *   找到就用；一个都没有时接口回 503 并把三条搜索路径写清楚，方便排查。
 *
 * 缓存：默认 15 秒。用量是分钟级刷新的指标，没必要每次点开都打一次上游；
 *   但也不能太长 —— 用户点「刷新」时期待看到变化，15s 是「连点不重复打」和
 *   「刷新能看到新数」之间的折中。
 */
import { createRequire } from "node:module";
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const name = "opencode-usage";

/** 只依赖两个 seam：注册 HTTP 路由 + 注册工具。 */
export const inject = ["webServer", "tools"];

const DEFAULTS = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  /** 可选的 .env 文件路径（形如 KEY=VALUE 逐行）。默认不读文件，只认 config.apiKey 与环境变量；
   *  想从某个 .env 里取 key，用 config.envFile 指向它，或把 key 直接放进环境变量。 */
  envFile: "",
  /** 从 envFile / 进程环境里找的变量名。 */
  envKey: "OPENCODE_API_KEY",
  cacheSeconds: 15,
  timeoutMs: 12000,
  userAgent: "dsh-opencode-usage/0.1.0",
};

/* ── defineTool：从运行中的 dsh 安装里解析 ────────────────────────────────
 * 插件装在 ~/.dsh/profiles/web/local/ 下，模块解析链上找不到 @deepseek-ai/dsh-tools
 * （它只在 dsh 自己的 node_modules 里）。所以拿 dsh 进程的入口做 realpath，
 * 用它的真实位置建 createRequire，就能解析到 dsh 依赖树里的所有 @deepseek-ai 包。
 * 失败时返回 undefined，调用方降级成「只有 HTTP 路由、没有工具」。 */
function loadDefineTool() {
  const entry = process.argv[1];
  const candidates = [];
  if (entry) {
    candidates.push(entry);
    try { candidates.push(realpathSync(entry)); } catch { /* 入口不存在就算了 */ }
  }
  for (const c of candidates) {
    try {
      const req = createRequire(`file://${c}`);
      const mod = req("@deepseek-ai/dsh-tools");
      if (mod?.defineTool) return mod.defineTool;
    } catch { /* 换下一条 */ }
  }
  return undefined;
}

/** 读配置：兼容 cordis 的 Ref 包装（`.get()`）与裸对象。 */
function cfgOf(config) {
  if (!config) return {};
  if (typeof config.get === "function") {
    try { return config.get() ?? {}; } catch { return {}; }
  }
  return config;
}

/** 按 apiKey → envFile → 环境变量 的顺序找 token；返回 {token, from}。 */
function resolveToken(cfg) {
  if (cfg.apiKey && String(cfg.apiKey).trim()) {
    return { token: String(cfg.apiKey).trim(), from: "config.apiKey" };
  }
  const envFile = cfg.envFile || DEFAULTS.envFile;
  try {
    if (existsSync(envFile)) {
      const want = cfg.envKey || DEFAULTS.envKey;
      for (const line of readFileSync(envFile, "utf8").split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || m[1] !== want) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (v) return { token: v, from: envFile };
      }
    }
  } catch { /* 读不到就往下试 */ }
  const env = process.env[cfg.envKey || DEFAULTS.envKey];
  if (env && String(env).trim()) return { token: String(env).trim(), from: "env" };
  return { token: "", from: "" };
}

/** 把上游的 {usage:{rolling,weekly,monthly}} 归一化，并补上便于展示的字段。 */
function normalize(raw) {
  const usage = raw?.usage ?? raw ?? {};
  const order = [
    ["rolling", "滚动窗口"],
    ["weekly", "本周"],
    ["monthly", "本月"],
  ];
  const buckets = [];
  for (const [key, label] of order) {
    const b = usage[key];
    if (!b || typeof b !== "object") continue;
    const percent = Number(b.percent);
    buckets.push({
      key,
      label,
      status: typeof b.status === "string" ? b.status : "unknown",
      percent: Number.isFinite(percent) ? percent : null,
      resetsAt: typeof b.resetsAt === "string" ? b.resetsAt : null,
      resetInSeconds: resetIn(b.resetsAt),
    });
  }
  return buckets;
}

/** 距离重置还有多少秒；解析不了返回 null。 */
function resetIn(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 1000));
}

/** 拉上游用量。命中缓存直接返回，失败抛带 code 的错误。 */
async function fetchUsage(cfg, cache) {
  const now = Date.now();
  const ttl = Math.max(0, Number(cfg.cacheSeconds ?? DEFAULTS.cacheSeconds)) * 1000;
  if (cache.data && now - cache.at < ttl) {
    return { ...cache.data, cached: true };
  }

  const { token, from } = resolveToken(cfg);
  if (!token) {
    const tried = ["config.apiKey"];
    if (cfg.envFile) tried.push(`${cfg.envFile} 里的 ${cfg.envKey || DEFAULTS.envKey}`);
    tried.push(`环境变量 ${cfg.envKey || DEFAULTS.envKey}`);
    const err = new Error(`OpenCode Go 未配置 API Key（已尝试：${tried.join("、")}）`);
    err.code = "NO_TOKEN";
    throw err;
  }

  const base = String(cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(cfg.timeoutMs ?? DEFAULTS.timeoutMs));
  let resp;
  try {
    resp = await fetch(`${base}/usage`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": cfg.userAgent || DEFAULTS.userAgent,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = new Error(
      e?.name === "AbortError" ? "查询 OpenCode Go 用量超时" : `查询 OpenCode Go 用量失败：${e?.message || e}`,
    );
    err.code = "UPSTREAM";
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const err = new Error(`OpenCode Go 用量接口返回 HTTP ${resp.status}`);
    err.code = "UPSTREAM";
    err.status = resp.status;
    throw err;
  }
  const raw = await resp.json();
  const data = {
    fetchedAt: Math.floor(now / 1000),
    source: from,
    buckets: normalize(raw),
    raw,
  };
  cache.at = now;
  cache.data = data;
  return { ...data, cached: false };
}

/** 把桶数组渲染成一段人类可读文本（工具返回 / 命令行调试都用它）。 */
function renderText(data) {
  if (!data?.buckets?.length) return "（上游没有返回任何用量分桶）";
  const lines = [];
  for (const b of data.buckets) {
    const pct = b.percent === null ? "—" : `${b.percent}%`;
    const reset = b.resetInSeconds === null ? "" : `，${formatDuration(b.resetInSeconds)}后重置`;
    lines.push(`${b.label}：${pct}${reset}`);
  }
  return lines.join("\n");
}

function formatDuration(sec) {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.max(1, Math.floor(sec / 60))} 分钟`;
}

export function apply(ctx, config) {
  const cache = { at: 0, data: null };
  const cfgNow = () => ({ ...DEFAULTS, ...cfgOf(config) });

  /* ① HTTP 路由：给设置页卡片用 */
  ctx.webServer.register({
    kind: "exact",
    path: "/plugin/opencode-usage",
    async handler(req, res) {
      const respond = (code, body) => {
        const text = JSON.stringify(body);
        res.writeHead(code, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.method !== "GET" && req.method !== "HEAD") {
        respond(405, { ok: false, error: "只支持 GET" });
        return;
      }
      try {
        const data = await fetchUsage(cfgNow(), cache);
        respond(200, { ok: true, ...data });
      } catch (e) {
        const code = e?.code === "NO_TOKEN" ? 503 : 502;
        ctx.logger?.warn?.("opencode-usage: 查询失败 %s", e?.message || e);
        respond(code, { ok: false, error: String(e?.message || e), code: e?.code || "UNKNOWN" });
      }
    },
  });

  /* ② 工具：让 agent 也能查 */
  const defineTool = loadDefineTool();
  if (!defineTool) {
    ctx.logger?.warn?.("opencode-usage: 未能解析 @deepseek-ai/dsh-tools，跳过工具注册（HTTP 路由仍可用）");
    return;
  }
  ctx.tools.register(defineTool({
    name: "opencode_usage",
    description:
      "查询 OpenCode Go 套餐的用量（滚动窗口 / 本周 / 本月三条配额的已用百分比与重置时间）。直连 opencode.ai，不依赖任何中间服务。",
    parameters: {},
    // 注意：dsh-tools 的 value schema DSL 是**受约束子集**，不吃 `required: [...]`
    //   数组（会抛 JsonSchemaError: schema.required is not supported），也不吃
    //   `type: ["number","null"]` 这种 union。所以这里只用纯类型，
    //   未知值用哨兵表示：percent = -1、resetsAt = ""、resetInSeconds = -1。
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", description: "人类可读的用量摘要，直接可以回复给用户" },
          fetchedAt: { type: "integer", description: "数据抓取时间（epoch 秒）" },
          buckets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                status: { type: "string" },
                percent: { type: "number", description: "-1 表示上游没给百分比" },
                resetsAt: { type: "string", description: "ISO 时间；空串表示未知" },
                resetInSeconds: { type: "integer", description: "-1 表示未知" },
              },
            },
          },
        },
      },
      render: (value) => [{ type: "text", text: value?.summary || "" }],
    },
    async execute() {
      const data = await fetchUsage(cfgNow(), cache);
      const summary = renderText(data);
      return {
        summary: `OpenCode Go 用量（${new Date((data.fetchedAt || 0) * 1000).toLocaleString("zh-CN")} 抓取）：\n${summary}`,
        fetchedAt: data.fetchedAt || 0,
        // 与上面的 schema 对齐：null → 哨兵，避免结构化输出校验失败
        buckets: (data.buckets || []).map((b) => ({
          key: b.key,
          label: b.label,
          status: b.status || "unknown",
          percent: b.percent === null || b.percent === undefined ? -1 : b.percent,
          resetsAt: b.resetsAt || "",
          resetInSeconds: b.resetInSeconds === null || b.resetInSeconds === undefined ? -1 : b.resetInSeconds,
        })),
      };
    },
  }));

  ctx.logger?.info?.("opencode-usage: 已注册 /plugin/opencode-usage 与 opencode_usage 工具");
}
