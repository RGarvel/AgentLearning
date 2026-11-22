(function () {
  "use strict";

  var DATA = window.COURSE;
  var CHAPTERS = DATA.chapters;
  var QUIZZES = DATA.quizzes || {};
  var BY_NUM = {};
  CHAPTERS.forEach(function (c) { BY_NUM[c.num] = c; });
  var TOTAL = CHAPTERS.length;
  var RESOURCES = [
    { t: "上游仓库", d: "openai-agents-python 源码与全部文档", u: "https://github.com/openai/openai-agents-python" },
    { t: "官方文档总览", d: "docs/index.md · 功能与选型", u: "https://github.com/openai/openai-agents-python/blob/main/docs/index.md" },
    { t: "快速开始", d: "docs/quickstart.md", u: "https://github.com/openai/openai-agents-python/blob/main/docs/quickstart.md" },
    { t: "可运行示例", d: "examples/ 下的完整项目", u: "https://github.com/openai/openai-agents-python/tree/main/examples" },
    { t: "变更日志", d: "CHANGELOG.md · 版本演进", u: "https://github.com/openai/openai-agents-python/blob/main/CHANGELOG.md" },
    { t: "Release 页面", d: "v0.25.0 发布说明", u: "https://github.com/openai/openai-agents-python/releases" },
    { t: "MCP 规范", d: "Model Context Protocol", u: "https://modelcontextprotocol.io" },
    { t: "Pydantic 文档", d: "工具参数与结构化输出", u: "https://docs.pydantic.dev" },
  ];
  var KEY = "oa-course-v1";

  var state = load();
  var searchIndex = null;

  function load() {
    var base = { completed: {}, quiz: {}, goals: {}, notes: {}, checks: {}, theme: null, last: null };
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return base;
      var obj = JSON.parse(raw);
      return Object.assign(base, obj);
    } catch (e) { return base; }
  }
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    }, 200);
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  var toastEl = $("#toast");
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  /* ---------------- theme ---------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    state.theme = theme;
    save();
  }
  function initTheme() {
    var t = state.theme;
    if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
  }
  $("#themeBtn").addEventListener("click", function () {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  /* ---------------- sidebar ---------------- */
  function doneCount() { return Object.keys(state.completed).filter(function (k) { return state.completed[k]; }).length; }

  function renderNav() {
    var nav = $("#nav");
    var html = "";
    ROLE_GROUPS.forEach(function (g) {
      if (!g.chapters.length) return;
      var done = g.chapters.filter(function (n) { return state.completed[n]; }).length;
      html += '<div class="nav-mod"><div class="nav-modtitle"><span>' + esc(g.title) +
        '</span><span class="nav-modprog">' + done + "/" + g.chapters.length + "</span></div>";
      g.chapters.forEach(function (n) {
        var c = BY_NUM[n];
        var cls = "nav-ch" + (state.completed[n] ? " done" : "") + (current && current.num === n ? " active" : "");
        html += '<a class="' + cls + '" href="#/ch/' + n + '" data-num="' + n + '"><span class="n">' + String(n) +
          '</span><span class="t">' + esc(c.title) + "</span></a>";
      });
      html += "</div>";
    });
    nav.innerHTML = html;
  }

  function updateNavActive() {
    $$(".nav-ch").forEach(function (a) {
      var n = Number(a.getAttribute("data-num"));
      a.classList.toggle("active", !!(current && current.num === n));
      a.classList.toggle("done", !!state.completed[n]);
    });
    var pill = $("#progressPill");
    if (pill) pill.textContent = doneCount() + " / " + TOTAL;
    $$(".nav-mod").forEach(function () {});
  }

  /* ---------------- router ---------------- */
  var current = null;

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    if (!h) return { view: "home" };
    if (h === "about") return { view: "about" };
    if (h === "resources") return { view: "resources" };
    if (h === "all") return { view: "all" };
    if (h === "learn") return { view: "learn" };
    if (h === "manual") return { view: "manual" };
    if (h === "review") return { view: "review" };
    var m = h.match(/^ch\/(\d+)(?:~(.+))?$/);
    if (m) return { view: "chapter", num: Number(m[1]), anchor: m[2] ? decodeURIComponent(m[2]) : null };
    return { view: "home" };
  }

  function onRoute() {
    var r = parseHash();
    if (r.view === "chapter" && BY_NUM[r.num]) {
      current = BY_NUM[r.num];
      state.last = r.num;
      save();
      renderChapter(current, r.anchor);
    } else if (r.view === "learn") {
      current = null;
      renderLearn();
    } else if (r.view === "manual") {
      current = null;
      renderManual();
    } else if (r.view === "review") {
      current = null;
      renderReview();
    } else if (r.view === "all") {
      current = null;
      renderAll();
    } else if (r.view === "resources") {
      current = null;
      renderResources();
    } else if (r.view === "about") {
      current = null;
      renderAbout();
    } else {
      current = null;
      renderHome();
    }
    renderNav();
    updateNavActive();
    closeSidebar();
  }

  /* ---------------- home ---------------- */
  /* 章节定位：core=必读判断力，prereq=前置，ref=速查，optional=按需，later=后置 */
  var TIERS = {
    "0": ["prereq", "10 分钟：知道这门课怎么用就行"],
    "1": ["prereq", "建立“Agent=模型+指令+工具+循环”的心智模型"],
    "2": ["prereq", "跑通环境；版本与依赖的坑都在这里"],
    "3": ["prereq", "看懂 Agent 的字段，才能看懂第 4 章"],
    "4": ["core", "循环没有终止条件，就会“能跑但烧钱”"],
    "5": ["core", "不会看 items，就不知道它第 7 轮为什么跑偏"],
    "6": ["core", "context 划错边界，系统就没法测、没法多租户"],
    "7": ["ref", "让 agent 写，你只核对签名与错误回填"],
    "8": ["ref", "托管工具的能力边界与计费，用时查"],
    "9": ["ref", "MCP 的传输、生命周期与审批，用时查"],
    "10": ["ref", "作 manager 编排时的参数表"],
    "11": ["ref", "判断该用 handoff 还是 as_tool"],
    "12": ["ref", "交接过滤与历史裁剪，改路由时查"],
    "13": ["optional", "要让 agent 真改仓库/跑命令时再读"],
    "14": ["core", "护栏要在哪一层断、断完怎么回话"],
    "15": ["core", "危险工具必须先过审批，agent 不会替你想"],
    "16": ["core", "断点放哪、恢复时状态怎么对齐，只能人设计"],
    "17": ["ref", "会话实现细节，接存储时查"],
    "18": ["ref", "跨轮状态策略选型，架构评审时用"],
    "19": ["ref", "换模型/换供应商时查"],
    "20": ["ref", "结构化输出的 strict 限制，用时查"],
    "21": ["ref", "做流式 UI 时查事件类型"],
    "22": ["core", "review agent 写的 agent，trace 是唯一抓手"],
    "23": ["core", "没有回归，改一句 prompt 都是掷骰子"],
    "24": ["core", "报错速查与最小复现，决定排障速度"],
    "25": ["optional", "做语音产品再读"],
    "26": ["optional", "做实时语音对话再读"],
    "27": ["optional", "要改 SDK 或判断“这是不是 bug”时读"],
    "28": ["optional", "要逐行理解运行循环时读"],
    "29": ["optional", "要做生产级重试与兜底时读"],
    "30": ["later", "等你要落地完整系统时，让 agent 生成更贴合"],
    "31": ["later", "同上；评估闭环可以后补"],
    "32": ["ref", "参数速查表，贴在手边"],
  };
  var TIER_LABEL = { core: "必读", prereq: "前置", ref: "速查", optional: "按需", later: "后置" };
  var CORE_ORDER = [2, 3, 4, 5, 6, 14, 15, 16, 22, 23, 24];
  function tierOf(n) { return (TIERS[String(n)] || ["ref", ""])[0]; }
  function whyOf(n) { return (TIERS[String(n)] || ["ref", ""])[1]; }

  function pathCard(n) {
    var c = BY_NUM[n];
    var done = !!state.completed[n];
    var tier = tierOf(n);
    return '<a class="pathcard' + (done ? " done" : "") + '" href="#/ch/' + n + '">' +
      '<span class="pc-n">' + String(n).padStart(2, "0") + "</span>" +
      '<span class="pc-main"><span class="pc-t">' + esc(c.title) + "</span>" +
      '<span class="pc-w">' + esc(whyOf(n)) + "</span></span>" +
      '<span class="pc-m">' + c.minutes + ' 分</span>' +
      '<span class="tier t-' + tier + '">' + TIER_LABEL[tier] + "</span></a>";
  }

  function doorCard(href, kicker, title, desc, meta) {
    return '<a class="door" href="' + href + '"><div class="d-k">' + esc(kicker) + '</div><div class="d-t">' + esc(title) +
      '</div><div class="d-d">' + esc(desc) + '</div><div class="d-m">' + esc(meta) + "</div></a>";
  }

  function renderHome() {
    var done = doneCount();
    var coreDone = CORE_ORDER.filter(function (n) { return state.completed[n]; }).length;
    var next = firstIncompleteIn(CORE_ORDER);
    var checkTotal = allChecks().length;
    var checkDone = checkedCount();

    var html = '<div class="hero">';
    html += '<div class="kicker">openai-agents-python · v' + esc(DATA.version) + " · 33 章重组为三种用法</div>";
    html += "<h1>能审住 agent 写的代码，<br/>比会写它更值钱</h1>";
    html += '<p class="lead">模型几秒就能生成带 handoff 和 guardrail 的代码，但它不承担上线后的失败。' +
      "这门课按“拿来干什么”重新切成三块：<strong>精读判断力、查手册、过评审</strong>。</p>";
    html += '<div class="hero-actions">';
    html += '<a class="btn primary" href="#/learn">' + (coreDone ? "继续主线 · " + coreDone + "/" + CORE_ORDER.length : "开始 11 章主线") + "</a>";
    html += '<a class="btn" href="#/review">评审清单（' + checkTotal + ' 项）</a>';
    html += '<a class="btn" href="#/manual">手册</a>';
    html += "</div></div>";

    html += '<div class="doors">';
    html += doorCard("#/learn", "01 · 精读", "主线 11 章", "循环会不会停、上下文边界在哪、危险操作在哪断、出事靠什么查。每章一个验收点。", coreDone + " / " + CORE_ORDER.length + " 已完成");
    html += doorCard("#/manual", "02 · 查", "手册 12 章", "参数、机制、配置。让 agent 写，你只核对签名与边界；卡住了按关键词搜。", "不当书读");
    html += doorCard("#/review", "03 · 审", "评审 30 项", "阻断级 18 项 + 建议 12 项，配 10 个真实事故。可以导出成 Markdown 贴进 PR。", checkDone + " / " + checkTotal + " 已勾选");
    html += "</div>";

    html += '<div class="why"><div class="why-t">为什么这样排</div>' +
      '<div class="why-i"><b>1</b>API 记忆会折旧：能查就别背，手册只保留“用完即查”的索引。</div>' +
      '<div class="why-i"><b>2</b>责任不会折旧：终止条件、审批断点、trace 抓手是模型不替你承担的。</div>' +
      '<div class="why-i"><b>3</b>版本会骗人：0.25 的新参数（如 handoff 的 failure_error_function）模型常常写成旧版，主线里保留了“版本真相”。</div></div>';

    html += '<div class="decider" id="decider"><div class="d-title">先判断你该读到哪一层</div>' +
      '<div class="d-q" data-q="1"><span>你负责把 Agent 代码上线吗？</span><button data-v="y" type="button">负责</button><button data-v="n" type="button">不负责</button></div>' +
      '<div class="d-q" data-q="2"><span>只做“单 Agent + 少量工具”的轻场景？</span><button data-v="y" type="button">是</button><button data-v="n" type="button">不是</button></div>' +
      '<div class="d-q" data-q="3"><span>遇到 SDK 行为异常，团队里有人读源码吗？</span><button data-v="y" type="button">有</button><button data-v="n" type="button">没有</button></div>' +
      '<div class="d-result" id="dResult">选完三项，给出你的最短路径。</div></div>';

    html += '<div class="tools" style="margin-top:8px">';
    html += '<a class="btn" href="#/all">全部 33 章</a>';
    html += '<a class="btn" href="#/resources">原始资料</a>';
    html += '<button class="btn" id="exportBtn" type="button">导出学习记录</button>';
    html += '<button class="btn" id="resetBtn" type="button">重置进度</button>';
    html += '<button class="btn" id="helpBtn" type="button">快捷键</button>';
    html += "</div>";
    html += '<div class="note">数据只保存在这台机器的浏览器里（localStorage），不会上传。</div>';

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);

    $("#exportBtn").addEventListener("click", exportProgress);
    $("#helpBtn").addEventListener("click", showHelp);
    $("#resetBtn").addEventListener("click", function () {
      if (!confirm("确定要清空完成进度、自测成绩、笔记与评审勾选吗？此操作不可撤销。")) return;
      state = { completed: {}, quiz: {}, goals: {}, notes: {}, checks: {}, theme: state.theme, last: null };
      save();
      onRoute();
      toast("已重置");
    });
    bindDecider();
  }

  function firstIncompleteIn(list) {
    for (var i = 0; i < list.length; i++) if (!state.completed[list[i]]) return list[i];
    return list[0];
  }

  function bindDecider() {
    var answers = {};
    var result = $("#dResult");
    var labels = {
      1: { y: "负责上线", n: "不负责上线" },
      2: { y: "单 Agent 轻场景", n: "多 Agent / 复杂流程" },
      3: { y: "有人读源码", n: "没人读源码" },
    };
    function decide() {
      if (Object.keys(answers).length < 3) return;
      var text;
      if (answers[1] === "n") {
        text = "结论：别系统学。把课程当故障手册——先扫第 0–2 章，之后踩坑再按章查。你的收益不在“读懂”，而在“查得到”。";
      } else if (answers[2] === "y") {
        text = "结论：走必读路径 11 章（前置 2 章 + 判断力 9 章），速查表贴手边。项目章 30–31 等有真实需求再读，别为了“学完”而读。";
      } else {
        text = "结论：必读 11 章之外，加读第 11、12、18 章（编排与状态策略），因为多 Agent 的失败模式只能靠设计兜住。";
      }
      if (answers[1] === "y" && answers[3] === "n") {
        text += " 另外：团队没人读源码，就把第 27–29 章当作“判断 bug 还是用错”的保险，至少通读一遍。";
      }
      result.textContent = text;
      result.classList.add("on");
    }
    $$("#decider .d-q").forEach(function (row) {
      row.querySelectorAll("button").forEach(function (btn) {
        btn.addEventListener("click", function () {
          row.querySelectorAll("button").forEach(function (b) { b.classList.remove("on"); });
          btn.classList.add("on");
          answers[Number(row.getAttribute("data-q"))] = btn.getAttribute("data-v");
          decide();
        });
      });
    });
  }

  function firstIncomplete() {
    for (var i = 0; i < CHAPTERS.length; i++) if (!state.completed[CHAPTERS[i].num]) return CHAPTERS[i].num;
    return CHAPTERS[0].num;
  }

  function exportProgress() {
    var lines = ["# OpenAI Agents SDK 研读营 · 学习记录", "", "导出时间：" + new Date().toLocaleString(), ""];
    lines.push("完成章节：" + doneCount() + " / " + TOTAL);
    DATA.modules.forEach(function (m) {
      lines.push("", "## " + m.title);
      m.chapters.forEach(function (n) {
        var c = BY_NUM[n];
        var q = state.quiz[n];
        var qs = q ? " · 自测 " + q.best + "/" + q.total : "";
        lines.push("- [" + (state.completed[n] ? "x" : " ") + "] 第" + n + "章 " + c.title + qs);
        var note = (state.notes[n] || "").trim();
        if (note) lines.push("  - 笔记：" + note.replace(/\n/g, " "));
      });
    });
    var blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agents-sdk-course-progress.md";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast("已导出 Markdown");
  }

  function showHelp() {
    toast("快捷键：/ 搜索 · j 下一章 · k 上一章 · t 主题 · Esc 关闭");
  }

  /* ================= course structure & review kit ================= */
  var ROLE_GROUPS = [
    { id: "main", title: "主线 · 判断力", sub: "精读，决定你能不能审住 agent 的产出", chapters: [2, 3, 4, 5, 6, 14, 15, 16, 22, 23, 24] },
    { id: "manual", title: "手册 · 用时查", sub: "参数与机制速查，不按顺序读", chapters: [7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 32] },
    { id: "asneeded", title: "按需 · 做才读", sub: "语音、沙箱、源码深潜", chapters: [13, 25, 26, 27, 28, 29] },
    { id: "later", title: "后置 · 有项目再读", sub: "实战与评估闭环，agent 能生成更贴合的版本", chapters: [30, 31] },
    { id: "intro", title: "导入", sub: "十分钟知道这门课怎么用", chapters: [0, 1] },
  ];

  var CHECKLIST = [
    { cat: "终止与预算", items: [
      { id: "t1", sev: "blocker", t: "每次 Runner.run 都显式传了 max_turns", why: "默认 10 轮并不意味着安全，模型反复调工具时会一路烧到上限。", ch: [4] },
      { id: "t2", sev: "blocker", t: "工具调用有超时（@tool(timeout=...) 或外层超时）", why: "一个卡死的工具会让整个 run 挂住，前面的预算控制全部失效。", ch: [7, 29] },
      { id: "t3", sev: "should", t: "有 token / 费用上限或熔断，而不只是事后看账单", why: "Usage 能统计，但没人会在事故发生时盯它；需要有自动止损。", ch: [19, 22] },
      { id: "t4", sev: "should", t: "循环有“进展信号”，不是换皮死循环", why: "每轮必须产生新信息（新工具结果、新状态），否则就是在重复同一轮。", ch: [4, 5] },
      { id: "t5", sev: "blocker", t: "重试是 opt-in，且只用于幂等请求", why: "0.25 的通用模型重试默认关闭；盲目打开会让有副作用的请求重放。", ch: [29] },
    ]},
    { cat: "上下文与状态", items: [
      { id: "c1", sev: "blocker", t: "本地 context 与对话历史分开：依赖走 RunContextWrapper.context", why: "业务对象塞进 prompt 会污染模型输入，也让多轮历史失控。", ch: [6] },
      { id: "c2", sev: "blocker", t: "context 里没有密钥 / PII，或已确认 trace 不落敏感字段", why: "trace 默认记录工具入参与输出，敏感数据会一起进后端。", ch: [6, 22] },
      { id: "c3", sev: "blocker", t: "多用户场景 session_id 按用户隔离", why: "复用 session_id 等于让 A 读到 B 的历史，这是最典型的越权。", ch: [17] },
      { id: "c4", sev: "should", t: "RunState 快照留在服务端，不交给前端回传", why: "from_json 不校验来源，客户端可以改工具名、参数、审批记录。", ch: [16] },
      { id: "c5", sev: "should", t: "长对话有裁剪 / 压缩策略", why: "无限增长的历史最终会撞上窗口上限，或让成本线性上涨。", ch: [17, 18] },
    ]},
    { cat: "工具与副作用", items: [
      { id: "k1", sev: "blocker", t: "破坏性工具（退款/删除/发信）要求 needs_approval 或工具护栏", why: "模型天生乐观，不会主动为不可逆操作加闸门。", ch: [15] },
      { id: "k2", sev: "blocker", t: "工具失败策略是明确的：话术回填还是抛异常", why: "默认 failure_error_function 会把异常变成一句文案，模型可能顺势编造成功。", ch: [7, 15] },
      { id: "k3", sev: "should", t: "写操作有幂等键，重试与审批重放不会重复执行", why: "恢复、重试、审批三条路径都可能让同一个调用执行两次。", ch: [16, 30] },
      { id: "k4", sev: "should", t: "MCP server 用最小权限凭据，敏感工具配了 require_approval", why: "远端 server 拿到什么凭据，就等于模型能做什么。", ch: [9] },
      { id: "k5", sev: "should", t: "工具返回内容不会被当成指令直接执行", why: "网页、文档、第三方 API 的返回都可能夹带注入。", ch: [14] },
    ]},
    { cat: "护栏与人审", items: [
      { id: "g1", sev: "blocker", t: "输入护栏与输出护栏至少各有一条", why: "护栏不是过滤器，是断路器：它要在越界时中断，而不是劝说模型。", ch: [14] },
      { id: "g2", sev: "blocker", t: "tripwire 触发被捕获，并有用户可读的话术", why: "不捕获就是 500，用户只看到服务挂了。", ch: [14] },
      { id: "g3", sev: "should", t: "输出护栏覆盖“工具直出即最终输出”的路径", why: "tool_use_behavior 让工具结果绕过模型时，输出护栏仍是最后一道闸。", ch: [14, 10] },
      { id: "g4", sev: "blocker", t: "审批断点在工具执行前，拒绝后模型能继续而不是重试同一操作", why: "错误的断点位置会把“拒绝”变成“再来一次”。", ch: [15, 16] },
      { id: "g5", sev: "should", t: "审批决策有审计记录（谁、何时、对哪个 call_id）", why: "出事后只有审批记录能还原“谁放行了这一步”。", ch: [16] },
    ]},
    { cat: "可观测与回归", items: [
      { id: "o1", sev: "blocker", t: "tracing 默认开启，且生产有可查询的导出后端", why: "review agent 写的 agent，trace 是唯一抓手。", ch: [22] },
      { id: "o2", sev: "should", t: "业务主键进了 trace_metadata（订单号 / trace_id）", why: "没有业务键，线上一次失败对不上任何一条记录。", ch: [22] },
      { id: "o3", sev: "blocker", t: "有确定性测试（ScriptedModel）覆盖工具与护栏路径", why: "真模型不可复现，回归必须跑在替身上。", ch: [23] },
      { id: "o4", sev: "should", t: "有固定问题集的评估，改 prompt 前后能对比", why: "否则每次改动都是掷骰子，只是骰子变贵了。", ch: [23, 31] },
      { id: "o5", sev: "should", t: "日志里带 run_id / trace_id，能和代码里的调用对上", why: "排障的第一步是把日志和一次具体运行对齐。", ch: [24] },
    ]},
    { cat: "交付与演进", items: [
      { id: "d1", sev: "blocker", t: "模型与 SDK 版本被固定，升级有回归路径", why: "0.25 这类快速迭代的库，模型和 SDK 都会悄悄改变行为。", ch: [2, 19] },
      { id: "d2", sev: "should", t: "全局错误处理覆盖 max_turns / refusal / invalid output", why: "这三类失败不是异常，是运行结束状态，容易漏掉。", ch: [4, 29] },
      { id: "d3", sev: "should", t: "提示词与工具描述进版本库，改动可评审", why: "prompt 就是代码，不进库等于线上不可回滚。", ch: [23] },
      { id: "d4", sev: "should", t: "有降级方案：模型不可用或超时时返回什么", why: "没有降级，模型抖动就直接变成用户可见故障。", ch: [29] },
      { id: "d5", sev: "should", t: "有升级预案：先做契约 diff 再升级", why: "released_api_contract.json 能告诉你公开 API 到底变没变。", ch: [2, 19] },
    ]},
  ];

  var FAILURES = [
    { t: "循环停不下来，账单暴涨", s: "单次请求跑了几十轮，工具被反复调用", c: "没设 max_turns，或 tool_choice 被强制要求调用", f: "显式 max_turns + 进展信号 + 成本熔断", ch: 4 },
    { t: "工具报错，模型却说“已成功”", s: "外部 API 500，回复却是“退款已办理”", c: "默认 failure_error_function 把异常换成了一句模糊文案", f: "明确失败策略：关键路径传 None 抛异常，其余自定义话术", ch: 7 },
    { t: "第二轮上下文翻倍", s: "每轮 token 数翻倍增长", c: "同时用 session 和 result.to_input_list() 喂历史", f: "二选一：要么 SDK 管历史，要么手管，别叠加", ch: 18 },
    { t: "用户 A 看到用户 B 的历史", s: "换账号后出现别人的对话", c: "session_id 写死或复用了全局值", f: "session_id 按租户/用户隔离，服务端鉴权后再取", ch: 17 },
    { t: "审批通过后重复退款", s: "同一笔退款执行了两次", c: "恢复执行时没有幂等键，重放了工具调用", f: "写操作带幂等键，审批记录与执行结果绑定", ch: 16 },
    { t: "线上偶发失败无法复现", s: "用户投诉答非所问，日志里只有一句 MaxTurnsExceeded", c: "tracing 被关或敏感数据被裁剪到无法还原", f: "打开 tracing，敏感字段做脱敏但不丢结构", ch: 22 },
    { t: "护栏拦住了，但接口 500", s: "内容被拦截时前端只看到服务异常", c: "没有捕获 tripwire 异常", f: "捕获 InputGuardrailTripwireTriggered / OutputGuardrailTripwireTriggered 并回话术", ch: 14 },
    { t: "交接后风格突变、上下文丢失", s: "转到专家 agent 后忘了前面说过什么", c: "handoff input_filter 把关键历史过滤掉了", f: "检查 input_filter 与嵌套历史设置", ch: 12 },
    { t: "换模型后工具不调用", s: "同一个 agent 换供应商后不再调用工具", c: "Chat Completions 通道对 strict schema / 工具选择支持不同", f: "核对通道能力，必要时 strict_feature_validation", ch: 19 },
    { t: "MCP 工具调错", s: "两个 server 有同名工具，总是命中错的那个", c: "没开 include_server_in_tool_names，工具名冲突", f: "开启服务名前缀，或改工具命名策略", ch: 9 },
  ];

  /* ---------------- all chapters ---------------- */
  function renderAll() {
    var html = '<div class="hero small"><div class="kicker">全部章节</div><h1>33 章，按模块</h1>' +
      '<p class="lead">带 <span class="tier t-core">必读</span> 标记的是判断力章节；其余按需查阅。也可以用顶部搜索直接找概念。</p>' +
      '<div class="hero-actions"><a class="btn primary" href="#/">回到学习路径</a><a class="btn" href="#/resources">原始资料</a></div></div>';

    DATA.modules.forEach(function (m) {
      if (!m.chapters.length) return;
      html += '<div class="allmod"><div class="refmodt">' + esc(m.title) + '</div>';
      m.chapters.forEach(function (n) {
        var c = BY_NUM[n];
        var t = tierOf(n);
        html += '<a class="allrow' + (state.completed[n] ? " done" : "") + '" href="#/ch/' + n + '">' +
          '<span class="ar-n">' + String(n).padStart(2, "0") + "</span>" +
          '<span class="ar-t">' + esc(c.title) + "</span>" +
          '<span class="ar-w">' + esc(whyOf(n)) + "</span>" +
          '<span class="tier t-' + t + '">' + TIER_LABEL[t] + "</span></a>";
      });
      html += "</div>";
    });

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);
  }

  /* ---------------- learn / manual / review ---------------- */
  function allChecks() {
    var out = [];
    CHECKLIST.forEach(function (g) { g.items.forEach(function (it) { out.push(it); }); });
    return out;
  }
  function checkedCount() {
    return allChecks().filter(function (it) { return state.checks && state.checks[it.id]; }).length;
  }

  function renderLearn() {
    var groups = [
      { t: "前置：先能跑、先看懂", nums: [2, 3] },
      { t: "第一关：循环与上下文", nums: [4, 5, 6], note: "读完你能回答：这个循环会不会停？上下文边界在哪？" },
      { t: "第二关：防线", nums: [14, 15, 16], note: "读完你能回答：危险操作在哪断？拒绝之后怎么恢复？" },
      { t: "第三关：抓手", nums: [22, 23, 24], note: "读完你能回答：线上出事，我靠什么定位、靠什么回归？" },
    ];
    var done = CORE_ORDER.filter(function (n) { return state.completed[n]; }).length;
    var mins = CORE_ORDER.reduce(function (a, n) { return a + BY_NUM[n].minutes; }, 0);
    var next = firstIncompleteIn(CORE_ORDER);
    var html = '<div class="hero small"><div class="kicker">主线 · 判断力</div><h1>11 章，把“审”的能力建起来</h1>' +
      '<p class="lead">这 11 章不是 API 教学，是 review 训练：每章结尾都有一个“你能判断什么”的验收点。其余章节进手册，用时再查。</p>' +
      '<div class="hero-actions"><a class="btn primary" href="#/ch/' + next + '">' + (done ? "继续 · 第" + next + "章" : "从第 2 章开始") + "</a>" +
      '<a class="btn" href="#/review">去评审清单</a><a class="btn" href="#/manual">打开手册</a></div>' +
      '<div class="pathbar"><div class="pb-top"><span>主线进度</span><span class="pb-num">' + done + " / " + CORE_ORDER.length + "</span></div>" +
      '<div class="progressbig"><i style="width:' + Math.round((done / CORE_ORDER.length) * 100) + '%"></i></div>' +
      '<div class="note">总时长约 ' + Math.round(mins / 60) + " 小时。读完主线，再按项目需要去手册里查具体 API。</div></div></div>";

    groups.forEach(function (g) {
      html += '<div class="learnpart"><div class="lp-t">' + esc(g.t) + "</div>";
      if (g.note) html += '<div class="lp-n">' + esc(g.note) + "</div>";
      g.nums.forEach(function (n) { html += pathCard(n); });
      html += "</div>";
    });

    html += '<div class="learnfoot"><a class="btn primary" href="#/review">下一步：用评审清单过一遍你手上的代码</a>' +
      '<a class="btn" href="#/manual">需要查 API 时打开手册</a></div>';

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);
  }

  function renderManual() {
    var nums = ROLE_GROUPS.filter(function (g) { return g.id === "manual"; })[0].chapters;
    var html = '<div class="hero small"><div class="kicker">手册 · 用时查</div><h1>12 章，不当书读</h1>' +
      '<p class="lead">这些是参数、机制与配置。让 agent 写，你只核对签名和边界；卡住了按关键词搜。</p>' +
      '<div class="hero-actions"><a class="btn primary" href="#/review">评审清单</a><a class="btn" href="#/all">全部 33 章</a></div></div>';
    html += '<div class="refbar"><input id="manFilter" class="reffilter" type="search" placeholder="查：handoff / MCP / 流式 / 结构化输出 / session …" autocomplete="off" /></div>';
    html += '<div id="manList" class="mangrid">';
    nums.forEach(function (n) {
      var c = BY_NUM[n];
      html += '<a class="mancard" data-k="' + esc((c.title + " " + whyOf(n)).toLowerCase()) + '" href="#/ch/' + n + '">' +
        '<div class="mn">' + n + '</div><div class="mm"><div class="mt2">' + esc(c.title) + '</div>' +
        '<div class="mw">' + esc(whyOf(n)) + '</div></div><div class="mk">' + c.minutes + " 分</div></a>";
    });
    html += "</div>";

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);

    var input = $("#manFilter");
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      $$(".mancard").forEach(function (card) {
        card.style.display = !q || (card.getAttribute("data-k") || "").indexOf(q) >= 0 ? "" : "none";
      });
    });
  }

  function renderReview() {
    var totals = allChecks().length;
    var checkedNow = checkedCount();
    var blockers = allChecks().filter(function (it) { return it.sev === "blocker"; }).length;
    var html = '<div class="hero small"><div class="kicker">评审 · 上线前</div><h1>审 agent 写的代码，而不是重写它</h1>' +
      '<p class="lead">' + totals + " 项检查（" + blockers + " 项阻断级），来自课程里最常出事的地方。勾选状态存在本地，可导出成 Markdown 贴进 PR。</p></div>";

    html += '<div class="pathbar"><div class="pb-top"><span>检查进度</span><span class="pb-num">' + checkedNow + " / " + totals + "</span></div>" +
      '<div class="progressbig"><i style="width:' + Math.round((checkedNow / totals) * 100) + '%"></i></div>' +
      '<div class="note">阻断项未过，不建议上线；should 项按风险接受度处理。</div></div>';

    html += '<div class="tools" style="margin:0 0 18px"><button class="btn" id="exportChecks" type="button">导出检查结果</button>' +
      '<button class="btn" id="clearChecks" type="button">清空勾选</button></div>';

    CHECKLIST.forEach(function (g, gi) {
      html += '<div class="ckgroup"><div class="ck-t">' + esc(g.cat) + "</div>";
      g.items.forEach(function (it) {
        var on = !!(state.checks && state.checks[it.id]);
        html += '<label class="ck' + (on ? " on" : "") + '" data-id="' + it.id + '">' +
          '<input type="checkbox" data-check="' + it.id + '"' + (on ? " checked" : "") + " />" +
          '<span class="ck-body"><span class="ck-line"><span class="sev ' + it.sev + '">' + (it.sev === "blocker" ? "阻断" : "建议") + "</span>" + esc(it.t) + "</span>" +
          '<span class="ck-why">' + esc(it.why) + "</span>" +
          '<span class="ck-ch">' + it.ch.map(function (n) { return '<a href="#/ch/' + n + '">第' + n + "章</a>"; }).join(" · ") + "</span></span></label>";
      });
      html += "</div>";
    });

    html += '<div class="h2">常见事故 <span class="h2sub">症状 → 根因 → 修法</span></div>';
    html += '<div class="failgrid">';
    FAILURES.forEach(function (f) {
      html += '<div class="fail"><div class="f-t">' + esc(f.t) + '</div>' +
        '<div class="f-r"><b>症状</b>' + esc(f.s) + "</div>" +
        '<div class="f-r"><b>根因</b>' + esc(f.c) + "</div>" +
        '<div class="f-r fix"><b>修法</b>' + esc(f.f) + "</div>" +
        '<a class="f-ch" href="#/ch/' + f.ch + '">第' + f.ch + "章 →</a></div>";
    });
    html += "</div>";

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);

    $$("input[data-check]").forEach(function (box) {
      box.addEventListener("change", function () {
        var id = box.getAttribute("data-check");
        state.checks = state.checks || {};
        if (box.checked) state.checks[id] = true; else delete state.checks[id];
        save();
        box.closest(".ck").classList.toggle("on", box.checked);
        var c = checkedCount();
        $("#progressPill").textContent = doneCount() + " / " + TOTAL;
        var bar = $(".pathbar .progressbig i");
        if (bar) bar.style.width = Math.round((c / totals) * 100) + "%";
        var num = $(".pathbar .pb-num");
        if (num) num.textContent = c + " / " + totals;
      });
    });

    $("#exportChecks").addEventListener("click", function () {
      var lines = ["# Agent 上线前评审清单", "", "导出时间：" + new Date().toLocaleString(), ""];
      CHECKLIST.forEach(function (g) {
        lines.push("## " + g.cat);
        g.items.forEach(function (it) {
          var on = !!(state.checks && state.checks[it.id]);
          lines.push("- [" + (on ? "x" : " ") + "] " + (it.sev === "blocker" ? "[阻断] " : "[建议] ") + it.t);
        });
        lines.push("");
      });
      var blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "agent-review-checklist.md";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast("已导出检查结果");
    });
    $("#clearChecks").addEventListener("click", function () {
      if (!confirm("清空全部勾选？")) return;
      state.checks = {};
      save();
      renderReview();
      toast("已清空");
    });
  }

  /* ---------------- references ---------------- */
  var REF_LABEL = { doc: "文档", example: "示例", src: "源码", other: "其他" };

  function refLink(r, wide) {
    var cls = "ref" + (wide ? " wide" : "");
    return '<a class="' + cls + '" href="' + esc(r.url) + '" target="_blank" rel="noopener" title="' + esc(r.path) + '">' +
      '<span class="rk rk-' + r.kind + '">' + REF_LABEL[r.kind] + "</span>" +
      '<span class="rp">' + esc(r.path) + "</span>" +
      '<span class="rx">↗</span></a>';
  }

  function refsInlineHtml(c) {
    var html = '<details class="refs-inline"><summary>本章原始资料 <span class="cnt">' + c.refs.length +
      ' 个上游文件</span></summary><div class="reflist wide">';
    c.refs.forEach(function (r) { html += refLink(r, true); });
    html += '</div><a class="more" href="#/resources">查看全部原始资料 →</a></details>';
    return html;
  }

  function refsRailHtml(c) {
    if (!c.refs || !c.refs.length) return "";
    var html = '<div class="railrefs"><h4>原始资料 <span>' + c.refs.length + '</span></h4><div class="reflist rail">';
    c.refs.forEach(function (r) { html += refLink(r, false); });
    html += '</div><a class="railmore" href="#/resources">全部资料 →</a></div>';
    return html;
  }

  function renderResources() {
    var totalRefs = 0, uniq = {};
    CHAPTERS.forEach(function (c) {
      (c.refs || []).forEach(function (r) { totalRefs++; uniq[r.path] = 1; });
    });
    var uniqCount = Object.keys(uniq).length;

    var html = '<div class="hero small"><div class="kicker">原始资料库</div><h1>每个结论都能溯源</h1>' +
      '<p class="lead">全书引用 <b>' + totalRefs + "</b> 处、<b>" + uniqCount +
      "</b> 个上游文件（文档 / 示例 / 源码）。按章节列出，点击直达 GitHub 原文。</p></div>";

    html += '<div class="resgrid">';
    RESOURCES.forEach(function (g) {
      html += '<a class="rescard" href="' + esc(g.u) + '" target="_blank" rel="noopener"><div class="rst">' +
        esc(g.t) + '<span class="rx">↗</span></div><div class="rsd">' + esc(g.d) + "</div></a>";
    });
    html += "</div>";

    html += '<div class="h2">按章节查看</div>';
    html += '<div class="refbar"><input id="refFilter" class="reffilter" type="search" placeholder="过滤路径或关键词：tools / memory / guardrail …" autocomplete="off" aria-label="过滤原始资料" /><span id="refCount" class="refcount">33 章</span></div>';
    html += '<div id="refIndex" class="refindex">';

    DATA.modules.forEach(function (m) {
      if (!m.chapters.length) return;
      html += '<div class="refmod"><div class="refmodt">' + esc(m.title) + "</div>";
      m.chapters.forEach(function (n) {
        var c = BY_NUM[n];
        var refs = c.refs || [];
        var paths = refs.map(function (r) { return r.path.toLowerCase(); }).join(" ");
        html += '<details class="refch" data-paths="' + esc(paths) + '"><summary><span class="rn">第' + n +
          '章</span><span class="rt">' + esc(c.title) + '</span><span class="rc">' + refs.length + "</span></summary><div class=\"reflist wide\">";
        refs.forEach(function (r) { html += refLink(r, true); });
        html += "</div></details>";
      });
      html += "</div>";
    });
    html += "</div>";

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);

    var input = $("#refFilter");
    var countEl = $("#refCount");
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      $$(".refch").forEach(function (d) {
        var hit = !q || (d.getAttribute("data-paths") || "").indexOf(q) >= 0;
        d.style.display = hit ? "" : "none";
        if (hit) shown++;
        if (q) d.open = hit;
      });
      $$(".refmod").forEach(function (m) {
        var any = $$(".refch", m).some(function (d) { return d.style.display !== "none"; });
        m.style.display = any ? "" : "none";
      });
      countEl.textContent = q ? shown + " / 33 章" : "33 章";
    });
  }

  /* ---------------- about ---------------- */
  function renderAbout() {
    var done = doneCount();
    var html = '<div class="hero"><div class="kicker">关于本课程</div>';
    html += '<h1 style="font-size:30px">一套能对照源码学的 Agent 课程</h1>';
    html += '<p class="lead">内容基于 <a href="https://github.com/openai/openai-agents-python" target="_blank" rel="noopener">openai/openai-agents-python</a> v' + esc(DATA.version) + '，' +
      '由 33 章讲义自动构建；所有 API 结论都能在仓库对应文件里找到出处。</p></div>';
    html += '<div class="h2">版本与更新</div>';
    html += '<ul class="prose" style="padding-left:22px">';
    html += '<li><strong>当前基线</strong>：0.25.0（2026-11-17 发布）。上一版 0.24.0。</li>';
    html += '<li><strong>0.25.0 要点</strong>：新增 <code>agents.memory</code> 会话适配器工具（<code>await_session_mutation</code> / <code>coerce_session_settings</code> / <code>resolve_session_limit</code>）；handoff 支持 <code>failure_error_function</code>；生成 span 记录工具定义；<code>Model.get_default_model_settings()</code> 钩子。</li>';
    html += '<li>课程同步记录见讲义目录的 <code>版本与更新记录.md</code>。</li>';
    html += '</ul>';
    html += '<div class="h2">怎么用这套课</div>';
    html += '<ul class="prose" style="padding-left:22px">';
    html += '<li>不想通读也没关系：首页给了「前置 2 + 必读 9」的最短路径，其余章节按需速查。</li>';
    html += '<li>每章先读正文，勾掉"学习目标"，再做 3 道自测；错题解析就在选项下方。</li>';
    html += '<li>代码块右上角可一键复制；所有示例对应教材第 2 章配置好的本地仓库。</li>';
    html += '<li>进度与笔记只存浏览器本地，可用首页按钮导出成 Markdown。</li>';
    html += '</ul>';
    html += '<div class="h2">快捷键</div>';
    html += '<div class="table-wrap"><table><tbody>';
    html += '<tr><td><kbd>/</kbd></td><td>聚焦搜索</td></tr>';
    html += '<tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>下一章 / 上一章</td></tr>';
    html += '<tr><td><kbd>t</kbd></td><td>切换明暗主题</td></tr>';
    html += '<tr><td><kbd>Esc</kbd></td><td>关闭搜索或侧栏</td></tr>';
    html += '<tr><td><kbd>?</kbd></td><td>提示快捷键</td></tr>';
    html += '</tbody></table></div>';
    html += '<div class="tools" style="margin-top:24px"><a class="btn primary" href="#/">返回首页</a>';
    html += '<a class="btn" href="#/ch/' + (state.last || 0) + '">继续上次阅读</a></div>';
    html += '<div class="note">已完成 ' + done + ' / ' + TOTAL + ' 章。本页面不发起任何网络请求。</div>';

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);
    renderNav();
    updateNavActive();
  }

  /* ---------------- chapter ---------------- */
  function stripFirstH1(html) { return html.replace(/^\s*<h1[\s\S]*?<\/h1>/, ""); }

  function renderChapter(c, anchor) {
    var view = $("#view");
    var goals = c.goals || [];
    var qs = QUIZZES[String(c.num)] || [];
    var done = !!state.completed[c.num];

    var html = '<div class="article"><div class="ch-head">';
    html += '<div class="crumbs"><a href="#/">课程首页</a> / ' + esc(c.moduleTitle) + "</div>";
    html += '<h1 class="ch-title">第' + c.num + "章 " + esc(c.title) + "</h1>";
    html += '<div class="ch-meta"><span class="chip accent">' + esc(c.moduleTitle) + "</span>";
    html += '<span class="chip">约 ' + c.minutes + " 分钟</span>";
    html += '<span class="chip">' + c.codeBlocks + " 个代码块</span>";
    if (qs.length) html += '<span class="chip">自测 ' + qs.length + " 题</span>";
    html += "</div>";
    var tierNow = tierOf(c.num);
    html += '<div class="chpos"><span class="tier t-' + tierNow + '">' + TIER_LABEL[tierNow] + "</span><span>" + esc(whyOf(c.num)) + "</span></div>";
    html += "</div>";

    if (goals.length) {
      html += '<div class="goals"><h3>学习目标</h3><div class="hint">读完一条就勾一条，勾选会保存。</div>';
      var g = state.goals[c.num] || [];
      goals.forEach(function (goal, i) {
        html += '<label class="goal' + (g[i] ? " checked" : "") + '"><input type="checkbox" data-goal="' + i + '"' + (g[i] ? " checked" : "") +
          " /><span>" + esc(goal) + "</span></label>";
      });
      html += "</div>";
    }

    html += '<div class="prose" id="prose">' + stripFirstH1(c.html) + "</div>";

    html += '<div class="tools">';
    html += '<button class="btn primary' + (done ? " done" : "") + '" id="doneBtn" type="button">' + (done ? "✓ 已完成（点击取消）" : "标记本章完成") + "</button>";
    html += '<button class="btn" id="printBtn" type="button">打印本章</button>';
    html += '<button class="btn" id="linkBtn" type="button">复制链接</button>';
    html += "</div>";

    if (qs.length) html += quizPlaceholder(c.num, qs.length);

    if (c.refs && c.refs.length) html += refsInlineHtml(c);

    html += '<details class="notes"><summary>我的笔记（自动保存，仅存本地）<span class="saved" id="noteSaved"></span></summary>' +
      '<textarea id="noteArea" placeholder="记下这一章对你最有用的三句话……"></textarea></details>';

    html += "</div>";

    view.innerHTML = html;
    $("#chapterNav").hidden = false;
    renderChapterNav(c);
    $("#toc").innerHTML = tocHtml(c) + refsRailHtml(c);
    renderQuiz(c.num, qs);
    bindChapter(c, goals, qs);
    setReadbar(0);
    if (anchor) {
      var target = document.getElementById(anchor);
      if (target) { target.scrollIntoView(); }
    } else {
      window.scrollTo({ top: 0 });
    }
    observeHeadings();
  }

  function tocHtml(c) {
    if (!c.toc || !c.toc.length) return "";
    var html = "<h4>本章目录</h4>";
    c.toc.forEach(function (t) {
      html += '<a href="#/ch/' + c.num + "~" + encodeURIComponent(t.id) + '" data-anchor="' + esc(t.id) + '" class="lv' + t.level + '">' + esc(t.text) + "</a>";
    });
    return html;
  }

  function renderChapterNav(c) {
    var idx = CHAPTERS.findIndex(function (x) { return x.num === c.num; });
    var prev = CHAPTERS[idx - 1], next = CHAPTERS[idx + 1];
    var html = "";
    html += prev ? '<a class="prev" href="#/ch/' + prev.num + '"><div class="dir">← 上一章</div><div class="t">第' + prev.num + "章 " + esc(prev.title) + "</div></a>" : "<span></span>";
    html += next ? '<a class="next" href="#/ch/' + next.num + '"><div class="dir">下一章 →</div><div class="t">第' + next.num + "章 " + esc(next.title) + "</div></a>" : "<span></span>";
    $("#chapterNav").innerHTML = html;
  }

  function bindChapter(c, goals, qs) {
    $$('input[data-goal]').forEach(function (box) {
      box.addEventListener("change", function () {
        var i = Number(box.getAttribute("data-goal"));
        var arr = state.goals[c.num] || [];
        arr[i] = box.checked;
        state.goals[c.num] = arr;
        box.parentElement.classList.toggle("checked", box.checked);
        save();
      });
    });

    var doneBtn = $("#doneBtn");
    doneBtn.addEventListener("click", function () {
      if (state.completed[c.num]) delete state.completed[c.num];
      else state.completed[c.num] = true;
      save();
      renderChapter(c, null);
      renderNav(); updateNavActive();
      toast(state.completed[c.num] ? "已标记完成" : "已取消完成");
    });

    $("#printBtn").addEventListener("click", function () { window.print(); });
    $("#linkBtn").addEventListener("click", function () {
      var url = location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast("链接已复制"); });
      else toast(url);
    });

    var area = $("#noteArea");
    area.value = state.notes[c.num] || "";
    var savedTag = $("#noteSaved");
    area.addEventListener("input", debounce(function () {
      state.notes[c.num] = area.value;
      save();
      savedTag.textContent = "已保存";
      setTimeout(function () { savedTag.textContent = ""; }, 1500);
    }, 350));

    $$("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var block = btn.closest(".codeblock");
        var code = block ? block.querySelector("code") : null;
        if (!code) return;
        var text = code.textContent;
        var ok = function () {
          btn.textContent = "已复制";
          btn.classList.add("copied");
          setTimeout(function () { btn.textContent = "复制"; btn.classList.remove("copied"); }, 1600);
        };
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(ok, ok);
        else ok();
      });
    });
  }

  /* ---------------- quiz ---------------- */
  function quizPlaceholder(num, count) {
    return '<section class="quiz" id="quiz" data-count="' + count + '"><div class="quiz-head"><h3>本章自测</h3>' +
      '<span class="sub" id="quizSub">0 / ' + count + " 已答</span></div>" +
      '<div class="quiz-body" id="quizBody"></div>' +
      '<div class="quiz-foot"><span id="quizScore">尚未作答</span><button class="btn" id="quizReset" type="button" style="margin-left:auto">重做</button></div></section>';
  }

  function renderQuiz(num, questions) {
    if (!questions.length) return;
    var key = String(num);
    var rec = state.quiz[key] || { answers: {}, best: 0, total: questions.length };
    if (!rec.answers) rec.answers = {};
    state.quiz[key] = rec;
    var body = $("#quizBody");

    function paint() {
      var html = "";
      questions.forEach(function (q, qi) {
        var answered = rec.answers[qi];
        var has = answered !== undefined && answered !== null;
        html += '<div class="q" data-q="' + qi + '">';
        var lvl = q.level || "medium";
        html += '<div class="q-title"><span class="lvl ' + lvl + '">' + lvl.toUpperCase() + "</span>" + esc(q.q) + "</div>";
        q.options.forEach(function (opt, oi) {
          var cls = "opt";
          if (has) {
            cls += " disabled";
            if (oi === q.answer) cls += " correct";
            else if (oi === answered) cls += " wrong";
          }
          html += '<div class="' + cls + '" role="button" tabindex="' + (has ? "-1" : "0") + '" data-opt="' + oi + '">' +
            '<span class="mark">' + (has ? (oi === q.answer ? "✓" : oi === answered ? "✕" : "") : "") + "</span><span>" + esc(opt) + "</span></div>";
        });
        if (has) html += '<div class="explain">' + (answered === q.answer ? "正确。" : "正确答案：「" + esc(q.options[q.answer]) + "」。") + " " + esc(q.explain || "") + "</div>";
        html += "</div>";
      });
      body.innerHTML = html;

      var answeredCount = Object.keys(rec.answers).length;
      var correct = 0;
      questions.forEach(function (q, i) { if (rec.answers[i] === q.answer) correct++; });
      $("#quizSub").textContent = answeredCount + " / " + questions.length + " 已答";
      $("#quizScore").innerHTML = answeredCount === 0 ? "尚未作答" :
        '得分 <span class="score">' + correct + " / " + questions.length + "</span>" + (answeredCount === questions.length ? (correct === questions.length ? " · 全对 🎉" : " · 可重做") : "");
      if (answeredCount === questions.length) {
        rec.best = Math.max(rec.best || 0, correct);
        rec.total = questions.length;
        save();
      }

      $$("[data-opt]", body).forEach(function (el) {
        el.addEventListener("click", function () {
          var qEl = el.closest(".q");
          var qi = Number(qEl.getAttribute("data-q"));
          if (rec.answers[qi] !== undefined) return;
          rec.answers[qi] = Number(el.getAttribute("data-opt"));
          save();
          paint();
        });
        el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } });
      });
    }

    $("#quizReset").addEventListener("click", function () {
      state.quiz[key] = { answers: {}, best: rec.best || 0, total: questions.length };
      renderQuiz(num, questions);
    });
    paint();
  }

  /* ---------------- toc + scroll ---------------- */
  var observer = null;
  function observeHeadings() {
    if (observer) observer.disconnect();
    var links = $$("#toc a");
    if (!links.length || !("IntersectionObserver" in window)) return;
    var map = {};
    links.forEach(function (a) { map[a.getAttribute("data-anchor")] = a; });
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove("active"); });
        var a = map[en.target.id];
        if (a) a.classList.add("active");
      });
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    $$("#prose h2, #prose h3").forEach(function (h) { observer.observe(h); });
  }

  function setReadbar(pct) { var bar = $("#readbar"); if (bar) bar.style.width = pct + "%"; }

  window.addEventListener("scroll", function () {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
    setReadbar(pct);
  }, { passive: true });

  /* ---------------- search ---------------- */
  function buildIndex() {
    if (searchIndex) return searchIndex;
    searchIndex = CHAPTERS.map(function (c) {
      return { num: c.num, title: c.title, module: c.moduleTitle, text: c.text, lower: (c.title + " " + c.text).toLowerCase() };
    });
    return searchIndex;
  }

  function doSearch(q) {
    q = q.trim().toLowerCase();
    var box = $("#searchResults");
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    var idx = buildIndex();
    var hits = [];
    idx.forEach(function (c) {
      var pos = c.lower.indexOf(q);
      if (pos < 0) return;
      var score = (c.title.toLowerCase().indexOf(q) >= 0 ? 10 : 0) + Math.min(5, c.text.toLowerCase().split(q).length - 1);
      hits.push({ c: c, score: score, pos: pos });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    hits = hits.slice(0, 8);
    if (!hits.length) { box.innerHTML = '<div class="sr-empty">没有找到「' + esc(q) + '」，试试更短的关键词。</div>'; box.hidden = false; return; }
    var html = "";
    hits.forEach(function (h) {
      var c = h.c;
      var tPos = c.text.toLowerCase().indexOf(q);
      var snip = "";
      if (tPos >= 0) {
        var start = Math.max(0, tPos - 26);
        snip = (start > 0 ? "…" : "") + c.text.slice(start, tPos + q.length + 54) + "…";
      }
      html += '<a class="sr-item" href="#/ch/' + c.num + '"><div class="sr-ch">' + esc(c.module) + " · 第" + c.num + '章</div><div class="sr-title">' +
        esc(c.title) + '</div><div class="sr-snip">' + esc(snip) + "</div></a>";
    });
    box.innerHTML = html;
    box.hidden = false;
  }

  var searchInput = $("#search");
  searchInput.addEventListener("input", debounce(function () { doSearch(searchInput.value); }, 90));
  searchInput.addEventListener("focus", function () { if (searchInput.value) doSearch(searchInput.value); });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { searchInput.value = ""; $("#searchResults").hidden = true; searchInput.blur(); }
    if (e.key === "Enter") {
      var first = $("#searchResults .sr-item");
      if (first) { location.hash = first.getAttribute("href"); $("#searchResults").hidden = true; searchInput.blur(); }
    }
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".searchwrap")) $("#searchResults").hidden = true;
    if (e.target.closest(".sr-item")) $("#searchResults").hidden = true;
  });

  /* ---------------- sidebar toggle ---------------- */
  var sidebar = $("#sidebar");
  function closeSidebar() { sidebar.classList.remove("open"); $("#backdrop").hidden = true; $("#menuBtn").setAttribute("aria-expanded", "false"); }
  $("#menuBtn").addEventListener("click", function () {
    var open = !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", open);
    $("#backdrop").hidden = !open;
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  });
  $("#backdrop").addEventListener("click", closeSidebar);

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "textarea" || e.target.isContentEditable;
    if (e.key === "Escape") { closeSidebar(); $("#searchResults").hidden = true; return; }
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); searchInput.focus(); return; }
    if (e.key === "?") { showHelp(); return; }
    if (e.key === "t") { $("#themeBtn").click(); return; }
    if (e.key === "j" || e.key === "k") {
      var idx = current ? CHAPTERS.findIndex(function (c) { return c.num === current.num; }) : -1;
      var next = idx + (e.key === "j" ? 1 : -1);
      if (next >= 0 && next < CHAPTERS.length) location.hash = "#/ch/" + CHAPTERS[next].num;
    }
  });

  window.addEventListener("hashchange", onRoute);

  /* ---------------- boot ---------------- */
  initTheme();
  renderNav();
  onRoute();
  updateNavActive();
})();
