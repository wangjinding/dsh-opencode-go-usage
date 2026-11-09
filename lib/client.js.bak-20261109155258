// dsh-opencode-usage — 左侧栏「OpenCode Go 用量」卡片。
//
// 只注册一个位置：sidebar.footer.action（DSH 渲染在 .footerActions 里，位于左侧栏底部）。
// 设置页不再有对应分区 —— 用量这类"随时瞟一眼"的指标放在侧栏比埋进设置页直观得多。
//
// window.__ModuleLoader__.load 是 DSH 客户端的插件注册入口（纯 JS，不需要构建）：
//   factory(require) 里 require("react") 拿到的就是宿主那份 React，所以插件
//   不会引入第二份 React 实例（否则 hooks 会报 invalid hook call）。
//
// 数据从 /plugin/opencode-usage 取 —— 同源、由本插件的服务端代理上游，
// 既避开了浏览器直连 opencode.ai 的 CORS，也不把 API Key 暴露给页面。
window.__ModuleLoader__.load({
  id: "dsh-opencode-usage",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const h = react.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = react;

    const PLUGIN_NAME = "dsh-opencode-usage";
    /** 左侧栏底部 actions 区（DSH 的 .footerActions 容器）。 */
    const SLOT_SIDEBAR_FOOTER = "sidebar.footer.action";
    const ENDPOINT = "/plugin/opencode-usage";

    const PLUGIN_CSS = `
.ocu-card {
  display: flex; flex-direction: column; gap: 9px;
  width: 100%; min-width: 0; padding: 10px 10px 9px;
  border-radius: 10px;
  border: 1px solid rgba(127,127,127,.20);
  background: rgba(127,127,127,.06);
  box-sizing: border-box;
}
.ocu-head { display: flex; align-items: center; gap: 6px; }
.ocu-title { font-size: 11.5px; font-weight: 600; opacity: .85; letter-spacing: .2px; }
.ocu-head-spacer { flex: 1; }
.ocu-refresh {
  display: inline-flex; align-items: center; justify-content: center;
  width: 21px; height: 21px; padding: 0; flex: none;
  border: 1px solid rgba(127,127,127,.26); border-radius: 6px;
  background: transparent; color: inherit; cursor: pointer;
  opacity: .70;
  transition: opacity .15s, background .15s, border-color .15s;
}
.ocu-refresh:hover:not(:disabled) { opacity: 1; background: rgba(127,127,127,.14); border-color: rgba(127,127,127,.5); }
.ocu-refresh:disabled { cursor: default; opacity: .72; }
/* 加载态：图标本体常驻（不再换成文字），只有旋转；
   按钮整体不降透明度，避免"变灰=不可用"和"正在转=正在刷新"两种语义打架。 */
.ocu-refresh.is-loading { border-color: rgba(127,127,127,.45); background: rgba(127,127,127,.10); opacity: 1; }
.ocu-spin { display: block; transform-origin: 50% 50%; }
.ocu-spin.is-spinning { animation: ocu-spin .75s linear infinite; }
@keyframes ocu-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
/* 标题右侧的月份重置标记 */
.ocu-month {
  font-size: 9.5px; opacity: .45; white-space: nowrap;
  font-variant-numeric: tabular-nums; margin-left: 2px;
}

.ocu-bucket { display: flex; flex-direction: column; gap: 3px; }
/* 一行放下「名字 + 倒计时 + 百分比」：倒计时占中间剩余空间，超长用省略号，
   这样每个分桶只要 2 行（标题行 + 进度条），比原来 3 行紧凑。 */
.ocu-row { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.ocu-label { font-size: 11px; opacity: .62; flex: none; }
.ocu-pct { margin-left: auto; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.2px; flex: none; }
.ocu-pct.ok { color: #16a34a; }
.ocu-pct.warn { color: #d97706; }
.ocu-pct.hot { color: #dc2626; }
.ocu-track { position: relative; height: 5px; border-radius: 999px; background: rgba(127,127,127,.22); overflow: hidden; }
.ocu-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; transition: width .35s ease; }
.ocu-fill.ok { background: #16a34a; }
.ocu-fill.warn { background: #d97706; }
.ocu-fill.hot { background: #dc2626; }
.ocu-fill.unknown { background: rgba(127,127,127,.5); }
.ocu-reset {
  font-size: 10px; opacity: .5; font-variant-numeric: tabular-nums;
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.ocu-foot {
  display: flex; align-items: center; gap: 5px;
  padding-top: 2px; font-size: 9.5px; opacity: .42;
  font-variant-numeric: tabular-nums;
}
.ocu-err {
  font-size: 10.5px; line-height: 1.55; color: #b91c1c;
  word-break: break-all;
}
.ocu-dim { font-size: 10.5px; opacity: .55; }
@media (prefers-color-scheme: dark) {
  .ocu-err { color: #fca5a5; }
}
`;

    /** 百分比 → 颜色档位：<70 绿、70-89 橙、>=90 红。 */
    function tier(pct) {
      if (pct === null || pct === undefined) return "unknown";
      if (pct >= 90) return "hot";
      if (pct >= 70) return "warn";
      return "ok";
    }

    /** 秒 → 紧凑的"还剩多久"（侧栏窄，尽量用最短写法）。 */
    function humanDuration(sec) {
      if (sec === null || sec === undefined || sec < 0) return "";
      if (sec >= 86400) {
        const d = Math.floor(sec / 86400);
        const hr = Math.floor((sec % 86400) / 3600);
        return hr > 0 ? `${d}天${hr}小时` : `${d}天`;
      }
      if (sec >= 3600) {
        const hr = Math.floor(sec / 3600);
        const mi = Math.floor((sec % 3600) / 60);
        return mi > 0 ? `${hr}小时${mi}分` : `${hr}小时`;
      }
      return `${Math.max(1, Math.floor(sec / 60))}分钟`;
    }

    function formatClock(epochSec) {
      if (!epochSec) return "";
      const d = new Date(epochSec * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    /** ISO 时间 → "MM-DD"（侧栏宽度有限，只保留月日）。 */
    function formatMonthDay(iso) {
      if (!iso) return "";
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return "";
      const d = new Date(t);
      const p = (n) => String(n).padStart(2, "0");
      return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    /** 标准 refresh 图标（圆弧 + 箭头）：静态是"可刷新"，加载态整体旋转。
     *  用 SVG 而不是 ↻ 字符，是因为字符在不同字体下大小/基线不一致，
     *  而且旋转一个字形会有轻微的抖动感。 */
    function RefreshIcon({ spinning }) {
      return h("svg", {
        className: `ocu-spin${spinning ? " is-spinning" : ""}`,
        viewBox: "0 0 24 24", width: 13, height: 13,
        fill: "none", stroke: "currentColor",
        strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
      },
        h("path", { d: "M20.5 12a8.5 8.5 0 1 1-2.49-6.01" }),
        h("path", { d: "M20.5 3.5v5.5h-5.5" }),
      );
    }

    /** 短标签：滚动 / 本周 / 本月；未知分桶回退到上游给的 label。 */
    function shortLabel(b) {
      if (b.key === "rolling") return "滚动";
      if (b.key === "weekly") return "本周";
      if (b.key === "monthly") return "本月";
      return b.label || b.key;
    }

    function SidebarCard() {
      const [state, setState] = useState({ loading: true, error: null, data: null });
      const [spinning, setSpinning] = useState(false);
      const aliveRef = useRef(true);

      const load = useCallback(async (manual) => {
        if (manual) setSpinning(true);
        try {
          const resp = await fetch(ENDPOINT, { headers: { Accept: "application/json" }, cache: "no-store" });
          const body = await resp.json().catch(() => ({}));
          if (!resp.ok || body.ok === false) {
            throw new Error(body.error || `接口返回 HTTP ${resp.status}`);
          }
          if (aliveRef.current) setState({ loading: false, error: null, data: body });
        } catch (e) {
          if (aliveRef.current) {
            setState({ loading: false, error: String(e && e.message ? e.message : e), data: null });
          }
        } finally {
          if (manual && aliveRef.current) setSpinning(false);
        }
      }, []);

      // 只在挂载时拉一次：用量不是秒级指标，自动轮询没意义，
      // 想看新数就点右上角的刷新按钮（手动触发，行为可预期）。
      useEffect(() => {
        aliveRef.current = true;
        load(true);
        return () => { aliveRef.current = false; };
      }, [load]);

      const onRefresh = useCallback((ev) => {
        if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
        load(true);
      }, [load]);

      const buckets = state.data && Array.isArray(state.data.buckets) ? state.data.buckets : [];

      // 月份重置日：从 monthly 分桶取（上游给的是 ISO 时间），侧栏只显示 MM-DD
      const monthly = buckets.find((b) => b.key === "monthly") || null;
      const monthReset = monthly ? formatMonthDay(monthly.resetsAt) : "";

      const head = h("div", { className: "ocu-head" },
        h("span", { className: "ocu-title" }, "OpenCode Go"),
        monthReset
          ? h("span", { className: "ocu-month", title: `本月额度 ${monthly.resetsAt} 重置` }, `${monthReset} 重置`)
          : null,
        h("span", { className: "ocu-head-spacer" }),
        h("button", {
          className: `ocu-refresh${spinning ? " is-loading" : ""}`,
          disabled: spinning,
          title: spinning ? "正在刷新…" : "刷新用量",
          onClick: onRefresh,
        }, h(RefreshIcon, { spinning })),
      );

      if (state.error) {
        return h("div", { className: "ocu-card" },
          head,
          h("div", { className: "ocu-err" }, state.error),
        );
      }

      const body = buckets.length
        ? buckets.map((b) => {
            const pct = typeof b.percent === "number" ? Math.max(0, Math.min(100, b.percent)) : null;
            const t = tier(pct);
            const left = humanDuration(b.resetInSeconds);
            return h("div", { className: "ocu-bucket", key: b.key },
              h("div", { className: "ocu-row" },
                h("span", { className: "ocu-label" }, shortLabel(b)),
                // 倒计时紧跟名字后面，只占一行的中间空隙；放不下时省略号收尾
                h("span", { className: "ocu-reset", title: left ? `${left}后重置` : "重置时间未知" },
                  left ? `${left}后重置` : "重置未知"),
                h("span", { className: `ocu-pct ${t}` }, pct === null ? "—" : `${pct}%`),
              ),
              h("div", { className: "ocu-track" },
                h("div", { className: `ocu-fill ${t}`, style: { width: `${pct === null ? 0 : pct}%` } }),
              ),
            );
          })
        : [h("div", { className: "ocu-dim", key: "empty" }, state.loading ? "读取中…" : "上游未返回用量数据")];

      // 底栏只留抓取时间：实时/缓存这个提示对使用者没有决策价值
      // （要不要重拉是自动+手动刷新决定的事），去掉后底栏更干净。
      const foot = h("div", { className: "ocu-foot" },
        h("span", null, state.data ? `${formatClock(state.data.fetchedAt)} 更新` : ""),
      );

      return h("div", { className: "ocu-card" }, head, ...body, foot);
    }

    const injectList = ["slots"];

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = PLUGIN_NAME;
        style.textContent = PLUGIN_CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, `${PLUGIN_NAME}: styles`);

      // 唯一出口：左侧栏底部
      ctx.slots.inject(SLOT_SIDEBAR_FOOTER, () => {
        return ctx.slots.register({
          name: SLOT_SIDEBAR_FOOTER,
          id: "opencode-usage-footer",
          order: 20,
        }, () => h(SidebarCard));
      });
    }

    exports.apply = apply;
    exports.inject = injectList;
    exports.name = PLUGIN_NAME;

    return module.exports;
  },
});
