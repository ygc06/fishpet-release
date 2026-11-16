window.__ModuleLoader__.load({
  id: "@local/dsh-fishpet-emotion",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    var ENDPOINT = "/api/fishpet-emotion.dashboard";
    var POLL_MS = 5000;
    var DESKTOP_ZIP_URL = "https://github.com/ygc06/fishpet-release/releases/download/v2026.11.15/FishPet-2026.11.15-windows-x64.zip";
    var DESKTOP_ZIP_MIRROR_URL = "https://gh-proxy.com/https://github.com/ygc06/fishpet-release/releases/download/v2026.11.15/FishPet-2026.11.15-windows-x64.zip";
    var DESKTOP_ZIP_SHA256 = "21534B87FD388C33F9A9AA9139ACB00FA56980837432B6DCC3A774F225CBDEF4";
    var SETUP_DISMISSED_KEY = "dsh-fishpet-emotion:desktop-guide:v1";
    var listeners = new Set();
    var openState = false;

    function emit() {
      for (var listener of Array.from(listeners)) {
        try { listener(); } catch (_) {}
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }

    function getOpen() {
      return openState;
    }

    function setOpen(next) {
      var value = Boolean(next);
      if (openState === value) return;
      openState = value;
      emit();
    }

    function useOpen() {
      return React.useSyncExternalStore(subscribe, getOpen, getOpen);
    }

    function hasDismissedSetup() {
      try {
        return window.localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
      } catch (_) {
        return false;
      }
    }

    function markSetupDismissed() {
      try {
        window.localStorage.setItem(SETUP_DISMISSED_KEY, "1");
      } catch (_) {}
    }

    function SetupGuide() {
      var [visible, setVisible] = React.useState(function () {
        return !hasDismissedSetup();
      });

      function close() {
        setVisible(false);
        markSetupDismissed();
      }

      if (!visible) return null;
      return h(
        "div",
        {
          className: "dfe-setup-backdrop",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "dfe-setup-title",
        },
        h(
          "div",
          { className: "dfe-setup-card" },
          h("button", {
            type: "button",
            className: "dfe-setup-close",
            title: "关闭",
            "aria-label": "关闭安装提示",
            onClick: close,
          }, "×"),
          h("div", { className: "dfe-setup-badge", "aria-hidden": "true" }, "🐟"),
          h("div", { className: "dfe-setup-kicker" }, "DSH 插件已经安装好"),
          h("h2", { id: "dfe-setup-title" }, "还差桌面皮套这一步"),
          h("p", { className: "dfe-setup-copy" },
            "DSH 里装好的是情绪、陪伴和看板插件。她的人物模型、动作、语音和启动程序在完整 Windows 包里，需要再下载一次。国内网络优先用加速线路，打不开时再换 GitHub 原站。",
          ),
          h("ol", { className: "dfe-setup-steps" },
            h("li", null, "先点国内加速下载；没有反应就换 GitHub 原站"),
            h("li", null, "下载完成后完整解压约 253 MB 的桌宠包"),
            h("li", null, "打开桌宠目录，双击 启动大肥鱼.bat"),
          ),
          h("div", { className: "dfe-setup-actions" },
            h("a", {
              className: "dfe-setup-primary",
              href: DESKTOP_ZIP_MIRROR_URL,
              target: "_blank",
              rel: "noopener noreferrer",
              onClick: close,
              "aria-label": "从国内加速线路下载完整桌宠包",
            }, "⚡ 国内加速下载"),
            h("a", {
              className: "dfe-setup-direct",
              href: DESKTOP_ZIP_URL,
              target: "_blank",
              rel: "noopener noreferrer",
              onClick: close,
              "aria-label": "从 GitHub 原站下载完整桌宠包",
            }, "GitHub 原站"),
            h("button", {
              type: "button",
              className: "dfe-setup-later",
              onClick: close,
            }, "稍后下载"),
          ),
          h("p", { className: "dfe-setup-note" },
            "加速线路是第三方 GitHub 转发，速度会随网络变化。两个下载入口打开的是同一个 253 MB 文件。",
          ),
          h("div", { className: "dfe-setup-checksum" },
            h("span", null, "SHA-256"),
            h("code", null, DESKTOP_ZIP_SHA256),
            h("small", null, "下载后可核对，或查看同目录下的 .sha256 文件。"),
          ),
        ),
      );
    }

    function PluginDownloadSection(props) {
      var subject = obj(props && props.subject);
      var pkg = obj(subject.pkg);
      if (subject.kind !== "bundle" || pkg.name !== "@local/dsh-fishpet-emotion") return null;
      return h(
        "section",
        { className: "dfe-plugin-download", "aria-labelledby": "dfe-plugin-download-title" },
        h("div", { className: "dfe-plugin-download-head" },
          h("div", { className: "dfe-plugin-download-mark", "aria-hidden": "true" }, "🐟"),
          h("div", { className: "dfe-plugin-download-copy" },
            h("div", { className: "dfe-plugin-download-kicker" }, "完整桌面皮套"),
            h("h3", { id: "dfe-plugin-download-title" }, "下载 FishPet 完整版"),
            h("p", null,
              "这个插件负责情绪、聊天和看板。人物模型、动作、语音和桌面启动程序在完整 Windows 包里，点击下面的按钮即可下载。",
            ),
          ),
        ),
        h("div", { className: "dfe-plugin-download-actions" },
          h("a", {
            className: "dfe-plugin-download-primary",
            href: DESKTOP_ZIP_MIRROR_URL,
            target: "_blank",
            rel: "noopener noreferrer",
          }, "⚡ 下载完整版（国内加速）"),
          h("a", {
            className: "dfe-plugin-download-secondary",
            href: DESKTOP_ZIP_URL,
            target: "_blank",
            rel: "noopener noreferrer",
          }, "GitHub 原站"),
        ),
        h("p", { className: "dfe-plugin-download-note" },
          "文件约 253 MB，下载后完整解压并双击 启动大肥鱼.bat。加速线路打不开时换 GitHub 原站。",
        ),
        h("details", { className: "dfe-plugin-download-verify" },
          h("summary", null, "查看文件信息与 SHA-256"),
          h("code", null, DESKTOP_ZIP_SHA256),
        ),
      );
    }

    function cx() {
      return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
    }

    function arr(value) {
      return Array.isArray(value) ? value : [];
    }

    function obj(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function str(value) {
      return value == null ? "" : String(value);
    }

    function num(value, fallback) {
      var parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
    }

    function cny(value, symbol) {
      var parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) return "未采集";
      var digits = parsed > 0 && parsed < 0.01 ? 6 : 4;
      var fixed = parsed.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
      return (symbol || "¥") + fixed;
    }

    function roleCostText(role, label) {
      var value = obj(role);
      if ((value.status !== "estimated" && value.status !== "partial") || value.cost == null) {
        return label + " 未采集";
      }
      return label + " " + cny(value.cost, value.symbol);
    }

    function roleTokens(role) {
      var value = obj(role);
      var usage = obj(value.usage);
      var total = Number(usage.totalTokens);
      if (!Number.isFinite(total)) {
        total = num(usage.inputTokens) + num(usage.cacheReadTokens)
          + num(usage.cacheWriteTokens) + num(usage.outputTokens);
      }
      return Number.isFinite(total) && total > 0 ? total + " tok" : "";
    }

    function time(ms) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return "";
      return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }

    function dateTime(ms) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return "";
      return new Date(value).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }

    function secondsToMs(value) {
      var parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return 0;
      return parsed < 100000000000 ? parsed * 1000 : parsed;
    }

    function secondsTime(value) {
      return time(secondsToMs(value));
    }

    function secondsDateTime(value) {
      return dateTime(secondsToMs(value));
    }

    function age(ms, now) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return "";
      var delta = Math.max(0, Number(now || Date.now()) - value);
      var minutes = Math.floor(delta / 60000);
      if (minutes < 1) return "刚刚";
      if (minutes < 60) return minutes + " 分钟前";
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + " 小时前";
      return Math.floor(hours / 24) + " 天前";
    }

    function duration(fromMs, now) {
      var value = Number(fromMs);
      if (!Number.isFinite(value) || value <= 0) return "";
      var minutes = Math.max(1, Math.round((Number(now || Date.now()) - value) / 60000));
      if (minutes < 60) return minutes + " 分钟";
      var hours = Math.floor(minutes / 60);
      var rest = minutes % 60;
      return hours + " 小时" + (rest ? " " + rest + " 分" : "");
    }

    function percent(value, range) {
      var lo = Number(range && range[0]);
      var hi = Number(range && range[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) return 0;
      return Math.max(0, Math.min(100, ((Number(value) - lo) / (hi - lo)) * 100));
    }

    function roundWeight(round) {
      var delta = obj(round && round.delta);
      var keys = ["valence", "energy", "arousal", "dominance", "clinginess", "trust"];
      var heavy = 0;
      for (var key of keys) {
        if (delta[key] != null) heavy = Math.max(heavy, Math.abs(num(delta[key])));
      }
      if (!heavy) return { label: "几乎没动", tone: "muted" };
      if (heavy <= 3) return { label: "擦一下", tone: "ok" };
      if (heavy <= 7) return { label: "有点在意", tone: "ok" };
      if (heavy <= 12) return { label: "明显", tone: "warn" };
      if (heavy <= 18) return { label: "挺重", tone: "warn" };
      if (heavy <= 25) return { label: "很重", tone: "bad" };
      return { label: "极重", tone: "bad" };
    }

    async function loadDashboard(signal) {
      var response = await fetch(ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: signal,
      });
      var body = null;
      try { body = await response.json(); } catch (_) {}
      if (!response.ok || !body || body.ok !== true || !body.value) {
        var code = body && body.code ? body.code : "http_" + response.status;
        throw new Error(code);
      }
      return body.value;
    }

    function StatusDot(props) {
      return h("span", {
        className: cx("dfe-status-dot", props.tone ? "is-" + props.tone : ""),
        "aria-hidden": "true",
      });
    }

    function Empty(props) {
      return h("div", { className: "dfe-empty" }, props.children || "还没有记录");
    }

    function Section(props) {
      return h(
        "section",
        { className: cx("dfe-card", props.className) },
        props.title
          ? h(
            "div",
            { className: "dfe-card-head" },
            h("h3", null, props.title),
            props.meta ? h("span", null, props.meta) : null,
            props.action || null,
          )
          : null,
        props.children,
      );
    }

    function Chip(props) {
      return h("span", { className: cx("dfe-chip", props.className) }, props.children);
    }

    function KeyValue(props) {
      return h(
        "div",
        { className: "dfe-kv" },
        h("span", null, props.label),
        h("strong", { className: props.className }, props.value),
      );
    }

    function Quote(props) {
      return h(
        "div",
        { className: cx("dfe-quote", props.className) },
        props.label ? h("div", { className: "dfe-quote-label" }, props.label) : null,
        h("p", null, str(props.children) || "（没有留下内容）"),
      );
    }

    function MetaLine(props) {
      var bits = arr(props.items).filter(Boolean);
      if (!bits.length) return null;
      return h("div", { className: "dfe-meta-line" }, bits.map(function (item, index) {
        return h("span", { key: index }, item);
      }));
    }

    function TabButton(props) {
      return h(
        "button",
        {
          type: "button",
          className: cx("dfe-tab", props.active && "is-active"),
          onClick: props.onClick,
          role: "tab",
          "aria-selected": Boolean(props.active),
        },
        props.label,
        props.count ? h("span", { className: "dfe-tab-count" }, props.count) : null,
      );
    }

    function AxisBar(props) {
      var definition = obj(props.definition);
      var value = num(props.value);
      var position = percent(value, definition.range);
      var fillStyle;
      if (definition.center == null) {
        fillStyle = { left: "0%", width: position + "%" };
      } else {
        var center = percent(definition.center, definition.range);
        fillStyle = value >= definition.center
          ? { left: center + "%", width: Math.max(0, position - center) + "%" }
          : { left: position + "%", width: Math.max(0, center - position) + "%" };
      }
      return h(
        "div",
        { className: "dfe-axis-track" },
        definition.center != null
          ? h("i", { className: "dfe-axis-center", style: { left: percent(definition.center, definition.range) + "%" } })
          : null,
        h("i", { className: cx("dfe-axis-fill", "axis-" + definition.key), style: fillStyle }),
        h("b", { className: "dfe-axis-dot", style: { left: position + "%" } }),
      );
    }

    function AxisCard(props) {
      var axis = obj(props.axis);
      return h(
        "div",
        { className: "dfe-axis-card" },
        h("div", { className: "dfe-axis-top" },
          h("span", null, str(axis.name)),
          h("strong", null, str(axis.displayValue)),
        ),
        h("div", { className: "dfe-axis-label" }, str(axis.label)),
        h(AxisBar, { definition: axis, value: axis.value }),
        h("p", { className: "dfe-axis-note" }, str(axis.note || axis.description)),
      );
    }

    function FlowStep(props) {
      return h(
        "div",
        { className: cx("dfe-flow-step", props.tone && "is-" + props.tone) },
        h("div", { className: "dfe-flow-index" }, props.index),
        h(
          "div",
          { className: "dfe-flow-body" },
          h("h4", null, props.title),
          props.children,
        ),
      );
    }

    function RoundSummary(props) {
      var round = obj(props.round);
      var status = str(round.status);
      var tone = status === "ok" ? "ok" : status === "blocked" ? "warn" : status === "failed" ? "bad" : "muted";
      var weight = roundWeight(round);
      var label = status === "ok" ? "已判读 · 已落账"
        : status === "blocked" ? "被体力门槛挡住"
          : status === "failed" ? "判读失败"
            : status === "crisis" ? "安全线接管"
              : "旧状态快照";
      return h(
        "div",
        { className: "dfe-round-summary" },
        h(StatusDot, { tone: tone }),
        h("span", null, label),
        status === "ok" || status === "blocked" ? h(Chip, { className: weight.tone === "warn" ? "is-warn" : weight.tone === "bad" ? "is-down" : "is-good" }, "落得 " + weight.label) : null,
        round.attempts != null ? h("span", null, "调用 " + round.attempts + " 次") : null,
        round.at ? h("span", { className: "dfe-spacer" }) : null,
        round.at ? h("time", null, dateTime(round.at)) : null,
      );
    }

    function RoundCosts(props) {
      var round = obj(props.round);
      var costs = obj(round.modelCosts);
      var judge = obj(costs.judge);
      var reply = obj(costs.reply);
      var total = cny(costs.totalCny, costs.symbol);
      return h("div", { className: "dfe-cost-panel" },
        h("div", { className: "dfe-cost-line" },
          h("b", null, "小模型判读"),
          h("span", null,
            (judge.status === "estimated" || judge.status === "partial") && judge.cost != null
              ? cny(judge.cost, judge.symbol)
              : "未采集"),
          roleTokens(judge) ? h("small", null, roleTokens(judge)) : null,
          judge.reason ? h("em", { title: judge.reason }, judge.reason) : null,
        ),
        h("div", { className: "dfe-cost-line" },
          h("b", null, "大模型回复"),
          h("span", null,
            (reply.status === "estimated" || reply.status === "partial") && reply.cost != null
              ? cny(reply.cost, reply.symbol)
              : "未采集"),
          roleTokens(reply) ? h("small", null, roleTokens(reply)) : null,
          reply.reason ? h("em", { title: reply.reason }, reply.reason) : null,
        ),
        h("div", { className: "dfe-cost-total" },
          h("span", null, "本轮合计"),
          h("b", null, total),
          h("small", null, "按 DSH 当前价目估算"),
        ),
      );
    }

    function CalculationBlock(props) {
      var round = obj(props.round);
      var calc = obj(round.calculation);
      var proposed = obj(calc.proposedDelta);
      var before = obj(calc.before);
      var after = obj(calc.after);
      var burst = obj(calc.burst);
      var regulation = obj(calc.regulation);
      var names = { valence: "心情", energy: "精力", arousal: "唤醒", dominance: "底气", clingy: "黏人", clinginess: "黏人", trust: "信任" };
      var keys = ["valence", "energy", "arousal", "dominance", "clingy", "trust"];
      var rows = keys.filter(function (key) {
        return proposed[key] != null || before[key] != null || after[key] != null;
      });
      if (!rows.length && !burst.key && !regulation.strategy) return null;
      return h("details", { className: "dfe-inner-details" },
        h("summary", null, "怎么算的", h("span", null, "模型原值 / 落地值")),
        rows.length
          ? h("table", { className: "dfe-axis-table" },
            h("thead", null, h("tr", null,
              h("th", null, "数值"), h("th", null, "模型想加"), h("th", null, "原来"), h("th", null, "落地"),
            )),
            h("tbody", null, rows.map(function (key) {
              var p = proposed[key];
              var b = before[key];
              var a = after[key];
              return h("tr", { key: key },
                h("td", null, names[key]),
                h("td", { className: num(p) > 0 ? "is-up" : num(p) < 0 ? "is-down" : "" }, p == null ? "—" : (num(p) > 0 ? "+" : "") + num(p).toFixed(1)),
                h("td", null, b == null ? "—" : num(b).toFixed(1)),
                h("td", null, a == null ? "—" : num(a).toFixed(1)),
              );
            })),
          )
          : null,
        burst.key
          ? h("p", { className: "dfe-small" }, "爆发加值：" + (burst.key || "") + " " + (num(burst.delta) > 0 ? "+" : "") + num(burst.delta).toFixed(1) + (burst.why ? " · " + burst.why : ""))
          : null,
        regulation.strategy
          ? h("p", { className: "dfe-small" }, "情绪调节：" + regulation.strategy + (regulation.summary ? " · " + regulation.summary : ""))
          : null,
      );
    }

    function RoundFlow(props) {
      var round = obj(props.round);
      var data = obj(props.data);
      var feeling = obj(round.feeling);
      var action = obj(round.action);
      var event = obj(round.event);
      var episode = obj(round.episode);
      var judgement = obj(round.judgement);
      var judgementLast = obj(round.judgementLast);
      var beats = arr(round.beats);
      var words = arr(feeling.words);
      var mask = obj(round.mask);
      var surge = obj(round.surge);
      var sting = obj(round.sting);
      var status = str(round.status);

      var gate;
      if (status === "failed") {
        gate = h("p", { className: "dfe-muted" }, "这一轮没有完成判读：" + (round.errorCode || "未知原因") + "。系统没有补造观点或账本。");
      } else if (status === "crisis") {
        gate = h("p", { className: "dfe-muted" }, "安全线先接管了。这一轮不进入角色情绪、关系账本和慢判断。");
      } else if (status === "legacy") {
        gate = h("p", { className: "dfe-muted" }, "这是接入逐轮观测前的最后状态快照；门口和完整判读细节没有旧记录，不补造。");
      } else {
        gate = h("p", null, "新版情绪系统没有“值不值得判读”的分流：这一轮进入了判读。");
      }

      var heartBits = [];
      if (words.length) {
        heartBits.push(h("div", { className: "dfe-chip-row", key: "words" }, words.map(function (word, index) {
          return h(Chip, { key: index, className: "is-feeling" }, word);
        })));
      }
      if (feeling.carry) heartBits.push(h("p", { key: "carry", className: "dfe-small" }, "这股劲：" + (feeling.carry === "沿用" ? "还在沿着上一轮走" : feeling.carry === "变了" ? "被这一轮改掉了" : "已经空了")));
      if (feeling.letGo) heartBits.push(h("p", { key: "letgo", className: "dfe-small" }, "她放下的：" + feeling.letGo));
      if (!heartBits.length) heartBits.push(h("p", { key: "empty", className: "dfe-muted" }, "这一轮没有新增自由情绪词或跨轮余劲。"));

      var actionText;
      if (action.final) {
        actionText = h("div", null,
          h("div", { className: "dfe-action-final" }, h("b", null, action.final)),
          action.reason ? h("p", { className: "dfe-small" }, action.reason) : null,
          action.changed
            ? h("p", { className: "dfe-small is-warn" }, "模型本来想给「" + (action.proposed || "空") + "」，证据与门槛最后留下「" + action.final + "」。")
            : null,
        );
      } else {
        actionText = h("p", { className: "dfe-muted" }, "这一轮没有留下动作。");
      }

      var ledgerText;
      if (event.type) {
        var episodeLine;
        if (episode.logged) {
          episodeLine = "账本：记下了「" + (episode.type || event.type) + "」" +
            (episode.reopened ? "，这次是复燃" : "") +
            (episode.mentions > 1 ? "，前后提过 " + episode.mentions + " 次" : "");
        } else if (episode.why) {
          episodeLine = "账本：没记（" + episode.why + "）";
        } else {
          episodeLine = "账本：这一轮没有落账";
        }
        ledgerText = h("div", null,
          h("div", { className: "dfe-event-line" },
            h(Chip, { className: "is-event" }, event.type),
            event.label ? h(Chip, null, event.label) : null,
            event.who ? h(Chip, { className: "is-muted" }, "记成：" + event.who) : null,
            event.weight != null ? h(Chip, { className: "is-muted" }, "重量 " + num(event.weight).toFixed(0) + "/10") : null,
            event.unsolved ? h(Chip, { className: "is-warn" }, "还没过去") : null,
          ),
          event.what ? h("p", { className: "dfe-small" }, "她记下的是：" + event.what) : null,
          event.quote ? h(Quote, { label: "原话短摘", className: "is-neutral" }, event.quote) : h("p", { className: "dfe-muted" }, "没有逐字核对得到的原话；不补造摘句。"),
          h("p", { className: "dfe-small" }, episodeLine),
        );
      } else {
        ledgerText = h("p", { className: "dfe-muted" }, "这一轮没有形成事件账。");
      }

      var slow;
      if (judgement.text) {
        slow = h("div", null,
          h(Quote, { className: "is-warm" }, judgement.text),
          judgement.at ? h("p", { className: "dfe-small" }, "上次改：" + secondsDateTime(judgement.at)) : null,
          judgementLast.reason ? h("p", { className: "dfe-small" }, "这一轮" + (judgementLast.update ? "更新了：" : "没改：") + judgementLast.reason) : null,
        );
      } else {
        slow = h("p", { className: "dfe-muted" }, "她对他这个人的慢判断还没有形成。");
      }

      var signalBits = [];
      if (mask.kind) signalBits.push("嘴上：" + mask.kind + (mask.q ? "「" + mask.q + "」" : ""));
      if (surge.kind) signalBits.push("冲动：" + surge.kind + " Lv." + num(surge.level));
      if (sting.kind) signalBits.push("刺痛：" + sting.kind + " Lv." + num(sting.level));

      return h("div", { className: "dfe-flow" },
        h(FlowStep, { index: "01", title: "门口", tone: status === "failed" ? "bad" : null }, gate),
        h(FlowStep, { index: "02", title: "观察信号" },
          beats.length
            ? h("div", { className: "dfe-beats" }, beats.map(function (beat, index) {
              return h(Chip, { key: index, className: num(beat.v) > 0 ? "is-up" : "is-down" },
                (num(beat.v) > 0 ? "+" : "") + num(beat.v) + " · " + str(beat.q));
            }))
            : null,
          signalBits.length
            ? h("div", { className: "dfe-chip-row" }, signalBits.map(function (line, index) {
              return h(Chip, { key: index, className: "is-warn" }, line);
            }))
            : null,
          !beats.length && !signalBits.length
            ? h("p", { className: "dfe-muted" }, "这一轮没有额外的语义补丁；小模型只留下情绪轴、动作或事件。")
            : null,
        ),
        h(FlowStep, { index: "03", title: "情绪状态" }, heartBits),
        h(FlowStep, { index: "04", title: "这一轮要做什么", tone: action.changed ? "warn" : null }, actionText),
        h(FlowStep, { index: "05", title: "事件账" }, ledgerText),
        h(FlowStep, { index: "06", title: "她对他这个人的慢判断" }, slow),
        round.usage
          ? h(FlowStep, { index: "07", title: "这次判读的用量" },
            h("div", { className: "dfe-usage-line" },
              round.usage.calls != null ? "调用 " + round.usage.calls + " 次" : null,
              round.usage.inputTokens != null ? "输入 " + round.usage.inputTokens + " tok" : null,
              round.usage.outputTokens != null ? "输出 " + round.usage.outputTokens + " tok" : null,
            ),
            !round.usage.calls && round.usage.inputTokens == null
              ? h("p", { className: "dfe-muted" }, "调用方没有上报判读 token。")
              : null,
          )
          : null,
      );
    }

    function RoundCard(props) {
      var round = obj(props.round);
      var index = num(props.index);
      var userText = str(round.user);
      var reply = obj(round.reply);
      var costs = obj(round.modelCosts);
      var status = str(round.status);
      var badge = status === "ok" ? "判读" : status === "blocked" ? "挡住" : status === "failed" ? "失败" : status === "crisis" ? "安全线" : "旧快照";
      return h(
        "article",
        { className: "dfe-round" },
        userText ? h("div", { className: "dfe-message is-user" }, h("div", { className: "dfe-bubble" }, userText)) : null,
        reply.text ? h("div", { className: "dfe-message is-her" }, h("div", { className: "dfe-bubble" }, reply.text)) : null,
        h(
          "details",
          { open: index === 0 ? true : undefined },
          h(
            "summary",
            { className: "dfe-round-head" },
            h("span", { className: cx("dfe-badge", "is-" + (status === "ok" ? "ok" : status === "failed" ? "bad" : status === "blocked" ? "warn" : "muted")) }, badge),
            h("span", { className: "dfe-round-user" }, userText ? userText.slice(0, 34) + (userText.length > 34 ? "…" : "") : "（没有原话）"),
            h("span", { className: "dfe-round-cost-mini" },
              roleCostText(costs.judge, "判") + " · " + roleCostText(costs.reply, "回")),
            h("span", { className: "dfe-spacer" }),
            h("time", null, time(round.at) || "—"),
            h("span", { className: "dfe-chevron" }, "›"),
          ),
          h("div", { className: "dfe-round-detail" },
            !reply.text
              ? h("div", { className: "dfe-reply-missing" }, "她的回复这一轮尚未被采集；这不是空白。桥接层可用 envelope.reply 或 observeReply 补写。")
              : h("div", { className: "dfe-reply-source" }, "回复采集时间：" + (dateTime(reply.at) || "未记录") + " · 来源：" + (reply.source || "integration")),
            h(RoundSummary, { round: round }),
            h(RoundCosts, { round: round }),
            h(RoundFlow, { round: round, data: props.data }),
            h(CalculationBlock, { round: round }),
            (function () {
              var before = obj(round.axesBefore);
              var after = obj(round.axesAfter);
              var keys = ["valence", "energy", "arousal", "dominance", "clinginess", "trust"];
              if (!Object.keys(before).length && !Object.keys(after).length) return null;
              var names = { valence: "心情", energy: "精力", arousal: "唤醒", dominance: "底气", clinginess: "黏人", trust: "信任" };
              return h("details", { className: "dfe-inner-details" },
                h("summary", null, "账本数字 · 内部核对"),
                h("table", { className: "dfe-axis-table" },
                  h("thead", null, h("tr", null,
                    h("th", null, "轴"), h("th", null, "之前"), h("th", null, "之后"), h("th", null, "变化"),
                  )),
                  h("tbody", null, keys.map(function (key) {
                    var b = before[key];
                    var a = after[key];
                    var delta = b != null && a != null ? num(a) - num(b) : num(obj(round.delta)[key]);
                    return h("tr", { key: key },
                      h("td", null, names[key]),
                      h("td", null, b == null ? "—" : num(b).toFixed(1)),
                      h("td", null, a == null ? "—" : num(a).toFixed(1)),
                      h("td", { className: delta > 0 ? "is-up" : delta < 0 ? "is-down" : "" },
                        Math.abs(delta) < 0.05 ? "·" : (delta > 0 ? "+" : "") + delta.toFixed(1)),
                    );
                  })),
                ),
              );
            })(),
          ),
        ),
      );
    }

    function HistoryChart(props) {
      var data = obj(props.data);
      var generatedAt = num(data.generatedAt, Date.now());
      var points = arr(obj(data.history).points);
      var axes = arr(data.axes);
      var initialKey = axes.length ? str(axes[0].key) : "valence";
      var [axisKey, setAxisKey] = React.useState(initialKey);
      var [hours, setHours] = React.useState(24);
      var definition = axes.find(function (axis) { return axis.key === axisKey; }) || obj(axes[0]);
      if (!definition.key) definition = { key: "valence", name: "心情", range: [-100, 100] };

      var current = arr(axes).find(function (axis) { return axis.key === definition.key; });
      var since = generatedAt - hours * 3600000;
      var chartPoints = points
        .filter(function (point) { return num(point.at) >= since && obj(point.axes)[definition.key] != null; })
        .map(function (point) { return { at: num(point.at), value: num(obj(point.axes)[definition.key]) }; });
      if (current && (!chartPoints.length || chartPoints[chartPoints.length - 1].at < generatedAt)) {
        chartPoints.push({ at: generatedAt, value: num(current.value) });
      }
      var width = 420;
      var height = 165;
      var padX = 22;
      var padY = 18;
      var lo = num(obj(definition.range)[0], -100);
      var hi = num(obj(definition.range)[1], 100);
      var start = chartPoints.length ? chartPoints[0].at : since;
      var end = chartPoints.length ? chartPoints[chartPoints.length - 1].at : generatedAt;
      var span = Math.max(1, end - start);
      var path = chartPoints.map(function (point, index) {
        var x = padX + ((point.at - start) / span) * (width - padX * 2);
        var y = height - padY - percent(point.value, [lo, hi]) / 100 * (height - padY * 2);
        return (index ? "L" : "M") + x.toFixed(2) + " " + y.toFixed(2);
      }).join(" ");
      var values = chartPoints.map(function (point) { return point.value; });
      var min = values.length ? Math.min.apply(Math, values) : num(current && current.value);
      var max = values.length ? Math.max.apply(Math, values) : num(current && current.value);

      return h("div", { className: "dfe-chart-wrap" },
        h("div", { className: "dfe-chart-controls" },
          h("div", { className: "dfe-segment" },
            [[3, "3 小时"], [24, "24 小时"], [168, "7 天"]].map(function (pair) {
              return h("button", {
                key: pair[0],
                type: "button",
                className: hours === pair[0] ? "is-active" : "",
                onClick: function () { setHours(pair[0]); },
              }, pair[1]);
            }),
          ),
          h("span", { className: "dfe-chart-count" }, chartPoints.length + " 个采样"),
        ),
        h("div", { className: "dfe-axis-picker" }, axes.map(function (axis) {
          return h("button", {
            key: axis.key,
            type: "button",
            className: axisKey === axis.key ? "is-active" : "",
            onClick: function () { setAxisKey(axis.key); },
          }, axis.name);
        })),
        h("div", { className: "dfe-chart-card" },
          h("div", { className: "dfe-chart-title" },
            h("b", null, definition.name),
            h("span", null, "现在 " + (current ? current.displayValue + " · " + current.label : "—")),
          ),
          h("svg", {
            viewBox: "0 0 " + width + " " + height,
            className: "dfe-chart",
            role: "img",
            "aria-label": definition.name + "历史曲线",
          },
          h("line", { x1: padX, y1: height / 2, x2: width - padX, y2: height / 2, className: "dfe-chart-grid" }),
          h("line", { x1: padX, y1: padY, x2: padX, y2: height - padY, className: "dfe-chart-grid" }),
          path ? h("path", { d: path, className: "dfe-chart-path axis-" + definition.key }) : null,
          chartPoints.length
            ? h("circle", {
              cx: width - padX,
              cy: height - padY - percent(chartPoints[chartPoints.length - 1].value, [lo, hi]) / 100 * (height - padY * 2),
              r: 3.5,
              className: "dfe-chart-dot",
            })
            : null,
          ),
          h("div", { className: "dfe-chart-foot" },
            h("span", null, chartPoints.length ? dateTime(chartPoints[0].at) : "这段时间没有记录"),
            h("span", null, values.length ? "低 " + min.toFixed(1) + " · 高 " + max.toFixed(1) : "曲线从新版启用后开始"),
            h("span", null, chartPoints.length ? dateTime(chartPoints[chartPoints.length - 1].at) : "—"),
          ),
        ),
        h("p", { className: "dfe-chart-note" },
          "曲线只使用本版本实际记录过的判读点，不把旧手机看板的数据混进来。",
        ),
      );
    }

    function EpisodeList(props) {
      var items = arr(props.items);
      if (!items.length) return h(Empty, null, "没有还没过去的事。");
      return h("div", { className: "dfe-list" }, items.map(function (item, index) {
        return h("div", { className: "dfe-list-item", key: index },
          h("div", { className: "dfe-list-top" },
            h(Chip, { className: "is-event" }, item.type || "记着"),
            item.label ? h(Chip, null, item.label) : null,
            item.emo ? h(Chip, { className: "is-feeling" }, item.emo) : null,
            item.who ? h(Chip, { className: "is-muted" }, item.who) : null,
            h("span", { className: "dfe-spacer" }),
            h("span", { className: "dfe-muted" }, "提过 " + item.mentions + " 次"),
          ),
          item.quote
            ? h("p", { className: "dfe-list-quote" }, "「" + item.quote + "」")
            : h("p", { className: "dfe-muted" }, "没有逐字原话证据；只保留事件类型与时间。"),
          h(MetaLine, {
            items: [
              item.openedAt ? "首次 " + secondsDateTime(item.openedAt) : "",
              item.lastMentionAt ? "最近 " + secondsDateTime(item.lastMentionAt) : "",
              item.recalls ? "后来想过 " + item.recalls + " 次" : "",
              item.asks ? "问过 " + item.asks + " 次" : "",
            ],
          }),
        );
      }));
    }

    function InnerSection(props) {
      var inner = obj(props.inner);
      var gaps = arr(inner.gaps);
      var scars = arr(inner.scars);
      var core = arr(inner.coreMemory);
      var good = arr(obj(props.episodes).good);
      var groups = [
        ["还没说完的话", gaps, function (item) {
          return h("div", { className: "dfe-list-item" },
            h("p", null, item.text || "（内容已空）"),
            h(MetaLine, { items: [item.createdAt ? "记于 " + secondsDateTime(item.createdAt) : "", item.sharedAt ? "主动提过 " + secondsDateTime(item.sharedAt) : "还没主动提"] }),
          );
        }],
        ["她说别再提的疤", scars, function (item) {
          return h("div", { className: "dfe-list-item" },
            h(Chip, { className: "is-warn" }, item.topic || item.core || "敏感话题"),
            h(MetaLine, { items: [item.createdAt ? secondsDateTime(item.createdAt) : "", item.hits ? "撞到过 " + item.hits + " 次" : ""] }),
          );
        }],
        ["识海 · 长期记住", core, function (item) {
          return h("div", { className: "dfe-list-item" },
            h("p", null, item.text || "（内容已空）"),
            h(MetaLine, { items: [item.createdDate || (item.createdAt ? secondsDateTime(item.createdAt) : ""), item.by ? "来自 " + item.by : ""] }),
          );
        }],
        ["她还记着的认真", good, function (item) {
          return h("div", { className: "dfe-list-item" },
            h(Chip, { className: "is-good" }, item.label || item.type || "亲近"),
            h("p", { className: "dfe-list-quote" }, item.quote ? "「" + item.quote + "」" : "（没有原话，只记着那次）"),
            h(MetaLine, { items: [item.lastMentionAt ? secondsDateTime(item.lastMentionAt) : ""] }),
          );
        }],
      ];
      var any = groups.some(function (group) { return group[1].length; });
      if (!any) return h(Empty, null, "她现在没有还没说完的话、敏感话题或认真记着的亲近。");
      return h("div", { className: "dfe-groups" }, groups.map(function (group) {
        return h("details", { className: "dfe-inner-details", key: group[0], open: group[1].length && group[0] === "还没说完的话" ? true : undefined },
          h("summary", null, group[0], h("span", null, group[1].length ? String(group[1].length) : "0")),
          group[1].length
            ? h("div", { className: "dfe-list" }, group[1].map(function (item, index) { return h(React.Fragment, { key: index }, group[2](item)); }))
            : h(Empty, null, "这里现在是空的。"),
        );
      }));
    }

    function LocalLifeCard(props) {
      var bg = obj(props.background);
      var activity = obj(bg.localActivity);
      return h(Section, { title: "她刚才自己在做什么" },
        activity.text
          ? h("div", { className: "dfe-list-item" },
            h("div", { className: "dfe-list-top" },
              h(Chip, { className: "is-event" }, "本地活动"),
              h("span", { className: "dfe-spacer" }),
              h("span", { className: "dfe-muted" }, activity.seenAt ? "已经在聊天里提过" : "还没在聊天里提起")),
            h("p", { className: "dfe-list-quote" }, "「" + activity.text + "」"),
            h(MetaLine, { items: [
              activity.startedAt ? "开始于 " + secondsDateTime(activity.startedAt) : "",
              activity.seenAt ? "提过 " + secondsDateTime(activity.seenAt) : "",
            ] }),
          )
          : h(Empty, null, "还没有新的本地活动记录。这里只跟随现在的待机系统，不展示旧任务和旧后台日志。"),
        bg.lastPassAt
          ? h(MetaLine, { items: ["最近一次待机检查 " + secondsDateTime(bg.lastPassAt)] })
          : null,
      );
    }

    function NowPanel(props) {
      var data = obj(props.data);
      var activity = obj(data.activity);
      var now = obj(data.now);
      var round = obj(data.currentRound);
      var episodes = obj(data.episodes);
      var feelings = arr(now.feelings).slice(0, 3);
      var emo = str(now.emo);
      if (emo && emo !== "空" && feelings.indexOf(emo) < 0) {
        feelings = feelings.length >= 3 ? feelings.slice(0, 2).concat([emo]) : feelings.concat([emo]);
      }
      var extremes = arr(obj(now.extreme).items);
      var spirit = obj(now.spirit);
      return h(React.Fragment, null,
        h(Section, { className: "dfe-now-card", title: "此刻", meta: data.generatedAt ? "更新于 " + time(data.generatedAt) : "" },
          h("div", { className: "dfe-activity-line" },
            h(StatusDot, { tone: activity.kind === "away" ? "muted" : activity.kind === "sleeping" ? "warn" : "ok" }),
            h("b", null, activity.label || "状态未知"),
            activity.ageSeconds ? h("span", null, age(data.generatedAt - activity.ageSeconds * 1000, data.generatedAt)) : null,
          ),
          h("div", { className: "dfe-chip-row" },
            feelings.length
              ? feelings.map(function (word, index) { return h(Chip, { key: index, className: "is-feeling" }, word); })
              : h(Chip, { className: "is-muted" }, "这会儿没有新的情绪词"),
            extremes.map(function (item, index) {
              return h(Chip, { key: "ex-" + index, className: "is-extreme" },
                (item.label || item.key) + (item.locked ? " · 锁着" : " · 刚进") +
                (item.at ? " · " + duration(secondsToMs(item.at), data.generatedAt) : ""),
              );
            }),
          ),
          h("div", { className: "dfe-spirit" },
            h("div", { className: "dfe-spirit-top" },
              h("span", null, "精力"),
              h("b", null, num(spirit.value).toFixed(0) + "/100"),
              h("em", null, spirit.label || "")),
            h("div", { className: "dfe-soft-track" }, h("i", { style: { width: percent(spirit.value, [0, 100]) + "%" } })),
            h("p", { className: "dfe-small" }, spirit.note || ""),
          ),
        ),
        h(Section, { title: "六轴", meta: "每根都给文字档位" },
          h("div", { className: "dfe-axis-grid" }, arr(data.axes).map(function (axis) {
            return h(AxisCard, { key: axis.key, axis: axis });
          })),
        ),
        h(Section, { title: "这一轮 · 从门口到嘴", meta: round.at ? dateTime(round.at) : "还没有记录" },
          h(RoundSummary, { round: round }),
          h(RoundFlow, { round: round, data: data }),
        ),
        h(Section, { title: "还没过去的事", meta: episodes.openCount ? "共 " + episodes.openCount + " 件" : "没有" },
          h(EpisodeList, { items: episodes.open }),
        ),
        h(Section, { title: "她记得的事", meta: "只显示现在仍会写入的情绪记忆" },
          h(InnerSection, { inner: data.inner, episodes: episodes }),
        ),
        h(LocalLifeCard, { background: data.background }),
      );
    }

    function HistoryPanel(props) {
      var data = obj(props.data);
      var status = obj(obj(data.history).status);
      return h(React.Fragment, null,
        h(Section, { title: "这半天她怎么变的", meta: status.records ? "保留 " + status.records + " 轮 · " + num(status.retentionDays, 7) + " 天" : "等待新记录" },
          h(HistoryChart, { data: data }),
        ),
        h(Section, { title: "还没过去的事", meta: obj(data.episodes).openCount ? "共 " + obj(data.episodes).openCount + " 件" : "没有" },
          h(EpisodeList, { items: obj(data.episodes).open }),
        ),
        h(Section, { title: "她记得的事", meta: "没说完 / 敏感话题 / 长期记住 / 认真记得" },
          h(InnerSection, { inner: data.inner, episodes: data.episodes }),
        ),
        h(Section, { title: "观测历史", meta: status.available ? "正常" : "降级" },
          h("div", { className: "dfe-kv-grid" },
            h(KeyValue, { label: "可回放轮数", value: String(status.records || 0) }),
            h(KeyValue, { label: "最早记录", value: status.earliestAt ? dateTime(status.earliestAt) : "还没有" }),
            h(KeyValue, { label: "最近记录", value: status.latestAt ? dateTime(status.latestAt) : "还没有" }),
            h(KeyValue, { label: "保留", value: num(status.retentionDays, 7) + " 天" }),
          ),
          status.lastError ? h("p", { className: "dfe-small is-warn" }, "观测层问题：" + status.lastError) : null,
          h("p", { className: "dfe-small" }, "这部分历史只服务看板，不参与情绪判读，也不是手机看板那套记忆库。"),
        ),
      );
    }

    function RoundsPanel(props) {
      var data = obj(props.data);
      var rounds = arr(data.rounds);
      var status = obj(obj(data.history).status);
      return h(Section, { title: "逐轮回放", meta: rounds.length ? "最近 " + rounds.length + " 轮" : "从本版本开始记录" },
        h("p", { className: "dfe-section-intro" },
          "每一轮按“他说了什么 → 判成什么 → 她心里 → 动作 → 账本 → 慢判断 → 数值”展开。更早的旧记录没有这些字段，不会补造。",
        ),
        !status.available
          ? h("div", { className: "dfe-warning" }, "逐轮观测历史暂不可用：" + (status.lastError || "未知原因") + "。情绪系统本身仍可继续工作。")
          : null,
        rounds.length
          ? h("div", { className: "dfe-round-list" }, rounds.map(function (round, index) {
            return h(RoundCard, { key: round.id || round.at || index, round: round, index: index, data: data });
          }))
          : h(Empty, null, "还没有逐轮记录。新版看板会在下一次成功判读后开始留下完整回放。"),
      );
    }

    function RuntimePanel(props) {
      var data = obj(props.data);
      var runtime = obj(data.runtime);
      var llm = obj(runtime.llm);
      var usage = obj(runtime.usage);
      var stats = obj(runtime.stats);
      var observed = obj(runtime.observedUsage);
      var today = obj(observed.today);
      var background = obj(runtime.background);
      return h(React.Fragment, null,
        h(Section, { title: "运行", meta: runtime.lastUpdatedAt ? "最后变化 " + dateTime(runtime.lastUpdatedAt) : "" },
          h("div", { className: "dfe-health-grid" },
            h("div", { className: "dfe-health" },
              h(StatusDot, { tone: runtime.ready ? "ok" : "bad" }),
              h("span", null, "插件"),
              h("b", null, runtime.ready ? (runtime.readonly ? "只读" : "正常") : "未就绪"),
            ),
            h("div", { className: "dfe-health" },
              h(StatusDot, { tone: llm.available ? "ok" : "warn" }),
              h("span", null, "判读模型"),
              h("b", null, llm.available ? "有路由" : "暂不可用"),
            ),
            h("div", { className: "dfe-health" },
              h(StatusDot, { tone: background.started ? (background.busy ? "warn" : "ok") : "muted" }),
              h("span", null, "本地生活调度"),
              h("b", null, background.started ? (background.busy ? "正在跑" : "已启动") : "未启动"),
            ),
          ),
          h("div", { className: "dfe-kv-grid" },
            h(KeyValue, { label: "Provider", value: llm.provider || "未选" }),
            h(KeyValue, { label: "Model", value: llm.model || "未选" }),
            h(KeyValue, { label: "路由来源", value: llm.route || llm.reason || "—" }),
            h(KeyValue, { label: "数据目录", value: runtime.dataDirName || "—" }),
            h(KeyValue, { label: "Schema", value: String(runtime.schemaVersion || "—") }),
            h(KeyValue, { label: "待机检查间隔", value: background.intervalMs ? Math.round(background.intervalMs / 60000) + " 分钟" : "—" }),
          ),
          !llm.available ? h("p", { className: "dfe-small is-warn" }, "没有判读路由时情绪状态不会动；看板也不会伪造一轮。") : null,
        ),
        h(Section, { title: "判读与调用", meta: "数字口径：存储用量 + 本次进程计数" },
          h("div", { className: "dfe-kv-grid" },
            h(KeyValue, { label: "累计成功", value: String(usage.judged || 0) }),
            h(KeyValue, { label: "累计失败", value: String(usage.failed || 0) }),
            h(KeyValue, { label: "降级轮次", value: String(usage.degraded || 0) }),
            h(KeyValue, { label: "本进程成功", value: String(stats.judged || 0) }),
            h(KeyValue, { label: "本进程失败", value: String(stats.failed || 0) }),
            h(KeyValue, { label: "重复事件", value: String(stats.duplicate || 0) }),
            h(KeyValue, { label: "重试", value: String(stats.retried || 0) }),
            h(KeyValue, { label: "最后判读", value: usage.lastJudgeAt ? dateTime(usage.lastJudgeAt) : "还没有" }),
          ),
        ),
        h(Section, { title: "今日模型用量", meta: today.reportedRounds ? today.reportedRounds + " 轮有上报" : "未采集" },
          today.reportedRounds
            ? h("div", { className: "dfe-kv-grid" },
              h(KeyValue, { label: "判读轮数", value: String(today.reportedRounds) }),
              h(KeyValue, { label: "模型调用", value: String(today.calls || 0) }),
              h(KeyValue, { label: "输入", value: String(today.billedInputTokens || today.inputTokens || 0) + " tok" }),
              h(KeyValue, { label: "输出", value: String(today.outputTokens || 0) + " tok" }),
              h(KeyValue, { label: "总 token", value: String(today.totalTokens || 0) }),
              h(KeyValue, { label: "缓存命中", value: today.cacheHitRate == null ? "无缓存读数" : today.cacheHitRate + "%" }),
              h(KeyValue, { label: "判读侧上报费用", value: today.cost ? ((today.currency || "费用") + " " + today.cost) : "未采集" }),
              h(KeyValue, { label: "平均 token", value: today.reportedRounds ? Math.round(num(today.totalTokens) / today.reportedRounds) + " / 轮" : "—" }),
            )
            : h("p", { className: "dfe-muted" }, "今天的判读还没有 token 读数；逐轮费用区会分别标出未采集。"),
          h("p", { className: "dfe-small" }, "这一节只汇总小模型判读的 usage；小模型判读与大模型回复的逐轮费用在每轮顶部单独显示。"),
          h("p", { className: "dfe-small" }, "累计窗口：" + (observed.reportedRounds || 0) + " 轮有读数 · 缓存命中 " + (observed.cacheHitRate == null ? "—" : observed.cacheHitRate + "%") + " · " + (observed.totalTokens || 0) + " token。"),
          h("p", { className: "dfe-small" }, "逐轮金额按 DSH 当前价目估算，并写明价目来源；不会沿用旧手机看板的固定费率。"),
        ),
        h(Section, { title: "边界与来源", meta: "只读看板" },
          h("div", { className: "dfe-source-note" },
            h("p", null, "数据源是 DSH 本机情绪插件自己的 state / layer2 / 观测历史。"),
            h("p", null, "不连接 AstrBot、Python、QQ、语音或向量服务；原手机看板的另一套记忆系统整块舍弃。"),
            h("p", null, "solo、改心情、改好感、写识海、关闭事件、上传头像都不是情绪系统的只读展示功能，这里不提供写入口。"),
          ),
          h("ul", { className: "dfe-limit-list" }, arr(runtime.limitations).map(function (line, index) {
            return h("li", { key: index }, line);
          })),
        ),
      );
    }

    function Drawer(props) {
      var open = useOpen();
      var [expanded, setExpanded] = React.useState(false);
      var [tab, setTab] = React.useState("now");
      var [data, setData] = React.useState(null);
      var [state, setState] = React.useState({ loading: false, error: "", lastOkAt: 0 });
      var [reloadKey, setReloadKey] = React.useState(0);

      React.useEffect(function () {
        if (!open) return undefined;
        var alive = true;
        var controller = null;
        var timer = null;
        function schedule() {
          if (!alive) return;
          timer = setTimeout(refresh, POLL_MS);
        }
        async function refresh() {
          if (!alive) return;
          if (controller) controller.abort();
          controller = new AbortController();
          setState(function (prev) { return { loading: !prev.lastOkAt, error: "", lastOkAt: prev.lastOkAt }; });
          try {
            var value = await loadDashboard(controller.signal);
            if (!alive) return;
            setData(value);
            setState({ loading: false, error: "", lastOkAt: Date.now() });
            schedule();
          } catch (error) {
            if (!alive || error.name === "AbortError") return;
            setState(function (prev) {
              return { loading: false, error: error.message || "connection_failed", lastOkAt: prev.lastOkAt };
            });
            schedule();
          }
        }
        refresh();
        return function () {
          alive = false;
          if (timer) clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, [open, reloadKey]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onKey(event) {
          if (event.key === "Escape") setOpen(false);
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [open]);

      if (!open) return null;
      var current = obj(data);
      var runtime = obj(current.runtime);
      var llm = obj(runtime.llm);
      var historyStatus = obj(obj(current.history).status);
      var offline = Boolean(state.error);
      var tabs = [
        { id: "now", label: "此刻" },
        { id: "history", label: "轨迹" },
        { id: "rounds", label: "逐轮", count: arr(current.rounds).length || null },
        { id: "runtime", label: "运行" },
      ];

      return h(
        "div",
        { className: cx("dfe-overlay", expanded && "is-expanded"), "data-dfe-open": "true" },
        h("button", {
          type: "button",
          className: "dfe-backdrop",
          "aria-label": "关闭情绪看板",
          onClick: function () { setOpen(false); },
        }),
        h(
          "aside",
          { className: "dfe-drawer", role: "dialog", "aria-modal": "true", "aria-label": "小肥鱼情绪看板" },
          h(
            "header",
            { className: "dfe-drawer-head" },
            h("div", { className: "dfe-brand" },
              h("div", { className: "dfe-brand-fish" }, "🐟"),
              h("div", null,
                h("h2", null, "小肥鱼 · 情绪看板"),
                h("div", { className: "dfe-brand-sub" },
                  h(StatusDot, { tone: offline ? "warn" : llm.available ? "ok" : "muted" }),
                  offline
                    ? "断线 · 最后更新 " + (time(state.lastOkAt) || "—")
                    : llm.available
                      ? "已聊 " + num(obj(current.her).totalTurns) + " 轮 · DSH 内运行"
                      : "判读路由暂不可用",
                ),
              ),
            ),
            h("div", { className: "dfe-head-tools" },
              h("button", {
                type: "button",
                className: "dfe-icon-button",
                title: "重新连接",
                "aria-label": "重新连接",
                onClick: function () { setReloadKey(function (value) { return value + 1; }); },
              }, "↻"),
              h("button", {
                type: "button",
                className: "dfe-icon-button",
                title: expanded ? "收小看板" : "展开看板",
                "aria-label": expanded ? "收小看板" : "展开看板",
                onClick: function () { setExpanded(!expanded); },
              }, expanded ? "⇥" : "⤢"),
              h("button", {
                type: "button",
                className: "dfe-icon-button is-close",
                title: "关闭",
                "aria-label": "关闭情绪看板",
                onClick: function () { setOpen(false); },
              }, "×"),
            ),
          ),
          offline
            ? h("div", { className: "dfe-offline" },
              h("span", null, state.lastOkAt ? "断线 · 显示最后一次数据 · 最后更新 " + time(state.lastOkAt) : "连不上看板数据"),
              h("button", { type: "button", onClick: function () { setReloadKey(function (value) { return value + 1; }); } }, "重试"),
            )
            : null,
          h("nav", { className: "dfe-tabs", role: "tablist" },
            tabs.map(function (item) {
              return h(TabButton, {
                key: item.id,
                label: item.label,
                count: item.count,
                active: tab === item.id,
                onClick: function () { setTab(item.id); },
              });
            }),
          ),
          h(
            "div",
            { className: "dfe-content" },
            state.loading && !data
              ? h("div", { className: "dfe-loading" }, h("span", null, "🐟"), h("p", null, "正在读她的情绪……"))
              : !data
                ? h("div", { className: "dfe-loading is-error" },
                  h("span", null, "⚠"),
                  h("p", null, state.error || "看板暂时不可用"),
                  h("button", { type: "button", onClick: function () { setReloadKey(function (value) { return value + 1; }); } }, "再试一次"),
                )
                : tab === "now"
                  ? h(NowPanel, { data: data })
                  : tab === "history"
                    ? h(HistoryPanel, { data: data })
                    : tab === "rounds"
                      ? h(RoundsPanel, { data: data })
                      : h(RuntimePanel, { data: data }),
          ),
          h("footer", { className: "dfe-drawer-foot" },
            h("span", null, "只读 · 每 5 秒刷新"),
            h("a", {
              className: "dfe-desktop-download",
              href: DESKTOP_ZIP_MIRROR_URL,
              target: "_blank",
              rel: "noopener noreferrer",
              title: "国内加速下载完整桌宠包",
            }, "⚡ 下载桌面端"),
            h("span", null, current.generatedAt ? "最近快照 " + time(current.generatedAt) : "等待更新"),
          ),
        ),
      );
    }

    var CSS = [
      ".dfe-header-button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;opacity:.82;transition:background .15s ease,border-color .15s ease,opacity .15s ease}",
      ".dfe-header-button:hover,.dfe-header-button.is-active{opacity:1;background:color-mix(in srgb,currentColor 7%,transparent);border-color:color-mix(in srgb,currentColor 11%,transparent)}",
      ".dfe-header-fish{font-size:15px;line-height:1}",
      ".dfe-header-label{font-weight:600}",
      ".dfe-setup-backdrop{position:fixed;inset:0;z-index:1001;display:flex;align-items:flex-start;justify-content:center;padding:10vh 18px 24px;background:rgba(38,31,48,.42);backdrop-filter:blur(8px);font-family:var(--dsh-font-family,ui-sans-serif,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);animation:dfe-setup-fade .18s ease-out}",
      ".dfe-setup-card{position:relative;width:min(560px,calc(100vw - 28px));padding:28px 30px 25px;border:1px solid rgba(255,209,226,.85);border-radius:28px;background:radial-gradient(circle at 100% 0,rgba(255,180,209,.26),transparent 34%),radial-gradient(circle at 0 100%,rgba(171,193,242,.2),transparent 34%),linear-gradient(150deg,#fffdfb,#fff4f9 58%,#f5f2ff);box-shadow:0 28px 90px rgba(76,52,92,.32),inset 0 1px 0 #fff;color:#513c51;animation:dfe-setup-rise .24s cubic-bezier(.2,.8,.25,1)}",
      ".dfe-setup-close{position:absolute;right:16px;top:15px;width:34px;height:34px;border:1px solid rgba(206,143,170,.2);border-radius:50%;background:rgba(255,255,255,.68);color:#9c7386;font:22px/1 ui-sans-serif,sans-serif;cursor:pointer}.dfe-setup-close:hover{background:#fff;color:#b4547f}",
      ".dfe-setup-badge{display:grid;place-items:center;width:58px;height:58px;margin-bottom:15px;border:3px solid #fff;border-radius:50%;background:linear-gradient(145deg,#fff,#ffd9e7);box-shadow:0 0 0 7px rgba(255,218,231,.5),0 12px 28px rgba(177,100,136,.16);font-size:29px;transform:rotate(-5deg)}",
      ".dfe-setup-kicker{color:#b66387;font-size:11px;font-weight:800;letter-spacing:.12em}",
      ".dfe-setup-card h2{margin:6px 0 10px;color:#5b3f57;font-size:24px;line-height:1.2;letter-spacing:.02em}",
      ".dfe-setup-copy{margin:0;color:#765d70;font-size:13px;line-height:1.78}",
      ".dfe-setup-steps{display:grid;gap:8px;margin:18px 0;padding:15px 16px 15px 39px;border:1px solid rgba(231,169,193,.3);border-radius:17px;background:rgba(255,255,255,.62);color:#654e61;font-size:12.5px;line-height:1.6}.dfe-setup-steps li::marker{color:#df7fa8;font-weight:800}",
      ".dfe-setup-actions{display:flex;flex-wrap:wrap;gap:9px;align-items:center}.dfe-setup-primary,.dfe-setup-direct{display:inline-flex;align-items:center;justify-content:center;min-height:42px;border-radius:999px;font-size:12.5px;font-weight:800;text-decoration:none;transition:transform .15s ease,filter .15s ease,background .15s ease,border-color .15s ease}.dfe-setup-primary{padding:0 18px;border:1px solid rgba(255,255,255,.38);background:linear-gradient(135deg,#f58db6,#de82ba 48%,#9e95df);box-shadow:0 9px 22px rgba(205,103,152,.28),inset 0 1px 0 rgba(255,255,255,.45);color:#fff}.dfe-setup-primary:hover{filter:brightness(1.04);transform:translateY(-1px)}.dfe-setup-direct{padding:0 15px;border:1px solid rgba(210,149,175,.3);background:#fffafc;color:#8d667b}.dfe-setup-direct:hover{border-color:rgba(205,120,156,.46);background:#fff;color:#a34f77;transform:translateY(-1px)}.dfe-setup-later{min-height:38px;padding:0 8px;border:0;background:transparent;color:#9b7f8e;font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.dfe-setup-later:hover{color:#a34f77}",
      ".dfe-setup-note{margin:12px 0 0;color:#9b8391;font-size:11px;line-height:1.6}.dfe-setup-checksum{display:grid;gap:4px;margin-top:12px;padding:10px 12px;border:1px solid rgba(226,164,187,.24);border-radius:13px;background:rgba(255,255,255,.55);color:#876d7d;font-size:10px;line-height:1.45}.dfe-setup-checksum>span{font-weight:800;letter-spacing:.06em}.dfe-setup-checksum code{overflow-wrap:anywhere;color:#76566a;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;user-select:all}.dfe-setup-checksum small{color:#a08794}.dfe-desktop-download{color:#a55c7c;text-decoration:none;font-weight:700}.dfe-desktop-download:hover{text-decoration:underline}",
      ".dfe-plugin-download{display:grid;gap:14px;margin:16px 0 2px;padding:18px;border:1px solid rgba(224,150,178,.3);border-radius:18px;background:radial-gradient(circle at 100% 0,rgba(255,181,207,.22),transparent 36%),radial-gradient(circle at 0 100%,rgba(157,174,234,.14),transparent 35%),linear-gradient(145deg,#fffdfd,#fff5f9 60%,#f8f5ff);box-shadow:0 10px 28px rgba(151,91,121,.08),inset 0 1px 0 #fff;color:#583f55}",
      ".dfe-plugin-download-head{display:flex;align-items:flex-start;gap:13px}.dfe-plugin-download-mark{display:grid;place-items:center;flex:none;width:48px;height:48px;border:2px solid #fff;border-radius:50%;background:linear-gradient(145deg,#fff,#ffdbe8);box-shadow:0 0 0 5px rgba(255,215,230,.55),0 8px 18px rgba(177,100,136,.13);font-size:24px;transform:rotate(-4deg)}",
      ".dfe-plugin-download-copy{min-width:0}.dfe-plugin-download-kicker{color:#b26387;font-size:10px;font-weight:800;letter-spacing:.12em}.dfe-plugin-download h3{margin:4px 0 6px;color:#573d54;font-size:18px;line-height:1.25}.dfe-plugin-download p{margin:0;color:#7d6575;font-size:12px;line-height:1.7}",
      ".dfe-plugin-download-actions{display:flex;flex-wrap:wrap;gap:9px}.dfe-plugin-download-primary,.dfe-plugin-download-secondary{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 17px;border-radius:999px;font-size:12px;font-weight:800;text-decoration:none;transition:transform .15s ease,filter .15s ease,background .15s ease}.dfe-plugin-download-primary{border:1px solid rgba(255,255,255,.45);background:linear-gradient(135deg,#f48db5,#df80b8 50%,#9e95df);box-shadow:0 8px 20px rgba(205,103,152,.24),inset 0 1px 0 rgba(255,255,255,.42);color:#fff}.dfe-plugin-download-primary:hover{filter:brightness(1.04);transform:translateY(-1px)}.dfe-plugin-download-secondary{border:1px solid rgba(211,147,174,.3);background:#fffafd;color:#8e637a}.dfe-plugin-download-secondary:hover{border-color:rgba(205,120,156,.46);background:#fff;color:#a34f77;transform:translateY(-1px)}",
      ".dfe-plugin-download-note{padding-top:2px;color:#967b8a!important;font-size:10.5px!important}.dfe-plugin-download-verify{border-top:1px dashed rgba(211,147,174,.26);padding-top:10px;color:#967b8a;font-size:10px}.dfe-plugin-download-verify summary{cursor:pointer;font-weight:700}.dfe-plugin-download-verify code{display:block;margin-top:7px;padding:8px;border-radius:8px;background:rgba(92,63,81,.06);color:#765368;font:9.5px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all;user-select:all}",
      "@media (prefers-color-scheme:dark){.dfe-plugin-download{border-color:rgba(255,157,192,.2);background:radial-gradient(circle at 100% 0,rgba(255,143,184,.12),transparent 36%),linear-gradient(145deg,#302a34,#292633);box-shadow:0 12px 32px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.04);color:#edd8e2}.dfe-plugin-download h3{color:#fff0f6}.dfe-plugin-download p{color:#d0b5c2}.dfe-plugin-download-secondary{border-color:rgba(255,157,192,.2);background:#2d2734;color:#ddbfcd}.dfe-plugin-download-verify code{background:rgba(255,255,255,.06);color:#f0d4e1}}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-plugin-download{border-color:rgba(255,157,192,.2);background:radial-gradient(circle at 100% 0,rgba(255,143,184,.12),transparent 36%),linear-gradient(145deg,#302a34,#292633);box-shadow:0 12px 32px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.04);color:#edd8e2}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-plugin-download h3{color:#fff0f6}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-plugin-download p{color:#d0b5c2}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-plugin-download-secondary{border-color:rgba(255,157,192,.2);background:#2d2734;color:#ddbfcd}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-plugin-download-verify code{background:rgba(255,255,255,.06);color:#f0d4e1}",
      "@media (max-width:560px){.dfe-plugin-download{padding:15px;border-radius:15px}.dfe-plugin-download-head{align-items:center}.dfe-plugin-download-mark{width:42px;height:42px;font-size:21px}.dfe-plugin-download h3{font-size:16px}.dfe-plugin-download-primary,.dfe-plugin-download-secondary{width:100%}}",
      "@keyframes dfe-setup-fade{from{opacity:0}to{opacity:1}}@keyframes dfe-setup-rise{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}",
      "@media (prefers-color-scheme:dark){.dfe-setup-card{border-color:rgba(255,157,192,.24);background:radial-gradient(circle at 100% 0,rgba(255,143,184,.16),transparent 34%),linear-gradient(150deg,#352c3b,#2b293a);box-shadow:0 28px 90px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05);color:#f1dce6}.dfe-setup-card h2{color:#fff1f7}.dfe-setup-copy,.dfe-setup-steps{color:#d7bcc9}.dfe-setup-steps{background:rgba(255,255,255,.04);border-color:rgba(255,157,192,.14)}.dfe-setup-direct{background:#2d2734;color:#d6b8c7;border-color:rgba(255,157,192,.2)}.dfe-setup-note{color:#a98f9d}.dfe-setup-checksum{background:rgba(255,255,255,.04);border-color:rgba(255,157,192,.14);color:#caaabb}.dfe-setup-checksum code{color:#f0d4e1}.dfe-setup-checksum small{color:#a98f9d}.dfe-desktop-download{color:#ffa9c8}}",
      "@media (max-width:560px){.dfe-setup-backdrop{padding:5vh 12px 18px}.dfe-setup-card{padding:24px 19px 20px;border-radius:22px}.dfe-setup-card h2{font-size:20px}.dfe-setup-actions{display:grid}.dfe-setup-primary,.dfe-setup-direct{width:100%}.dfe-setup-later{width:100%;min-height:34px}}",
      ".dfe-overlay{--dfe-bg:#f6f8fb;--dfe-card:#fff;--dfe-card2:#f8fafc;--dfe-ink:#18212d;--dfe-ink2:#5d6979;--dfe-ink3:#8d98a7;--dfe-line:#e5eaf1;--dfe-accent:#2e947d;--dfe-accent-soft:#e5f4ef;--dfe-blue:#477bdb;--dfe-amber:#bb8121;--dfe-red:#c7585e;--dfe-shadow:0 18px 56px rgba(24,33,45,.2);position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;pointer-events:none;color:var(--dfe-ink);font-family:var(--dsh-font-family,ui-sans-serif,system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif);letter-spacing:0}",
      ".dfe-backdrop{position:absolute;inset:0;border:0;background:rgba(20,29,41,.18);backdrop-filter:blur(1px);pointer-events:auto;cursor:default}",
      ".dfe-drawer{position:relative;z-index:1;display:flex;flex-direction:column;width:min(480px,calc(100vw - 52px));height:100%;background:var(--dfe-bg);box-shadow:var(--dfe-shadow);pointer-events:auto;border-left:1px solid var(--dfe-line);overflow:hidden;transition:width .2s ease}",
      ".dfe-overlay.is-expanded .dfe-drawer{width:min(760px,calc(100vw - 88px))}",
      ".dfe-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 16px 12px;background:var(--dfe-card);border-bottom:1px solid var(--dfe-line)}",
      ".dfe-brand{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dfe-brand-fish{display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:linear-gradient(145deg,#eaf7f4,#f8fbfd);border:1px solid #d8ebe6;font-size:20px;flex:none}",
      ".dfe-brand h2{margin:0;font-size:15px;line-height:1.25;font-weight:700}",
      ".dfe-brand-sub{display:flex;align-items:center;gap:5px;margin-top:4px;color:var(--dfe-ink3);font-size:11px;line-height:1.2}",
      ".dfe-status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#a4adba;flex:none}",
      ".dfe-status-dot.is-ok{background:var(--dfe-accent);box-shadow:0 0 0 3px rgba(46,148,125,.12)}",
      ".dfe-status-dot.is-warn{background:var(--dfe-amber);box-shadow:0 0 0 3px rgba(187,129,33,.12)}",
      ".dfe-status-dot.is-bad{background:var(--dfe-red);box-shadow:0 0 0 3px rgba(199,88,94,.12)}",
      ".dfe-status-dot.is-muted{background:#a4adba}",
      ".dfe-head-tools{display:flex;align-items:center;gap:3px;flex:none}",
      ".dfe-icon-button{width:29px;height:29px;border:0;border-radius:8px;background:transparent;color:var(--dfe-ink2);font:inherit;font-size:17px;line-height:1;cursor:pointer;display:grid;place-items:center}",
      ".dfe-icon-button:hover{background:var(--dfe-card2);color:var(--dfe-ink)}",
      ".dfe-icon-button.is-close{font-size:21px}",
      ".dfe-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:8px 12px;background:var(--dfe-card);border-bottom:1px solid var(--dfe-line)}",
      ".dfe-tab{display:flex;align-items:center;justify-content:center;gap:5px;height:31px;border:0;border-radius:9px;background:transparent;color:var(--dfe-ink2);font:inherit;font-size:12px;font-weight:600;cursor:pointer}",
      ".dfe-tab:hover{background:var(--dfe-card2);color:var(--dfe-ink)}",
      ".dfe-tab.is-active{background:var(--dfe-accent-soft);color:#247560}",
      ".dfe-tab-count{display:inline-grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:rgba(46,148,125,.13);font-size:10px;font-variant-numeric:tabular-nums}",
      ".dfe-content{padding:12px;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;flex:1;min-height:0}",
      ".dfe-card{margin:0 0 11px;padding:14px;border-radius:14px;background:var(--dfe-card);border:1px solid var(--dfe-line);box-shadow:0 1px 2px rgba(25,35,50,.025)}",
      ".dfe-card-head{display:flex;align-items:center;gap:8px;margin-bottom:11px}",
      ".dfe-card-head h3{margin:0;font-size:12px;line-height:1.3;font-weight:700;color:var(--dfe-ink)}",
      ".dfe-card-head>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfe-ink3);font-size:10.5px;font-weight:400}",
      ".dfe-now-card{background:linear-gradient(180deg,var(--dfe-card),color-mix(in srgb,var(--dfe-accent-soft) 38%,var(--dfe-card)))}",
      ".dfe-activity-line{display:flex;align-items:center;gap:7px;margin-bottom:9px;font-size:14px;line-height:1.45}",
      ".dfe-activity-line>span:last-child{color:var(--dfe-ink3);font-size:11px;font-weight:400}",
      ".dfe-chip-row{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}",
      ".dfe-chip{display:inline-flex;align-items:center;min-height:20px;padding:2px 7px;border:1px solid var(--dfe-line);border-radius:7px;background:var(--dfe-card2);color:var(--dfe-ink2);font-size:10.5px;line-height:1.35}",
      ".dfe-chip.is-feeling{background:#eef3ff;border-color:#dfe7fb;color:#3f63ae}",
      ".dfe-chip.is-extreme{background:#fff0ec;border-color:#f5d9d0;color:#a94e3f}",
      ".dfe-chip.is-event{background:#f2f0fb;border-color:#e4def5;color:#65509b}",
      ".dfe-chip.is-warn{background:#fff7e8;border-color:#f0e1bd;color:#966615}",
      ".dfe-chip.is-good{background:#ecf8f3;border-color:#d8ece3;color:#26745f}",
      ".dfe-chip.is-muted{color:var(--dfe-ink3)}",
      ".dfe-chip.is-up{background:#eef8f3;border-color:#d9eee3;color:#287562}",
      ".dfe-chip.is-down{background:#fff0f0;border-color:#f1dada;color:#ad5358}",
      ".dfe-body-line{padding:8px 10px;margin:6px 0;border-radius:9px;background:rgba(255,255,255,.62);color:var(--dfe-ink2);font-size:12px}",
      ".dfe-spirit{margin-top:12px;padding-top:12px;border-top:1px solid color-mix(in srgb,var(--dfe-line) 75%,transparent)}",
      ".dfe-spirit-top{display:flex;align-items:baseline;gap:7px;margin-bottom:6px;font-size:11px;color:var(--dfe-ink2)}",
      ".dfe-spirit-top b{font-size:18px;color:var(--dfe-ink);font-variant-numeric:tabular-nums}",
      ".dfe-spirit-top em{font-style:normal;color:var(--dfe-accent);font-weight:600}",
      ".dfe-soft-track{position:relative;height:6px;border-radius:4px;background:#edf0f4;overflow:hidden}",
      ".dfe-soft-track i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#66b9a4,#2e947d)}",
      ".dfe-small{margin:5px 0;color:var(--dfe-ink2);font-size:10.8px;line-height:1.55}",
      ".dfe-small.is-warn,.is-warn{color:var(--dfe-amber)}",
      ".dfe-muted{color:var(--dfe-ink3)!important;font-size:10.9px;line-height:1.55}",
      ".dfe-axis-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".dfe-axis-card{padding:10px;border-radius:11px;background:var(--dfe-card2);border:1px solid color-mix(in srgb,var(--dfe-line) 78%,transparent);min-width:0}",
      ".dfe-axis-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px}",
      ".dfe-axis-top span{color:var(--dfe-ink2);font-size:10.5px}",
      ".dfe-axis-top strong{font-size:13px;font-variant-numeric:tabular-nums}",
      ".dfe-axis-label{margin:2px 0 7px;font-size:12px;font-weight:650}",
      ".dfe-axis-track{position:relative;height:7px;border-radius:6px;background:#e9edf2;overflow:visible}",
      ".dfe-axis-fill{position:absolute;top:0;height:100%;border-radius:6px;background:#7a93be}",
      ".dfe-axis-fill.axis-valence{background:#5c8bd8}.dfe-axis-fill.axis-energy{background:#3b9a82}.dfe-axis-fill.axis-arousal{background:#d46d63}.dfe-axis-fill.axis-dominance{background:#9270c0}.dfe-axis-fill.axis-clinginess{background:#c6923e}.dfe-axis-fill.axis-trust{background:#4c9a70}",
      ".dfe-axis-center{position:absolute;top:-2px;width:1px;height:11px;background:#aeb7c3;z-index:2}",
      ".dfe-axis-dot{position:absolute;top:50%;width:7px;height:7px;border-radius:50%;background:#fff;border:1.5px solid #5e748f;transform:translate(-50%,-50%);z-index:3}",
      ".dfe-axis-note{min-height:28px;margin:5px 0 0;color:var(--dfe-ink3);font-size:9.7px;line-height:1.45}",
      ".dfe-round-summary{display:flex;align-items:center;gap:7px;margin-bottom:12px;color:var(--dfe-ink2);font-size:10.5px}",
      ".dfe-spacer{flex:1}",
      ".dfe-flow{display:flex;flex-direction:column;gap:0}",
      ".dfe-flow-step{display:grid;grid-template-columns:26px 1fr;gap:9px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--dfe-line) 72%,transparent)}",
      ".dfe-flow-step:first-child{padding-top:2px}.dfe-flow-step:last-child{border-bottom:0;padding-bottom:2px}",
      ".dfe-flow-index{display:grid;place-items:center;align-self:start;width:23px;height:23px;border-radius:8px;background:var(--dfe-card2);color:var(--dfe-ink3);font-size:9px;font-variant-numeric:tabular-nums}",
      ".dfe-flow-step.is-bad .dfe-flow-index{background:#fff0f0;color:var(--dfe-red)}.dfe-flow-step.is-warn .dfe-flow-index{background:#fff7e8;color:var(--dfe-amber)}",
      ".dfe-flow-body{padding-top:2px;min-width:0}",
      ".dfe-flow-body h4{margin:0 0 5px;font-size:11px;font-weight:700;color:var(--dfe-ink)}",
      ".dfe-flow-body p{margin:0;color:var(--dfe-ink2);font-size:11px;line-height:1.6}",
      ".dfe-quote{padding:8px 9px;margin:7px 0;border-left:2px solid var(--dfe-line);border-radius:0 8px 8px 0;background:var(--dfe-card2)}",
      ".dfe-quote.is-warm{border-left-color:#d5b071;background:#fffaf1}.dfe-quote.is-neutral{border-left-color:#c8d1df}",
      ".dfe-quote-label{margin-bottom:3px;color:var(--dfe-ink3);font-size:9.5px}",
      ".dfe-quote p{margin:0;color:var(--dfe-ink);font-size:11.2px;line-height:1.65;white-space:pre-wrap;word-break:break-word}",
      ".dfe-beats{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}",
      ".dfe-action-final{display:flex;align-items:baseline;gap:6px;margin-bottom:4px}.dfe-action-final b{font-size:14px;color:var(--dfe-accent)}",
      ".dfe-event-line{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 7px}",
      ".dfe-usage-line{display:flex;flex-wrap:wrap;gap:5px 11px;color:var(--dfe-ink2);font-size:10.5px}",
      ".dfe-cost-panel{display:grid;gap:5px;margin:10px 0 12px;padding:9px 10px;border:1px solid var(--dfe-line);border-radius:10px;background:var(--dfe-card2)}",
      ".dfe-cost-line{display:flex;align-items:baseline;gap:7px;min-width:0;color:var(--dfe-ink2);font-size:10.5px}",
      ".dfe-cost-line b{min-width:78px;color:var(--dfe-ink);font-weight:650}.dfe-cost-line span{font-variant-numeric:tabular-nums;font-weight:650}.dfe-cost-line small{color:var(--dfe-ink3)}.dfe-cost-line em{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfe-amber);font-size:9px;font-style:normal}",
      ".dfe-cost-total{display:flex;align-items:baseline;gap:7px;padding-top:5px;border-top:1px dashed var(--dfe-line);color:var(--dfe-ink2);font-size:10px}.dfe-cost-total b{color:var(--dfe-ink);font-size:11px;font-variant-numeric:tabular-nums}.dfe-cost-total small{margin-left:auto;color:var(--dfe-ink3)}",
      ".dfe-round-cost-mini{max-width:148px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfe-ink3);font-size:9px;font-variant-numeric:tabular-nums}",
      ".dfe-round-list{display:flex;flex-direction:column;gap:8px}",
      ".dfe-round{padding:0;border-radius:12px;background:var(--dfe-card2);overflow:hidden}",
      ".dfe-message{display:flex;margin:7px 2px}.dfe-message.is-user{justify-content:flex-start}.dfe-message.is-her{justify-content:flex-end}",
      ".dfe-bubble{max-width:88%;padding:8px 10px;border-radius:11px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}",
      ".dfe-message.is-user .dfe-bubble{background:var(--dfe-card);border:1px solid var(--dfe-line);border-top-left-radius:4px}",
      ".dfe-message.is-her .dfe-bubble{background:#eaf6f2;border:1px solid #d9ebe5;border-top-right-radius:4px}",
      ".dfe-round details{background:var(--dfe-card);border:1px solid var(--dfe-line);border-radius:12px;overflow:hidden}",
      ".dfe-round details>summary::-webkit-details-marker{display:none}",
      ".dfe-round-head{display:flex;align-items:center;gap:7px;padding:9px 10px;cursor:pointer;list-style:none;font-size:10.5px;color:var(--dfe-ink2)}",
      ".dfe-badge{padding:2px 6px;border-radius:6px;font-size:9.5px}.dfe-badge.is-ok{background:#e9f7f1;color:#28735f}.dfe-badge.is-bad{background:#fff0f0;color:#ad5358}.dfe-badge.is-warn{background:#fff7e8;color:#966615}.dfe-badge.is-muted{background:#eef1f4;color:#768191}",
      ".dfe-round-user{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfe-ink)}",
      ".dfe-round-head time{color:var(--dfe-ink3);font-size:9.5px;font-variant-numeric:tabular-nums}",
      ".dfe-chevron{font-size:15px;color:var(--dfe-ink3);transform:rotate(90deg);transition:transform .15s}.dfe-round details[open] .dfe-chevron{transform:rotate(-90deg)}",
      ".dfe-round-detail{padding:0 10px 11px;border-top:1px solid var(--dfe-line)}",
      ".dfe-reply-missing{margin:9px 0;padding:7px 8px;border-radius:8px;background:#fff8eb;color:#986818;font-size:10px;line-height:1.5}",
      ".dfe-reply-source{margin:9px 0;color:var(--dfe-ink3);font-size:9.5px}",
      ".dfe-inner-details{margin:8px 0;border:1px solid var(--dfe-line);border-radius:9px;background:var(--dfe-card)}",
      ".dfe-inner-details>summary{display:flex;align-items:center;gap:7px;padding:8px 9px;cursor:pointer;list-style:none;color:var(--dfe-ink2);font-size:10.5px;font-weight:600}",
      ".dfe-inner-details>summary::-webkit-details-marker{display:none}.dfe-inner-details>summary>span{margin-left:auto;color:var(--dfe-ink3);font-weight:400}",
      ".dfe-axis-table{width:100%;border-collapse:collapse;margin:0 0 8px;font-size:9.5px;font-variant-numeric:tabular-nums}",
      ".dfe-axis-table th,.dfe-axis-table td{padding:5px 4px;border-top:1px solid var(--dfe-line);text-align:right}.dfe-axis-table th:first-child,.dfe-axis-table td:first-child{text-align:left}",
      ".dfe-axis-table th{color:var(--dfe-ink3);font-weight:500}.dfe-axis-table td.is-up{color:#28735f}.dfe-axis-table td.is-down{color:#ad5358}",
      ".dfe-list{display:flex;flex-direction:column;gap:7px}",
      ".dfe-list-item{padding:8px;border-radius:8px;background:var(--dfe-card2);border:1px solid color-mix(in srgb,var(--dfe-line) 72%,transparent)}",
      ".dfe-list-top{display:flex;flex-wrap:wrap;align-items:center;gap:5px}.dfe-list-top time{color:var(--dfe-ink3);font-size:9.5px}",
      ".dfe-list-item p{margin:5px 0;color:var(--dfe-ink2);font-size:10.7px;line-height:1.55;word-break:break-word}",
      ".dfe-list-quote{color:var(--dfe-ink)!important}",
      ".dfe-meta-line{display:flex;flex-wrap:wrap;gap:4px 9px;margin-top:4px;color:var(--dfe-ink3);font-size:9.2px}",
      ".dfe-groups{display:flex;flex-direction:column;gap:6px}.dfe-groups>.dfe-inner-details{margin:0}.dfe-groups>.dfe-inner-details>.dfe-list{padding:0 8px 8px}",
      ".dfe-empty{padding:8px;color:var(--dfe-ink3);font-size:10.5px;text-align:center}",
      ".dfe-background-main{margin:4px 0 9px}.dfe-background-task{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}.dfe-background-task span{color:var(--dfe-ink3);font-size:9.5px}.dfe-background-task b{font-size:13px}.dfe-background-task em{margin-left:auto;color:var(--dfe-ink3);font-size:9.5px;font-style:normal}",
      ".dfe-progress{margin:7px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}.dfe-progress li{display:flex;gap:8px;color:var(--dfe-ink2);font-size:10px}.dfe-progress li time{margin-left:auto;color:var(--dfe-ink3)}",
      ".dfe-mini-title{margin:9px 0 5px;color:var(--dfe-ink3);font-size:9.5px;font-weight:600}",
      ".dfe-chart-controls{display:flex;align-items:center;justify-content:space-between;gap:8px}.dfe-segment{display:inline-flex;padding:3px;border-radius:8px;background:var(--dfe-card2);border:1px solid var(--dfe-line)}",
      ".dfe-segment button{border:0;border-radius:6px;background:transparent;padding:4px 7px;color:var(--dfe-ink2);font:inherit;font-size:9.5px;cursor:pointer}.dfe-segment button.is-active{background:var(--dfe-card);color:var(--dfe-ink);box-shadow:0 1px 2px rgba(20,30,45,.08)}",
      ".dfe-chart-count{color:var(--dfe-ink3);font-size:9.5px}",
      ".dfe-axis-picker{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}.dfe-axis-picker button{border:1px solid var(--dfe-line);border-radius:7px;background:var(--dfe-card);padding:3px 7px;color:var(--dfe-ink2);font:inherit;font-size:9.5px;cursor:pointer}.dfe-axis-picker button.is-active{background:var(--dfe-accent-soft);border-color:#cfe8df;color:#247560;font-weight:600}",
      ".dfe-chart-card{padding:9px 8px 7px;border-radius:10px;background:var(--dfe-card2);border:1px solid var(--dfe-line)}",
      ".dfe-chart-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:0 5px 4px}.dfe-chart-title b{font-size:11px}.dfe-chart-title span{color:var(--dfe-ink3);font-size:9.5px}",
      ".dfe-chart{display:block;width:100%;height:auto;overflow:visible}.dfe-chart-grid{stroke:#dce2ea;stroke-width:1;stroke-dasharray:3 4}.dfe-chart-path{fill:none;stroke:#5c8bd8;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.dfe-chart-path.axis-energy{stroke:#3b9a82}.dfe-chart-path.axis-arousal{stroke:#d46d63}.dfe-chart-path.axis-dominance{stroke:#9270c0}.dfe-chart-path.axis-clinginess{stroke:#c6923e}.dfe-chart-path.axis-trust{stroke:#4c9a70}.dfe-chart-dot{fill:#fff;stroke:#5c8bd8;stroke-width:2}",
      ".dfe-chart-foot{display:flex;justify-content:space-between;gap:6px;padding:0 6px;color:var(--dfe-ink3);font-size:8.8px}.dfe-chart-foot span:nth-child(2){text-align:center}.dfe-chart-note{margin:7px 0 0;color:var(--dfe-ink3);font-size:9.4px;line-height:1.5}",
      ".dfe-kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.dfe-kv{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:7px 8px;border-radius:8px;background:var(--dfe-card2);font-size:9.8px}.dfe-kv span{color:var(--dfe-ink3)}.dfe-kv strong{max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dfe-ink);font-weight:600;text-align:right}",
      ".dfe-health-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px}.dfe-health{display:grid;grid-template-columns:auto 1fr;gap:2px 6px;align-items:center;padding:8px;border-radius:9px;background:var(--dfe-card2);font-size:9.5px}.dfe-health .dfe-status-dot{grid-row:span 2}.dfe-health span{color:var(--dfe-ink3)}.dfe-health b{font-size:11px}",
      ".dfe-section-intro{margin:0 0 10px;color:var(--dfe-ink2);font-size:10.5px;line-height:1.65}",
      ".dfe-warning{padding:8px 9px;margin:0 0 9px;border-radius:8px;background:#fff7e8;border:1px solid #f0e1bd;color:#966615;font-size:10px;line-height:1.55}",
      ".dfe-source-note p{margin:5px 0;color:var(--dfe-ink2);font-size:10.5px;line-height:1.6}.dfe-limit-list{margin:7px 0 0;padding-left:16px;color:var(--dfe-ink3);font-size:9.7px;line-height:1.6}",
      ".dfe-offline{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#fff7e8;color:#966615;font-size:10px;border-bottom:1px solid #f0e1bd}.dfe-offline button{margin-left:auto;border:1px solid #e6ce97;border-radius:6px;background:#fff;color:#966615;font:inherit;font-size:10px;padding:3px 8px;cursor:pointer}",
      ".dfe-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px;color:var(--dfe-ink3);font-size:11px}.dfe-loading span{font-size:32px}.dfe-loading p{margin:9px 0}.dfe-loading button{border:1px solid var(--dfe-line);border-radius:8px;background:var(--dfe-card);color:var(--dfe-ink2);font:inherit;font-size:10.5px;padding:5px 10px;cursor:pointer}",
      ".dfe-drawer-foot{display:flex;justify-content:space-between;gap:10px;padding:8px 14px;border-top:1px solid var(--dfe-line);background:var(--dfe-card);color:var(--dfe-ink3);font-size:9px}",
      "@media (prefers-color-scheme:dark){.dfe-overlay{--dfe-bg:#151a21;--dfe-card:#1c232c;--dfe-card2:#202933;--dfe-ink:#e7edf5;--dfe-ink2:#aab5c3;--dfe-ink3:#748191;--dfe-line:#2b3541;--dfe-accent:#4eb29a;--dfe-accent-soft:#18382f;--dfe-shadow:0 18px 60px rgba(0,0,0,.5)}.dfe-brand-fish{background:#1d322f;border-color:#2b4a43}.dfe-chip.is-feeling{background:#202d49;border-color:#2b3c61;color:#9db8ef}.dfe-chip.is-extreme{background:#3b2522;border-color:#57322d;color:#efaaa0}.dfe-chip.is-event{background:#2d2940;border-color:#403852;color:#c2b3e8}.dfe-chip.is-warn{background:#372d1d;border-color:#55442a;color:#dfbd78}.dfe-chip.is-good,.dfe-chip.is-up{background:#1d342d;border-color:#2e4c41;color:#85cdb7}.dfe-chip.is-down{background:#392426;border-color:#563235;color:#e9a1a5}.dfe-quote.is-warm{background:#29251d;border-left-color:#8c7144}.dfe-message.is-her .dfe-bubble{background:#19332c;border-color:#2a4a40}.dfe-axis-track,.dfe-soft-track{background:#2b333d}.dfe-axis-table th{border-color:#2b3541}.dfe-chart-grid{stroke:#313c48}.dfe-offline{background:#382d19;border-color:#564528;color:#e1bd78}.dfe-offline button{background:#211c15;border-color:#5d4b2e;color:#e1bd78}.dfe-warning{background:#382d19;border-color:#564528;color:#e1bd78}.dfe-reply-missing{background:#372d1d;color:#dfbd78}.dfe-icon-button:hover,.dfe-tab:hover{background:#252e38}}",
      "html[data-theme='dark'] .dfe-overlay,body[data-theme='dark'] .dfe-overlay,html.dark .dfe-overlay{--dfe-bg:#151a21;--dfe-card:#1c232c;--dfe-card2:#202933;--dfe-ink:#e7edf5;--dfe-ink2:#aab5c3;--dfe-ink3:#748191;--dfe-line:#2b3541;--dfe-accent:#4eb29a;--dfe-accent-soft:#18382f;--dfe-shadow:0 18px 60px rgba(0,0,0,.5)}",
      "body[data-ds-dark-theme] .dfe-overlay{--dfe-bg:#151a21;--dfe-card:#1c232c;--dfe-card2:#202933;--dfe-ink:#e7edf5;--dfe-ink2:#aab5c3;--dfe-ink3:#748191;--dfe-line:#2b3541;--dfe-accent:#4eb29a;--dfe-accent-soft:#18382f;--dfe-shadow:0 18px 60px rgba(0,0,0,.5)}",
      "body[data-ds-dark-theme] .dfe-brand-fish{background:#1d322f;border-color:#2b4a43}",
      "body[data-ds-dark-theme] .dfe-status-dot,body[data-ds-dark-theme] .dfe-status-dot.is-muted{background:#748191}",
      "body[data-ds-dark-theme] .dfe-tab.is-active,body[data-ds-dark-theme] .dfe-axis-picker button.is-active{color:#85cdb7}",
      "body[data-ds-dark-theme] .dfe-body-line{background:rgba(255,255,255,.035)}",
      "body[data-ds-dark-theme] .dfe-chip.is-feeling{background:#202d49;border-color:#2b3c61;color:#9db8ef}",
      "body[data-ds-dark-theme] .dfe-chip.is-extreme{background:#3b2522;border-color:#57322d;color:#efaaa0}",
      "body[data-ds-dark-theme] .dfe-chip.is-event{background:#2d2940;border-color:#403852;color:#c2b3e8}",
      "body[data-ds-dark-theme] .dfe-chip.is-warn{background:#372d1d;border-color:#55442a;color:#dfbd78}",
      "body[data-ds-dark-theme] .dfe-chip.is-good,body[data-ds-dark-theme] .dfe-chip.is-up{background:#1d342d;border-color:#2e4c41;color:#85cdb7}",
      "body[data-ds-dark-theme] .dfe-chip.is-down{background:#392426;border-color:#563235;color:#e9a1a5}",
      "body[data-ds-dark-theme] .dfe-flow-step.is-bad .dfe-flow-index{background:#392426;color:#e9a1a5}",
      "body[data-ds-dark-theme] .dfe-flow-step.is-warn .dfe-flow-index{background:#372d1d;color:#dfbd78}",
      "body[data-ds-dark-theme] .dfe-quote.is-warm{background:#29251d;border-left-color:#8c7144}",
      "body[data-ds-dark-theme] .dfe-message.is-her .dfe-bubble{background:#19332c;border-color:#2a4a40}",
      "body[data-ds-dark-theme] .dfe-badge.is-ok{background:#1d342d;color:#85cdb7}",
      "body[data-ds-dark-theme] .dfe-badge.is-bad{background:#392426;color:#e9a1a5}",
      "body[data-ds-dark-theme] .dfe-badge.is-warn{background:#372d1d;color:#dfbd78}",
      "body[data-ds-dark-theme] .dfe-badge.is-muted{background:#252d36;color:#94a2b3}",
      "body[data-ds-dark-theme] .dfe-axis-track,body[data-ds-dark-theme] .dfe-soft-track{background:#2b333d}",
      "body[data-ds-dark-theme] .dfe-axis-center{background:#566575}",
      "body[data-ds-dark-theme] .dfe-axis-dot{background:#1c232c;border-color:#91a4bb}",
      "body[data-ds-dark-theme] .dfe-axis-table th{border-color:#2b3541}",
      "body[data-ds-dark-theme] .dfe-axis-table td.is-up{color:#85cdb7}",
      "body[data-ds-dark-theme] .dfe-axis-table td.is-down{color:#e9a1a5}",
      "body[data-ds-dark-theme] .dfe-chart-grid{stroke:#313c48}",
      "body[data-ds-dark-theme] .dfe-chart-dot{fill:#1c232c}",
      "body[data-ds-dark-theme] .dfe-offline{background:#382d19;border-color:#564528;color:#e1bd78}",
      "body[data-ds-dark-theme] .dfe-offline button{background:#211c15;border-color:#5d4b2e;color:#e1bd78}",
      "body[data-ds-dark-theme] .dfe-warning{background:#382d19;border-color:#564528;color:#e1bd78}",
      "body[data-ds-dark-theme] .dfe-reply-missing{background:#372d1d;color:#dfbd78}",
      "@media (max-width:760px){.dfe-header-label{display:none}.dfe-drawer{width:calc(100vw - 24px)}.dfe-overlay.is-expanded .dfe-drawer{width:calc(100vw - 24px)}}",
      ".dfe-overlay{--dfe-accent:#df7fa7;--dfe-accent-soft:#fff0f5;--dfe-aqua-strong:#f49dbc;--dfe-glass-edge:rgba(218,137,168,.18);--dfe-card-lift:0 12px 32px rgba(146,94,123,.105),inset 0 1px 0 rgba(255,255,255,.98);--dfe-deep-shadow:-24px 0 76px rgba(67,49,91,.23);--dfe-cute-cream:#fffaf8;--dfe-cute-berry:#5d4058}",
      ".dfe-drawer{width:min(520px,calc(100vw - 44px));border-left:1px solid rgba(255,193,215,.42);border-radius:28px 0 0 28px;isolation:isolate;background:var(--dfe-cute-cream);box-shadow:var(--dfe-deep-shadow)}.dfe-overlay.is-expanded .dfe-drawer{width:min(820px,calc(100vw - 72px))}",
      ".dfe-drawer::before{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(circle at 102% 8%,rgba(255,177,204,.17),transparent 27%),radial-gradient(circle at -8% 88%,rgba(129,169,232,.14),transparent 31%),radial-gradient(circle at 82% 52%,rgba(255,255,255,.42),transparent 20%)}.dfe-drawer>*{position:relative;z-index:1}",
      ".dfe-drawer-head{position:relative;min-height:82px;padding:18px 18px 16px 20px;overflow:hidden;border-bottom:1px solid rgba(255,212,226,.54);background:radial-gradient(circle at 14% -28%,rgba(255,255,255,.62),transparent 37%),radial-gradient(circle at 92% 16%,rgba(255,206,225,.4),transparent 34%),linear-gradient(122deg,#596dbb 0%,#8587d2 48%,#e69ab8 100%);box-shadow:0 5px 18px rgba(112,78,133,.15),inset 0 -1px 0 rgba(255,255,255,.12)}",
      ".dfe-drawer-head::before{content:'';position:absolute;right:-52px;top:-86px;width:250px;height:250px;border:1px solid rgba(255,255,255,.25);border-radius:50%;box-shadow:0 0 0 23px rgba(255,255,255,.07),0 0 0 50px rgba(255,255,255,.045);pointer-events:none}.dfe-drawer-head::after{content:'';position:absolute;left:20px;right:20px;bottom:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.75),rgba(255,211,229,.7),transparent);pointer-events:none}",
      ".dfe-brand{position:relative;z-index:1;gap:12px}.dfe-brand-fish{width:45px;height:45px;border:2px solid rgba(255,255,255,.92);border-radius:50%;background:radial-gradient(circle at 34% 24%,#fff 0%,#fff5f8 40%,#ffd9e7 100%);box-shadow:0 0 0 5px rgba(255,255,255,.13),0 8px 20px rgba(88,58,112,.2);font-size:23px;transform:rotate(-4deg)}.dfe-brand h2{color:#fffdfd;font-size:18px;font-weight:800;letter-spacing:.035em;text-shadow:0 2px 8px rgba(79,49,98,.22)}.dfe-brand-sub{margin-top:6px;color:rgba(255,248,251,.9);font-size:11.7px}",
      ".dfe-head-tools{position:relative;z-index:1;gap:5px}.dfe-icon-button{width:33px;height:33px;border:1px solid rgba(255,255,255,.29);border-radius:50%;background:rgba(255,255,255,.16);color:#fffafd;box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}.dfe-icon-button:hover{background:rgba(255,255,255,.28);border-color:rgba(255,255,255,.54);color:#fff}.dfe-icon-button.is-close:hover{background:rgba(255,126,164,.3);border-color:rgba(255,217,229,.52)}",
      ".dfe-tabs{grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:10px 14px 13px;border-bottom:1px solid rgba(222,157,181,.24);background:linear-gradient(180deg,#fff3f7,#fffaf9)}.dfe-tab{height:37px;border:1px solid rgba(213,151,175,.17);border-radius:999px;background:rgba(255,255,255,.72);color:#786374;font-size:12.2px;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 2px 7px rgba(142,94,123,.035);transition:transform .16s ease,background .16s ease,color .16s ease,border-color .16s ease,box-shadow .16s ease}.dfe-tab:hover{transform:translateY(-1px) rotate(-.3deg);border-color:rgba(226,132,169,.34);background:#fff;color:#9b5576;box-shadow:0 5px 13px rgba(176,105,137,.11)}.dfe-tab.is-active{border-color:rgba(255,255,255,.9);color:#fff;background:linear-gradient(135deg,#ff9fc1,#e994c1 45%,#a89ae2);box-shadow:0 6px 15px rgba(211,116,157,.24),inset 0 1px 0 rgba(255,255,255,.38);transform:translateY(-1px)}",
      ".dfe-content{padding:16px 15px 24px;background:radial-gradient(circle at 92% 4%,rgba(255,176,204,.17),transparent 27%),radial-gradient(circle at 3% 34%,rgba(138,175,235,.12),transparent 24%),radial-gradient(circle at 96% 76%,rgba(178,157,226,.1),transparent 26%),linear-gradient(180deg,#fffaf8,#fff6fa)}.dfe-content::-webkit-scrollbar{width:10px}.dfe-content::-webkit-scrollbar-track{background:transparent}.dfe-content::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background:rgba(225,131,168,.34);background-clip:padding-box}",
      ".dfe-card{position:relative;overflow:hidden;padding:17px;border:1px solid rgba(224,158,183,.2);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.97),rgba(255,247,250,.94));box-shadow:0 10px 28px rgba(151,101,128,.09),inset 0 1px 0 #fff}.dfe-card::after{content:'';position:absolute;right:-20px;top:-42px;width:165px;height:125px;border-radius:50%;background:radial-gradient(ellipse,rgba(255,176,204,.16),transparent 69%);pointer-events:none}.dfe-card>*{position:relative;z-index:1}",
      ".dfe-card-head{gap:9px;margin-bottom:14px}.dfe-card-head::before{content:'';width:8px;height:8px;flex:none;border-radius:50%;background:linear-gradient(145deg,#ff9fc1,#ef83b1);box-shadow:0 0 0 3px rgba(255,159,193,.12),0 2px 5px rgba(208,101,148,.18)}.dfe-card-head h3{color:var(--dfe-cute-berry);font-size:13.4px;font-weight:800;letter-spacing:.035em}.dfe-card-head>span{font-size:10.8px;color:#a08494}",
      ".dfe-now-card{border-color:rgba(245,150,184,.27);background:radial-gradient(circle at 106% -8%,rgba(255,183,207,.28),transparent 37%),radial-gradient(circle at -7% 110%,rgba(165,181,239,.15),transparent 32%),linear-gradient(145deg,#fffefd,#fff3f8);box-shadow:0 14px 34px rgba(195,116,149,.12),inset 0 1px 0 #fff}.dfe-now-card::before{content:'♡';position:absolute;right:17px;top:-18px;color:rgba(232,128,169,.1);font:132px/1 Georgia,serif;transform:rotate(8deg);pointer-events:none}",
      ".dfe-activity-line{font-size:15.5px;color:#573f54}.dfe-body-line{border-color:rgba(235,172,195,.26);border-left:3px solid #f09ab9;border-radius:8px 14px 14px 8px;background:rgba(255,249,251,.92);color:#6a5265}.dfe-spirit-top b{color:#5e4057}.dfe-spirit-top em{background:#fff0f5;color:#b15c82}.dfe-soft-track{border-color:rgba(227,159,184,.2);background:#faeaf1}.dfe-soft-track i{background:linear-gradient(90deg,#ffb1cb,#ef8fb3 57%,#a79ce3)}",
      ".dfe-chip{border-radius:999px;font-weight:600}.dfe-chip.is-feeling{background:#fff0f6;border-color:#f6c6d9;color:#a44f76}.dfe-chip.is-extreme{background:#fff0ed;border-color:#f5cdc7;color:#bd625e}.dfe-chip.is-event{background:#f2effd;border-color:#ded6f6;color:#765fa8}.dfe-chip.is-warn{background:#fff7df;border-color:#f0dfac;color:#9b721f}.dfe-chip.is-good,.dfe-chip.is-up{background:#eefaf5;border-color:#ceeade;color:#32806b}.dfe-chip.is-down{background:#fff0f2;border-color:#f1d4da;color:#b55c6b}.dfe-chip.is-muted{background:#f8f3f6;border-color:#ebdfe5;color:#a58b98}",
      ".dfe-axis-grid{gap:10px}.dfe-axis-card{border-radius:17px;border-color:rgba(224,157,181,.19);box-shadow:inset 0 1px 0 rgba(255,255,255,.94),0 4px 13px rgba(152,99,126,.045)}.dfe-axis-card:nth-child(1){background:linear-gradient(145deg,#fff1f6,#fffafd)}.dfe-axis-card:nth-child(2){background:linear-gradient(145deg,#edf5ff,#fafdff)}.dfe-axis-card:nth-child(3){background:linear-gradient(145deg,#fff1f0,#fffaf9)}.dfe-axis-card:nth-child(4){background:linear-gradient(145deg,#f4efff,#fdfaff)}.dfe-axis-card:nth-child(5){background:linear-gradient(145deg,#fff5e9,#fffbf6)}.dfe-axis-card:nth-child(6){background:linear-gradient(145deg,#ecfaf6,#f9fffd)}",
      ".dfe-axis-top span{color:#907989}.dfe-axis-top strong{color:#5b4055}.dfe-axis-label{color:#573e52}.dfe-axis-track{border-color:rgba(226,164,187,.2);background:#f9eaf0}.dfe-axis-center{background:rgba(152,112,131,.28)}.dfe-axis-dot{border-color:#e58eb0;background:#fff;box-shadow:0 1px 6px rgba(194,105,143,.28)}.dfe-axis-note{color:#9a8190}",
      ".dfe-flow-index{border-radius:50%;background:linear-gradient(145deg,#fff3f7,#f1f3ff);color:#b06a89}.dfe-flow-body h4{color:#5c4055}.dfe-flow-step{border-bottom-color:rgba(226,168,188,.2)}.dfe-quote{border-left:3px solid #efb0c7;border-radius:0 13px 13px 0;background:#fffafc}.dfe-quote.is-warm{border-left-color:#eca4bc;background:linear-gradient(90deg,#fff2f7,#fffafd)}.dfe-quote.is-neutral{border-left-color:#bdcce9;background:#f8fbff}.dfe-quote-label{color:#a48392}",
      ".dfe-round details{border-color:rgba(225,165,187,.2);background:#fffdfd}.dfe-message.is-user .dfe-bubble{border-color:#d9e6fa;border-top-left-radius:5px;background:linear-gradient(135deg,#f1f7ff,#fbfdff);color:#526476}.dfe-message.is-her .dfe-bubble{border-color:#f3cbdc;border-top-right-radius:5px;background:linear-gradient(135deg,#fff0f6,#fff9fc);color:#694b60}.dfe-inner-details,.dfe-list-item{border-color:rgba(226,169,190,.2);background:#fffafc}",
      ".dfe-segment{border-color:rgba(225,163,187,.22);background:#fbf0f5}.dfe-axis-picker button{border-color:rgba(223,159,183,.2);background:#fffafc;color:#8a6d7d}.dfe-axis-picker button.is-active{border-color:#efabc3;background:linear-gradient(135deg,#fff0f5,#f4f0ff);color:#a14f77}.dfe-chart-card{border-color:rgba(223,159,183,.2);background:linear-gradient(160deg,#fff6fa,#f9fbff)}.dfe-chart-grid{stroke:#eadde6}.dfe-chart-dot{stroke:#e78fae;fill:#fff}",
      ".dfe-kv{background:linear-gradient(145deg,#fff8fb,#fbfbff);border:1px solid rgba(228,172,192,.16)}.dfe-health{background:linear-gradient(145deg,#fff7fa,#f9fbff);border:1px solid rgba(228,172,192,.15)}.dfe-drawer-foot{border-top:1px solid rgba(237,170,194,.26);background:linear-gradient(90deg,#fff0f6,#f8f5ff);color:#aa8999}",
      ".dfe-header-button{border-color:rgba(218,145,176,.22);background:linear-gradient(135deg,#fff5f9,#eef3ff);color:#865b74}.dfe-header-button:hover,.dfe-header-button.is-active{border-color:rgba(226,132,169,.4);background:linear-gradient(135deg,#ffeaf3,#edf2ff);color:#a34f77}@keyframes dfe-fish-float{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-7px) rotate(2deg)}}.dfe-loading span{animation:dfe-fish-float 2.4s ease-in-out infinite}",
      "@media (max-width:760px){.dfe-drawer,.dfe-overlay.is-expanded .dfe-drawer{width:calc(100vw - 18px);border-radius:18px 0 0 18px}.dfe-drawer-head{min-height:72px;padding:15px 14px 14px 16px}.dfe-brand h2{font-size:15.5px}.dfe-brand-fish{width:38px;height:38px;font-size:20px}.dfe-tabs{gap:5px;padding:8px 10px 10px}.dfe-tab{height:34px;font-size:11.5px}.dfe-content{padding:12px 11px 18px}.dfe-card{padding:14px;border-radius:16px}}",
      "@media (prefers-color-scheme:dark){.dfe-overlay{--dfe-accent:#ff9fc1;--dfe-accent-soft:#3c2937;--dfe-aqua-strong:#ff9fc1;--dfe-glass-edge:rgba(255,155,190,.15);--dfe-card-lift:0 12px 32px rgba(0,0,0,.21),inset 0 1px 0 rgba(255,255,255,.04);--dfe-deep-shadow:-24px 0 80px rgba(0,0,0,.52)}.dfe-drawer-head{background:radial-gradient(circle at 14% -28%,rgba(255,255,255,.13),transparent 37%),radial-gradient(circle at 92% 16%,rgba(255,160,195,.15),transparent 34%),linear-gradient(122deg,#28264d,#4c457a 52%,#835b78)}.dfe-tabs{background:linear-gradient(180deg,#2c263d,#33283f);border-bottom-color:rgba(255,155,190,.15)}.dfe-tab{border-color:rgba(255,183,210,.11);background:rgba(255,255,255,.04);color:#d4bac8}.dfe-tab.is-active{background:linear-gradient(135deg,#d978a2,#9b87d3);color:#fff}.dfe-content{background:radial-gradient(circle at 92% 4%,rgba(255,137,180,.1),transparent 27%),radial-gradient(circle at 3% 34%,rgba(122,154,225,.08),transparent 24%),linear-gradient(180deg,#221e2b,#271e2a)}.dfe-card{background:linear-gradient(145deg,rgba(45,38,51,.97),rgba(38,32,46,.94));border-color:rgba(255,153,189,.14)}.dfe-axis-card{background:linear-gradient(145deg,#352b3b,#2c2938)}.dfe-quote,.dfe-inner-details,.dfe-round details,.dfe-list-item{background:#302735;border-color:rgba(255,157,192,.12)}.dfe-message.is-user .dfe-bubble{background:#25303e;border-color:#34475c;color:#dbe7f5}.dfe-message.is-her .dfe-bubble{background:#3b2936;border-color:#55394a;color:#ffeaf3}.dfe-drawer-foot{background:linear-gradient(90deg,#2c2432,#30283f);color:#c7a8b7}.dfe-card-head h3,.dfe-axis-top strong,.dfe-axis-label,.dfe-activity-line,.dfe-spirit-top b,.dfe-flow-body h4{color:#f5dce8}.dfe-card-head>span,.dfe-axis-top span,.dfe-axis-note,.dfe-quote-label,.dfe-mini-title{color:#c7a9b8}.dfe-body-line{background:rgba(56,42,53,.74);color:#f0d5e1}}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-overlay{--dfe-accent:#ff9fc1;--dfe-accent-soft:#3c2937;--dfe-aqua-strong:#ff9fc1;--dfe-glass-edge:rgba(255,155,190,.15);--dfe-card-lift:0 12px 32px rgba(0,0,0,.21),inset 0 1px 0 rgba(255,255,255,.04);--dfe-deep-shadow:-24px 0 80px rgba(0,0,0,.52)}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-drawer-head{background:radial-gradient(circle at 14% -28%,rgba(255,255,255,.13),transparent 37%),radial-gradient(circle at 92% 16%,rgba(255,160,195,.15),transparent 34%),linear-gradient(122deg,#28264d,#4c457a 52%,#835b78)}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-tabs{background:linear-gradient(180deg,#2c263d,#33283f);border-bottom-color:rgba(255,155,190,.15)}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-tab{background:rgba(255,255,255,.04);border-color:rgba(255,183,210,.11);color:#d4bac8}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-tab.is-active{background:linear-gradient(135deg,#d978a2,#9b87d3);color:#fff}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-content{background:radial-gradient(circle at 92% 4%,rgba(255,137,180,.1),transparent 27%),radial-gradient(circle at 3% 34%,rgba(122,154,225,.08),transparent 24%),linear-gradient(180deg,#221e2b,#271e2a)}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-card{background:linear-gradient(145deg,rgba(45,38,51,.97),rgba(38,32,46,.94));border-color:rgba(255,153,189,.14)}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-axis-card{background:linear-gradient(145deg,#352b3b,#2c2938)}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-quote,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-inner-details,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-round details,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-list-item{background:#302735;border-color:rgba(255,157,192,.12)}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-message.is-user .dfe-bubble{background:#25303e;border-color:#34475c;color:#dbe7f5}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-message.is-her .dfe-bubble{background:#3b2936;border-color:#55394a;color:#ffeaf3}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-drawer-foot{background:linear-gradient(90deg,#2c2432,#30283f);color:#c7a8b7}",
      ":is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-card-head h3,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-axis-top strong,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-axis-label,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-activity-line,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-spirit-top b,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-flow-body h4{color:#f5dce8}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-card-head>span,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-axis-top span,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-axis-note,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-quote-label,:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-mini-title{color:#c7a9b8}:is(html[data-theme='dark'],body[data-theme='dark'],html.dark,body[data-ds-dark-theme]) .dfe-body-line{background:rgba(56,42,53,.74);color:#f0d5e1}",
      ".dfe-drawer{width:min(360px,calc(100vw - 24px));height:min(548px,calc(100vh - 24px));margin:12px 12px 12px 0;align-self:flex-start;border:1px solid rgba(255,193,215,.42);border-radius:26px;transition:width .2s ease,height .2s ease,border-radius .2s ease}",
      ".dfe-overlay.is-expanded .dfe-drawer{width:min(820px,calc(100vw - 72px));height:calc(100vh - 24px);margin:12px 12px 12px 0;border-radius:24px}",
      ".dfe-brand h2{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      "@media (max-width:760px){.dfe-drawer,.dfe-overlay.is-expanded .dfe-drawer{width:calc(100vw - 18px);height:calc(100vh - 18px);margin:9px;border-radius:18px}}",
    ].join("\n");

    var inject = ["slots"];

    function apply(ctx) {
      var style = document.createElement("style");
      style.setAttribute("data-dsh-fishpet-emotion", "1");
      style.textContent = CSS;
      document.head.append(style);
      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          return function () { style.remove(); };
        });
      }
      ctx.slots.inject("plugins.detail.section", function () {
        return ctx.slots.register({
          name: "plugins.detail.section",
          id: "dsh-fishpet-emotion:desktop-download",
          order: 90,
          label: "完整桌面皮套",
        }, PluginDownloadSection);
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-fishpet-emotion:drawer",
          order: 75,
        }, function FishPetOverlay() {
          return h(React.Fragment, null, h(SetupGuide), h(Drawer));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
