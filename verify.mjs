/**
 * 离线验证：不联网、stub 掉 fetch，检查 token 是从哪一层解析出来的。
 *
 *   node verify.mjs
 *
 * 覆盖四个场景：
 *   1. DSH 凭证库可用 → 命中 OPENCODE_GO_API_KEY（模拟真实 DSH 进程）
 *   2. 凭证库不可用 → 直读 ~/.dsh/.credentials.yaml（flow map 写法）
 *   3. 同上，但用 block 缩进写法
 *   4. 什么都没有 → 503，且 tried 里写明问过哪些 ref
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOD = new URL("./lib/index.js", import.meta.url).href;

/** 捕获 apply() 注册的路由 */
function captureRoute(ctx, config = {}) {
  let route = null;
  const mod = { webServer: { register: (r) => { route = r; } } };
  return import(`${MOD}?t=${Math.random()}`).then((m) => {
    m.apply({ ...mod, ...ctx }, config);
    return route;
  });
}

/** 造一个假 res，收集 status/body */
function fakeRes() {
  const out = { code: 0, body: null };
  out.writeHead = (code) => { out.code = code; };
  out.end = (text) => { try { out.body = JSON.parse(text); } catch { out.body = text; } };
  return out;
}

/** stub fetch，把 Authorization 记下来 */
let lastAuth = "";
global.fetch = async (url, opts) => {
  lastAuth = opts?.headers?.Authorization || "";
  return {
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { percent: 12, status: "ok", resetsAt: new Date(Date.now() + 3600e3).toISOString() },
        weekly: { percent: 34, status: "ok", resetsAt: new Date(Date.now() + 86400e3).toISOString() },
        monthly: { percent: 56, status: "ok", resetsAt: null },
      },
    }),
  };
};

const KEY = "oc_sk_verify_1234567890";

function line(s = "") { console.log(s); }

async function run() {
  // ── 场景 1：凭证库可用 ──
  const credCtx = {
    logger: { warn() {} },
    get(name) {
      if (name === "credentials") {
        return {
          resolve: async (ref) =>
            ref === "OPENCODE_GO_API_KEY" ? { value: KEY, source: "file" } : null,
        };
      }
      return undefined;
    },
  };
  let route = await captureRoute(credCtx);
  let res = fakeRes();
  await route.handler({ method: "GET" }, res);
  line(`[1] 凭证库可用  HTTP ${res.code}  source=${res.body?.source}`);
  line(`    AUTH=${lastAuth}  len=${lastAuth.replace("Bearer ", "").length}`);
  const ok1 = res.code === 200 && lastAuth === `Bearer ${KEY}` && String(res.body?.source).includes("dsh credentials");

  // ── 场景 2/3：凭证库不可用 → 直读 ~/.dsh/.credentials.yaml ──
  const home = mkdtempSync(join(tmpdir(), "dsh-verify-"));
  process.env.DSH_HOME = home;
  mkdirSync(home, { recursive: true });

  const cases = [
    ["flow map", `version: 1\nrefs: { OPENCODE_GO_API_KEY: ${KEY} }\n`],
    ["block", `version: 1\nrefs:\n  OPENCODE_GO_API_KEY: ${KEY}\n  OTHER: x\n`],
  ];
  const results = [];
  for (const [label, yaml] of cases) {
    writeFileSync(join(home, ".credentials.yaml"), yaml);
    route = await captureRoute({ logger: { warn() {} }, get: () => undefined });
    res = fakeRes();
    await route.handler({ method: "GET" }, res);
    const ok = res.code === 200 && lastAuth === `Bearer ${KEY}` && String(res.body?.source).includes("credentials.yaml");
    results.push(ok);
    line(`[${label}] HTTP ${res.code}  source=${res.body?.source}`);
  }

  // ── 场景 4：什么都没有 ──
  writeFileSync(join(home, ".credentials.yaml"), "version: 1\nrefs: {}\n");
  route = await captureRoute({ logger: { warn() {} }, get: () => undefined });
  res = fakeRes();
  await route.handler({ method: "GET" }, res);
  const body = res.body || {};
  const ok4 = res.code === 503 && String(body.error).includes("OPENCODE_GO_API_KEY");
  line(`[4] 无凭证  HTTP ${res.code}`);
  line(`    error=${String(body.error).slice(0, 160)}`);

  const allOk = ok1 && results.every(Boolean) && ok4;
  line("");
  line(allOk ? "✅ 全部通过" : "❌ 有用例失败");
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => { console.error("验证脚本异常:", e); process.exit(1); });
