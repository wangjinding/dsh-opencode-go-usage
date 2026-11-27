# dsh-opencode-usage

在 DSH 左侧栏看 OpenCode Go 套餐用量：滚动窗口 / 本周 / 本月 三条配额的已用百分比与重置倒计时。

服务端直连 `https://opencode.ai/zen/go/v1/usage`，API Key 不经过浏览器。

![位置](https://img.shields.io/badge/%E4%BD%8D%E7%BD%AE-%E5%B7%A6%E4%BE%A7%E6%A0%8F%E5%BA%95%E9%83%A8-16a34a)

## 功能

| 能力 | 说明 |
|---|---|
| **左侧栏卡片** | 三条配额的百分比、进度条、重置倒计时；标题旁显示本月重置日 |
| **刷新按钮** | SVG 圆形箭头，加载时旋转；**手动刷新**（不自动轮询） |
| **颜色分档** | `<70%` 绿 / `70–89%` 橙 / `≥90%` 红 |
| **`opencode_usage` 工具** | 让 agent 也能查（「opencode 用了多少」）|
| **`GET /plugin/opencode-usage`** | JSON 接口，15 秒缓存 |

返回结构：

```json
{
  "ok": true,
  "fetchedAt": 1794204531,
  "source": "config.apiKey",
  "buckets": [
    { "key": "rolling", "label": "滚动窗口", "status": "ok", "percent": 2,
      "resetsAt": "2026-11-09T11:01:12.000Z", "resetInSeconds": 17539 }
  ],
  "cached": false
}
```

## 安装

```bash
cd ~/.dsh/profiles/<你的 profile>
pnpm add file:/path/to/dsh-opencode-usage
```

然后在 profile 的 `dsh.profile.bundles` 里加上 `dsh-opencode-usage`，重启 DSH。

## 配置凭证

七级查找，从上到下第一个命中即用（参考名默认 **`OPENCODE_GO_API_KEY`**，旧名 `OPENCODE_API_KEY` 作兜底）：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `config.apiKey` | 显式配置，优先级最高 |
| 2 | `config.envFile` 指向的 `.env` | 文件里的 `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` |
| 3 | **DSH 凭证库** `ctx.credentials.resolve(ref)` | **推荐**：provider 用的 key 就存在这里，`~/.dsh/.credentials.yaml` 的 `refs:` 段 |
| 4 | DSH 的 launchEnvironment | DSH 启动时读的 `.env` 层（process / project-env / user-env） |
| 5 | 进程环境变量 | `OPENCODE_GO_API_KEY` → `OPENCODE_API_KEY` |
| 6 | **自动发现** | 见下 |
| 7 | 直读 `<DSH_HOME>/.credentials.yaml` | 凭证库服务不可用时的兜底（flow map 与缩进块两种 YAML 都认） |

> ⚠️ **为什么第 3 级最关键**：DSH 的 credential store **从不把值物化进 `process.env`**，
> 也不会写进 `.env` 层。所以「provider 能用、插件读不到」时，几乎都是漏了这一层。
> 1.0.7 之前的版本只查到第 5 级，Windows 上尤其明显（没有 `HOME`，`dshHomeDir()` 也拿不到路径）。

### 自动发现（默认开启）

第 1–4 级全落空时，插件自己去找，范围是**有界**的：

| 顺序 | 位置 |
|---|---|
| 1 | `$DSH_HOME/.env`（通常 `~/.dsh/.env`） |
| 2 | DSH 启动目录的 `.env` |
| 3 | 每个 DSH 工作空间根目录下的 `.env`（工作空间来自 `$DSH_HOME/storages/workspace.json`） |
| 4 | 工作空间内递归查找 `.env*`，深度 ≤ 4，跳过 `node_modules` / `.git` / `.pnpm` / `dist` / `build` / `target` / `.venv` 等，最多 400 个 |

只读文件名匹配 `.env*` 的文件，按 `OPENCODE_GO_API_KEY` → `OPENCODE_API_KEY` 取第一行命中；值不写日志、不进接口响应（响应里只有百分比和 `source` 路径）。
想关掉：`config.autoDiscover: false`。

写在**你自己 profile 的** `cordis.patch.yml`（不要改本包）：

```yaml
- id: opencode-usage
  config:
    apiKey: oc_sk_xxx
```

或者从 `.env` 文件读：

```yaml
- id: opencode-usage
  config:
    envFile: /path/to/.env
```

### 其他可选配置

```yaml
- id: opencode-usage
  config:
    baseUrl: https://opencode.ai/zen/go/v1   # 上游地址
    cacheSeconds: 15                          # 缓存秒数
    timeoutMs: 12000                          # 单次请求超时
    envKey: OPENCODE_GO_API_KEY               # 参考名（旧名 OPENCODE_API_KEY 自动兜底）
    autoDiscover: true                        # 是否自动发现 .env（默认 true）
```

## 实现要点

- **纯 JS，无需构建**：客户端通过 `window.__ModuleLoader__.load()` 注册，服务端是标准 ESM `apply(ctx, config)`。
- **凭证不落浏览器**：前端只拿到三条百分比，Bearer 只在服务端拼。
- **`defineTool` 动态解析**：插件装在 profile 的 `local/` 下，模块解析链上找不到 `@deepseek-ai/dsh-tools`，
  所以用 `realpath(argv[1])` 建 `createRequire`，从 DSH 自己的依赖树里取。
- **value schema DSL 有约束**：不吃 `required: [...]` 数组、不吃 `type: ["number","null"]` 这类 union、
  `additionalProperties` 必须显式。所以未知值用哨兵（`-1` / `""`）。

## 隐私

本包**不含任何凭证、个人路径或主机名**。凭证只在你自己的 profile 配置或环境变量里。

## License

MIT

## 本地验证（不联网）

仓库里带了一个离线验证脚本：stub 掉 `fetch`，只看 token 是从哪一层解析出来的。

```bash
node verify.mjs
# 或
npm run verify
```

覆盖四个场景：DSH 凭证库命中、`~/.dsh/.credentials.yaml` 的 flow map 写法、
缩进块写法、以及完全没有凭证时的报错文案。
