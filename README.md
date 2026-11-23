# OpenAI Agents SDK 研读营 · 交互式课程

> 基于 [openai/openai-agents-python](https://github.com/openai/openai-agents-python) **0.25.0** 的 33 章中文课程。
> 纯静态、零后端：读一节、勾学习目标、做 3 道自测，进度与笔记保存在浏览器本地。

## 课程内容

11 个模块 / 33 章 / 99 道自测题：

| 模块 | 章节 | 主题 |
| --- | --- | --- |
| 导论 | 0–2 | Agent 的本质、仓库全景、环境搭建 |
| 核心运行时 | 3–6 | Agent 字段、Runner 循环、RunResult、上下文 |
| 工具系统 | 7–10 | function_tool、托管工具、MCP、Agent-as-tool |
| 多智能体编排 | 11–13 | 协作模式、handoffs、沙箱 Agent |
| 安全与护栏 | 14–16 | guardrails、工具审批、RunState 中断恢复 |
| 状态与记忆 | 17–18 | Sessions、跨轮状态策略 |
| 模型与输出 | 19–21 | Provider、结构化输出、流式事件 |
| 可观测性与质量 | 22–24 | Tracing、测试替身、调试 |
| 语音与实时 | 25–26 | VoicePipeline、Realtime |
| 源码剖析 | 27–29 | 架构、运行循环精读、重试与异常 |
| 实战 | 30–32 | 客服系统、研究型 Agent、速查表 |

## 课程结构（三种用法）

| 入口 | 内容 | 怎么用 |
| --- | --- | --- |
| 主线 · 判断力 | 11 章（前置 2 + 判断力 9） | 精读，每章一个"你能判断什么"的验收点 |
| 手册 · 用时查 | 12 章 | 不当书读；参数与机制，按关键词查 |
| 评审 · 上线前 | 30 项检查 + 10 个真实事故 | 勾选并导出 Markdown，贴进 PR |
| 按需 / 后置 | 沙箱、语音、源码深潜、实战项目 | 有需求再读 |

首页只给这三扇门；全部章节仍在 `#/all`。

## 交互功能

- **章节自测**：每章 3 题（简单 / 中等 / 困难），即时判定 + 解析 + 得分，可重做；
- **学习目标清单**：勾选状态本地保存；
- **进度统计**：完成章节、自测正确率、笔记数、预计时长；
- **全文搜索**：33 章正文索引，标题优先，带上下文片段；
- **笔记**：每章一个自动保存的文本框，可导出 Markdown；
- **阅读体验**：锚点目录随滚动高亮、代码高亮与一键复制、明暗主题、打印样式、移动端适配；
- **快捷键**：`/` 搜索、`j`/`k` 上下章、`t` 主题、`?` 帮助。

## 本地运行

站点是纯静态的，但因为正文按章懒加载（`fetch`），**必须通过 HTTP 打开**，直接双击 `index.html` 会被浏览器的同源策略拦住。

```bash
python -m http.server 4173
# 打开 http://127.0.0.1:4173/
```

## 目录结构

```text
.
├── index.html              # 站点入口（构建产物，已提交，Pages 直接可用）
├── assets/
│   ├── course-data.js      # 构建产物：课程索引（模块 / 章节元信息 / 引用），首屏唯一数据文件
│   ├── data/
│   │   ├── ch/00.json…32.json   # 单章正文 + 目录 + 学习目标 + 自测，按需拉取
│   │   └── search.json     # 全文搜索语料，首次搜索时才加载
│   ├── app.css
│   ├── app.js
│   └── hljs.css
├── content/                # 课程正文（Markdown，构建输入）
│   ├── 00-导论/
│   ├── 01-核心运行时/
│   └── … 共 11 个模块
├── src/
│   ├── build.mjs           # Markdown → HTML → 索引 + 按章 JSON
│   ├── test.mjs            # jsdom 冒烟测试（33 章渲染 + 交互）
│   ├── shell/              # 页面骨架、样式、前端逻辑
│   └── quizzes/            # 99 道自测题（q1/q2/q3.json）
└── package.json
```

## 加载策略

首屏只取索引（约 56 KB），正文与搜索语料按需加载，避免一次性下载整本书：

| 资源 | 体积 | 何时加载 |
| --- | --- | --- |
| `course-data.js` | 56 KB | 首屏 |
| `data/ch/NN.json` | 平均 37 KB | 进入该章时（已访问过的缓存在内存，返回即秒开） |
| `data/search.json` | 360 KB | 搜索框获得焦点或首次输入时 |

首屏从 1.6 MB 降到约 190 KB（gzip 44 KB）。


## 修改与重建

```bash
npm install     # marked + highlight.js（jsdom 仅测试用）
npm run build   # 重新生成 index.html 与 assets/
npm test        # 校验 33 章均可渲染、每章 3 题、搜索与自测可用
```

改讲义：直接编辑 `content/<模块>/<章节>.md`；改题目：编辑 `src/quizzes/*.json`（键为章节号字符串）。

## 内容来源与许可

- 课程正文与代码示例围绕 [openai-agents-python](https://github.com/openai/openai-agents-python)（MIT License）的源码与官方文档编写；
- 站点代码（`src/`、`assets/`、`index.html`）以 MIT License 发布，详见 [LICENSE](LICENSE)；
- 题目与解析为本课程原创。

## 部署

任何静态托管都可以（GitHub Pages / Netlify / Nginx / S3）。GitHub Pages 两种方式：

1. **用户站点**：仓库命名为 `<user>.github.io`，推送 `main` 即自动发布；
2. **项目站点**：Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/(root)`。


**在线访问：https://rgarvel.github.io/AgentLearning/**
