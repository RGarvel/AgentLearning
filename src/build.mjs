import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import hljs from "highlight.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const COURSE = path.join(ROOT, "content");
const SHELL = path.join(HERE, "shell");
const QUIZZES = path.join(HERE, "quizzes");
const OUT = ROOT;

const MODULES = [
  { id: "00", title: "导论", sub: "建立心智模型：Agent 到底是什么" },
  { id: "01", title: "核心运行时", sub: "对象、循环、产物、上下文" },
  { id: "02", title: "工具系统", sub: "让 Agent 有手有脚" },
  { id: "03", title: "多智能体编排", sub: "handoff、协作模式、沙箱" },
  { id: "04", title: "安全与护栏", sub: "护栏、审批、中断恢复" },
  { id: "05", title: "状态与记忆", sub: "会话与跨轮策略" },
  { id: "06", title: "模型与输出", sub: "Provider、结构化输出、流式" },
  { id: "07", title: "可观测性与质量", sub: "追踪、测试、排错" },
  { id: "08", title: "语音与实时", sub: "语音流水线、Realtime" },
  { id: "09", title: "源码剖析", sub: "架构与运行循环精读" },
  { id: "10", title: "实战", sub: "两个项目 + 速查表" },
];

const LANG_MAP = {
  python: "python", py: "python", bash: "bash", sh: "bash", shell: "bash",
  json: "json", text: "plaintext", txt: "plaintext", powershell: "powershell",
  ps1: "powershell", sql: "sql", yaml: "yaml", typescript: "typescript", ts: "typescript",
  javascript: "javascript", js: "javascript", html: "xml", xml: "xml",
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripTags = (s) => s.replace(/<[^>]+>/g, "");
const slugify = (s) =>
  stripTags(s).trim().toLowerCase()
    .replace(/[\x60*_~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const usedIds = new Map();
function uniqueId(base) {
  let id = base || "section";
  if (!usedIds.has(id)) { usedIds.set(id, 1); return id; }
  let n = usedIds.get(id) + 1;
  while (usedIds.has(id + "-" + n)) n++;
  usedIds.set(id, n);
  return id + "-" + n;
}

const toc = [];
const renderer = new marked.Renderer();
renderer.heading = function (text, level) {
  const plain = stripTags(text);
  const id = uniqueId(slugify(plain));
  if (level === 2 || level === 3) toc.push({ id, text: plain.replace(/[\x60]/g, ""), level });
  return "<h" + level + ' id="' + id + '">' + text + "</h" + level + ">";
};
renderer.code = function (code, infostring) {
  const raw = (infostring || "").trim().split(/\s+/)[0].toLowerCase();
  const lang = LANG_MAP[raw] || "plaintext";
  let body;
  try {
    body = lang === "plaintext" ? esc(code) : hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch (e) { body = esc(code); }
  const label = raw || "text";
  return '<div class="codeblock" data-lang="' + esc(label) + '"><div class="codebar"><span class="lang">' +
    esc(label) + '</span><button class="copybtn" type="button" data-copy>复制</button></div><pre><code class="hljs language-' +
    lang + '">' + body + "</code></pre></div>";
};
renderer.table = function (header, body) {
  return '<div class="table-wrap"><table><thead>' + header + "</thead><tbody>" + body + "</tbody></table></div>";
};
renderer.link = function (href, title, text) {
  const t = title ? ' title="' + title + '"' : "";
  if (href && !/^https?:/i.test(href) && !href.startsWith("#")) return '<span class="xlink">' + text + "</span>";
  return '<a href="' + href + '" target="_blank" rel="noopener"' + t + ">" + text + "</a>";
};
marked.setOptions({ renderer, gfm: true, breaks: false });

function extractGoals(md) {
  const start = md.indexOf("## 学习目标");
  if (start < 0) return [];
  const rest = md.slice(start);
  const next = rest.indexOf("\n## ", 5);
  const block = next > 0 ? rest.slice(0, next) : rest;
  return block.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, "").replace(/[\x60]/g, "").trim()).filter(Boolean);
}
function plainText(md) {
  return md
    .replace(/[\x60]{3}[\s\S]*?[\x60]{3}/g, " ")
    .replace(/[\x60][^\x60]*[\x60]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[|*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const chapters = [];
for (const d of fs.readdirSync(COURSE, { withFileTypes: true })) {
  if (!d.isDirectory() || !/^\d\d-/.test(d.name)) continue;
  const mod = MODULES.find((m) => m.id === d.name.slice(0, 2));
  for (const f of fs.readdirSync(path.join(COURSE, d.name)).filter((x) => /^\d\d-.*\.md$/.test(x)).sort()) {
    const md = fs.readFileSync(path.join(COURSE, d.name, f), "utf8").replace(/^\uFEFF/, "");
    toc.length = 0;
    usedIds.clear();
    let html = marked.parse(md);
    html = html.replace(/<h1[\s\S]*?<\/h1>/, "");
    html = html.replace(/<h2 id="[^"]*">学习目标<\/h2>[\s\S]*?(?=<h2)/, "");
    const title = (md.match(/^#\s+(.+)$/m) || [, f])[1].trim();
    chapters.push({
      num: Number(f.slice(0, 2)),
      moduleId: d.name.slice(0, 2),
      moduleTitle: mod ? mod.title : d.name,
      title: title.replace(/^第\d+章\s*/, ""),
      fullTitle: title,
      file: d.name + "/" + f,
      html,
      toc: toc.filter((t) => t.text !== "学习目标"),
      goals: extractGoals(md),
      text: plainText(md),
      codeBlocks: (md.match(/[\x60]{3}/g) || []).length / 2,
      minutes: Math.max(6, Math.round(plainText(md).length / 420)),
    });
  }
}
chapters.sort((a, b) => a.num - b.num);

const quizzes = {};
if (fs.existsSync(QUIZZES)) {
  for (const f of fs.readdirSync(QUIZZES).filter((x) => x.endsWith(".json"))) {
    const obj = JSON.parse(fs.readFileSync(path.join(QUIZZES, f), "utf8"));
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) quizzes[k] = (quizzes[k] || []).concat(v);
  }
}

const payload = {
  version: "0.25.0",
  modules: MODULES.map((m) => ({ ...m, chapters: chapters.filter((c) => c.moduleId === m.id).map((c) => c.num) })),
  chapters,
  quizzes,
};

fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
fs.writeFileSync(path.join(OUT, "assets", "course-data.js"), "window.COURSE=" + JSON.stringify(payload) + ";", "utf8");
for (const f of ["index.html"]) fs.copyFileSync(path.join(SHELL, f), path.join(OUT, f));
for (const f of ["app.css", "app.js"]) fs.copyFileSync(path.join(SHELL, f), path.join(OUT, "assets", f));
const hljsCss = path.join(ROOT, "node_modules", "highlight.js", "styles", "github-dark-dimmed.min.css");
if (fs.existsSync(hljsCss)) fs.copyFileSync(hljsCss, path.join(OUT, "assets", "hljs.css"));

console.log("chapters:", chapters.length, "| quizzes:", Object.keys(quizzes).length);
