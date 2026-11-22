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
    var base = { completed: {}, quiz: {}, goals: {}, notes: {}, theme: null, last: null };
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
    DATA.modules.forEach(function (m) {
      if (!m.chapters.length) return;
      var done = m.chapters.filter(function (n) { return state.completed[n]; }).length;
      html += '<div class="nav-mod"><div class="nav-modtitle"><span>' + esc(m.title) +
        '</span><span class="nav-modprog">' + done + "/" + m.chapters.length + "</span></div>";
      m.chapters.forEach(function (n) {
        var c = BY_NUM[n];
        var cls = "nav-ch" + (state.completed[n] ? " done" : "") + (current && current.num === n ? " active" : "");
        var tier = tierOf(n);
        var dot = tier === "core" ? '<i class="dot core"></i>' : (tier === "ref" ? '<i class="dot ref"></i>' : "");
        html += '<a class="' + cls + '" href="#/ch/' + n + '" data-num="' + n + '"><span class="n">' + dot + String(n) +
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

  function renderHome() {
    var done = doneCount();
    var coreDone = CORE_ORDER.filter(function (n) { return state.completed[n]; }).length;
    var coreMin = CORE_ORDER.reduce(function (a, n) { return a + BY_NUM[n].minutes; }, 0);
    var startNum = firstIncompleteIn(CORE_ORDER.concat([0, 1]));
    var startChapter = BY_NUM[startNum] || CHAPTERS[0];

    var html = '<div class="hero">';
    html += '<div class="kicker">openai-agents-python · v' + esc(DATA.version) + " · 33 章</div>";
    html += "<h1>先读 11 章，<br/>够用 90%</h1>";
    html += '<p class="lead">33 章里真正决定成败的，不是"会调 API"，而是<strong>能不能审住 agent 写出来的东西</strong>：' +
      "终止条件、上下文边界、审批断点、排错抓手。其余章节按需速查即可。</p>";
    html += '<div class="hero-actions">';
    html += '<a class="btn primary" href="#/ch/' + startChapter.num + '">' + (coreDone ? "继续必读路径 · 第" + startChapter.num + "章" : "从第 2 章开始（前置 2 章 + 必读 9 章）") + "</a>";
    html += '<a class="btn" href="#/all">浏览全部 33 章</a>';
    html += '<a class="btn" href="#/resources">原始资料</a>';
    html += "</div>";

    html += '<div class="pathbar"><div class="pb-top"><span>必读路径进度</span><span class="pb-num">' + coreDone + " / " + CORE_ORDER.length + "</span></div>" +
      '<div class="progressbig"><i style="width:' + Math.round((coreDone / CORE_ORDER.length) * 100) + '%"></i></div>' +
      '<div class="note">路径总时长约 ' + Math.round(coreMin / 60) + " 小时；剩下 " + (TOTAL - done) + " 章未完成（全课程）。</div></div>";

    html += '<div class="decider" id="decider">' +
      '<div class="d-title">先判断你该读到哪一层</div>' +
      '<div class="d-q" data-q="1"><span>你负责把 Agent 代码上线吗？</span>' +
      '<button data-v="y" type="button">负责</button><button data-v="n" type="button">不负责</button></div>' +
      '<div class="d-q" data-q="2"><span>只做"单 Agent + 少量工具"的轻场景？</span>' +
      '<button data-v="y" type="button">是</button><button data-v="n" type="button">不是</button></div>' +
      '<div class="d-q" data-q="3"><span>遇到 SDK 行为异常，团队里有人读源码吗？</span>' +
      '<button data-v="y" type="button">有</button><button data-v="n" type="button">没有</button></div>' +
      '<div class="d-result" id="dResult">选完三项，给出你的最短路径。</div>' +
      "</div>";

    html += '<div class="h2">必读路径 <span class="h2sub">前置 2 + 判断力 9</span></div>';
    html += '<div class="pathlist">';
    CORE_ORDER.forEach(function (n) { html += pathCard(n); });
    html += "</div>";

    html += '<div class="h2">速查 <span class="h2sub">让 agent 写，你核签名</span></div>';
    html += '<div class="chiprow">';
    [7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 32].forEach(function (n) {
      html += '<a class="chapchip" href="#/ch/' + n + '"><span>' + n + " " + esc(BY_NUM[n].title) + "</span><em>" + esc(whyOf(n)) + "</em></a>";
    });
    html += "</div>";

    html += '<div class="h2">按需 / 后置</div>';
    html += '<div class="chiprow small">';
    [13, 25, 26, 27, 28, 29, 30, 31].forEach(function (n) {
      var t = tierOf(n);
      html += '<a class="chapchip ' + t + '" href="#/ch/' + n + '"><span>' + n + " " + esc(BY_NUM[n].title) + '</span><em>' + TIER_LABEL[t] + " · " + esc(whyOf(n)) + "</em></a>";
    });
    html += "</div>";

    html += '<div class="h2">全部章节</div>';
    html += '<div class="modgrid">';
    DATA.modules.forEach(function (m) {
      if (!m.chapters.length) return;
      var d = m.chapters.filter(function (n) { return state.completed[n]; }).length;
      var p = Math.round((d / m.chapters.length) * 100);
      html += '<a class="modcard" href="#/ch/' + m.chapters[0] + '">';
      html += '<div class="mt"><span>' + esc(m.title) + '</span><span class="chip">' + d + "/" + m.chapters.length + "</span></div>";
      html += '<div class="ms">' + esc(m.sub) + "</div>";
      html += '<div class="mp"><i style="width:' + p + '%"></i></div>';
      html += '<div class="mv">' + p + "% 完成</div></a>";
    });
    html += "</div>";

    html += '<div class="tools" style="margin-top:26px">';
    html += '<button class="btn" id="exportBtn" type="button">导出学习记录</button>';
    html += '<button class="btn" id="resetBtn" type="button">重置进度</button>';
    html += '<button class="btn" id="helpBtn" type="button">快捷键</button>';
    html += "</div>";
    html += '<div class="note">数据只保存在这台机器的浏览器里（localStorage），不会上传。</div>';
    html += "</div>";

    $("#view").innerHTML = html;
    $("#toc").innerHTML = "";
    $("#chapterNav").hidden = true;
    window.scrollTo({ top: 0 });
    setReadbar(0);

    $("#exportBtn").addEventListener("click", exportProgress);
    $("#helpBtn").addEventListener("click", showHelp);
    $("#resetBtn").addEventListener("click", function () {
      if (!confirm("确定要清空完成进度、自测成绩与笔记吗？此操作不可撤销。")) return;
      state = { completed: {}, quiz: {}, goals: {}, notes: {}, theme: state.theme, last: null };
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
