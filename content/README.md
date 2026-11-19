# OpenAI Agents SDK 智能体开发研读营

> 一套完全基于 [openai/openai-agents-python](https://github.com/openai/openai-agents-python) 仓库（v0.25.0）的中文系统课程。
> 33 章 · 11 个模块 · 每章都有可运行代码、常见坑与课后练习。
> 目标不是"会调 API"，而是**真正理解 Agent 这台机器是怎么转起来的**。
>
> 🖥️ **交互式在线课程**：[course-site](../course-site/README.md) —— 本机 http://127.0.0.1:4173/ ，含章节自测（99 题）、进度、笔记与全文搜索。
>
> 📄 **想一次性读完？** 打开单文件合集 [OpenAI-Agents-SDK-完整课程.md](OpenAI-Agents-SDK-完整课程.md)（33 章 · 约 10 万字）；按模块分章阅读，则从下表进入。

---

## 这套课程解决什么问题

大多数人学 Agent 的路径是：抄一个 demo → 加几个工具 → 上生产 → 被一堆问题打回原形：

- 工具调用死循环、上下文越堆越长、成本失控；
- 多智能体之间互相踢皮球，最后谁也没给出答案；
- 线上偶发失败无法复现，日志里只有一句 `MaxTurnsExceeded`；
- 需要人工审批的操作没有安全闸门；
- 换个模型供应商，整套代码推倒重来。

这些问题的答案，几乎都写在这 1700 多个文件、`src/agents` 约 12 万行 Python 的仓库里——但仓库是"参考手册"，不是"教程"。本课程做的事，就是**把仓库重新排成一条可以走通的学习路径**：先让你跑通最小闭环，再拆开运行循环，然后逐个装上工具、护栏、记忆、追踪，最后落到两个完整项目。

---

## 学完你能做到

1. 从零写出一个带工具、结构化输出、流式响应的 Agent，并解释它每一轮在做什么。
2. 在 **handoff（交接）** 与 **agent-as-tool（把 Agent 当工具）** 之间做出有依据的架构选择。
3. 用三层防护（输入/输出护栏、工具护栏、人工审批）给 Agent 装上安全闸门。
4. 用 **session / RunState / 服务端会话** 解决"多轮记忆"和"断点恢复"两类完全不同的问题。
5. 用 **tracing + 测试替身 + 评估闭环** 让 Agent 的行为可观测、可回归。
6. 读懂 `src/agents/run.py` 与 `run_internal/`，出问题时能定位到具体环节。

---

## 前置要求

| 项目 | 要求 |
| --- | --- |
| Python | 3.10+（异步、类型注解、`dataclass` 需熟悉） |
| 基础 | 会写 `async/await`；了解 Pydantic 模型；用过 HTTP API |
| 账号 | 一个 OpenAI API Key（跑示例需要；纯阅读不需要） |
| 心态 | 愿意动手改代码。**只看不写，这套课的价值会少一半** |

---

## 课程地图

### 模块 0 · 导论（建立心智模型）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 0 | [课程导读与学习地图](00-导论/00-课程导读与学习地图.md) | 怎么用这套课 | — |
| 1 | [Agent 的本质](00-导论/01-Agent的本质-从Swarm到Agents-SDK.md) | Agent = 模型 + 指令 + 工具 + 循环 | `docs/index.md` |
| 2 | [仓库全景与环境搭建](00-导论/02-仓库全景与环境搭建.md) | 12 万行 Python 怎么读、环境怎么配 | `README.md`、`docs/quickstart.md` |

### 模块 1 · 核心运行时（这台机器怎么转）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 3 | [Agent 对象解剖](01-核心运行时/03-Agent对象解剖.md) | 每个字段都在控制什么 | `docs/agents.md` |
| 4 | [Runner 与运行循环](01-核心运行时/04-Runner与运行循环.md) | 一次 run 内部发生了什么 | `docs/running_agents.md` |
| 5 | [RunResult 与 RunItem](01-核心运行时/05-RunResult与RunItem.md) | 运行产物就是一条可回放的时间线 | `docs/results.md` |
| 6 | [上下文与依赖注入](01-核心运行时/06-上下文RunContext与依赖注入.md) | 分清"本地上下文"和"对话上下文" | `docs/context.md` |

### 模块 2 · 工具系统（给 Agent 装上手脚）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 7 | [函数工具 function_tool](02-工具系统/07-函数工具function_tool.md) | 一个 Python 函数如何变成工具 | `docs/tools.md` |
| 8 | [托管工具家族](02-工具系统/08-托管工具家族.md) | 搜索、代码执行、计算机操作、图像生成 | `docs/tools.md` |
| 9 | [MCP 协议集成](02-工具系统/09-MCP协议集成.md) | 用协议复用别人的工具生态 | `docs/mcp.md` |
| 10 | [Agent 即工具与工具调用控制](02-工具系统/10-Agent即工具与工具调用控制.md) | manager 模式与强制调用 | `docs/tools.md`、`multi_agent.md` |

### 模块 3 · 多智能体编排（多个 Agent 怎么协作）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 11 | [多智能体设计模式](03-多智能体编排/11-多智能体设计模式.md) | 先决定"谁拥有最终答案" | `docs/multi_agent.md` |
| 12 | [Handoffs 深入](03-多智能体编排/12-Handoffs深入.md) | 控制权转移与历史裁剪 | `docs/handoffs.md` |
| 13 | [沙箱 Agent 与真实工作区](03-多智能体编排/13-沙箱Agent与真实工作区.md) | 让 Agent 真的去改文件、跑命令 | `docs/sandbox_agents.md` |

### 模块 4 · 安全与护栏（不要相信模型）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 14 | [Guardrails 输入输出护栏](04-安全与护栏/14-Guardrails输入输出护栏.md) | 并行检查 + tripwire 熔断 | `docs/guardrails.md` |
| 15 | [工具护栏与工具审批](04-安全与护栏/15-工具护栏与工具审批.md) | 危险操作前踩一脚刹车 | `docs/human_in_the_loop.md` |
| 16 | [人类在环与中断恢复](04-安全与护栏/16-人类在环与中断恢复.md) | RunState 让 Agent 可以"暂停存档" | `docs/human_in_the_loop.md` |

### 模块 5 · 状态与记忆（多轮与长程）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 17 | [Sessions 会话记忆](05-状态与记忆/17-Sessions会话记忆.md) | 让 SDK 替你存对话历史 | `docs/sessions/` |
| 18 | [跨轮状态策略与上下文工程](05-状态与记忆/18-跨轮状态策略与上下文工程.md) | 四种记忆策略怎么选 | `docs/running_agents.md` |

### 模块 6 · 模型与输出（换模型、要结构、要流式）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 19 | [模型与 Provider](06-模型与输出/19-模型与Provider.md) | 模型解析顺序与自定义 Provider | `docs/models/` |
| 20 | [结构化输出与 output_type](06-模型与输出/20-结构化输出与output_type.md) | 让模型返回对象而不是字符串 | `docs/agents.md` |
| 21 | [流式输出与事件](06-模型与输出/21-流式输出与事件.md) | 事件流与打字机 UI | `docs/streaming.md` |

### 模块 7 · 可观测性与质量（能看见，才能改好）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 22 | [Tracing 追踪](07-可观测性与质量/22-Tracing追踪.md) | 每个 turn、每次工具调用都留痕 | `docs/tracing.md` |
| 23 | [测试与 Evals 评估](07-可观测性与质量/23-测试与Evals评估.md) | 不花 token 也能测 Agent | `docs/testing.md` |
| 24 | [调试与可视化](07-可观测性与质量/24-调试与可视化.md) | 报错速查与图结构可视化 | `docs/visualization.md` |

### 模块 8 · 语音与实时（从打字到说话）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 25 | [语音流水线 VoicePipeline](08-语音与实时/25-语音流水线VoicePipeline.md) | STT → Agent → TTS 三段式 | `docs/voice/` |
| 26 | [实时 Agent Realtime](08-语音与实时/26-实时Agent-Realtime.md) | 端到端语音对话与打断 | `docs/realtime/` |

### 模块 9 · 源码剖析（看懂实现）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 27 | [源码架构走读](09-源码剖析/27-源码架构走读.md) | 目录职责与分层 | `src/agents/` |
| 28 | [运行循环源码精读](09-源码剖析/28-运行循环源码精读.md) | run.py 主流程逐段拆解 | `run.py`、`run_internal/` |
| 29 | [重试、超时与错误处理](09-源码剖析/29-重试超时与错误处理.md) | 生产环境的兜底设计 | `retry.py`、`exceptions.py` |

### 模块 10 · 实战（把知识焊死）

| 章 | 标题 | 一句话 | 对应仓库 |
| --- | --- | --- | --- |
| 30 | [实战一：客服分诊与工单系统](10-实战/30-实战一-客服分诊与工单系统.md) | 多智能体 + 工具 + 护栏 + 会话 | `examples/customer_service/` |
| 31 | [实战二：研究型 Agent 与评估闭环](10-实战/31-实战二-研究型Agent与评估闭环.md) | 搜索、结构化产出与回归评估 | `examples/research_bot/` |
| 32 | [速查表与避坑清单](10-实战/32-速查表与避坑清单.md) | 一张表回顾全部 API | — |

---

## 三条学习路线

### 路线 A · 三天速通（先能用）
`第2章 → 第3章 → 第4章 → 第7章 → 第12章 → 第17章 → 第22章 → 第30章`
适合：马上要在项目里用起来的人。跳过源码与语音，直接拿到可工作的骨架。

### 路线 B · 两周系统（推荐）
按模块 0→1→2→3→4→5→6→7 顺序走，每章配 1 小时阅读 + 1 小时动手，模块 8/9 作为选修，最后两天做模块 10 的两个项目。
适合：想真正掌握、并且要带团队的人。

### 路线 C · 源码深潜
`第26章 → 第27章 → 第28章 → 第29章`，再回读模块 1 与模块 4。
适合：要改 SDK、要排查疑难问题、要做二次封装的人。

---

## 环境准备

```bash
# 1) 拿到课程依赖的仓库（本课程所有结论以该仓库为准）
git clone https://github.com/openai/openai-agents-python.git repo
cd repo

# 2) 建虚拟环境（建议 uv，其次 venv）
uv venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
uv pip install -e .                      # 或 pip install -e .

# 3) 配置密钥（Windows PowerShell 用 $env:OPENAI_API_KEY="sk-..."）
export OPENAI_API_KEY=sk-...

# 4) 跑通第一个例子
python examples/basic/hello_world.py
```

> 每个示例目录一般有自己的 `requirements.txt`（`uv pip install -r examples/basic/requirements.txt`）。
> 没有 API Key 时，第 23 章的测试替身（ScriptedModel）可以让你在完全离线的情况下跑通大部分逻辑。

---

## 本课程的五个学习方法

1. **先跑通，再读码**：每章代码先抄下来跑一遍，再回来看解释，理解速度差 3 倍。
2. **盯着 `result.new_items` 看**：这是 Agent 的"黑匣子记录仪"。任何一次运行，先打印 items 再谈调优。
3. **每个 turn 都看 trace**：第 22 章之后，你会习惯用 trace 而不是 `print` 定位问题。
4. **把 prompt 当代码管**：改动要能回归（第 23 章），否则你就是在大海捞针。
5. **先单 Agent，再上多 Agent**：多数"需要多智能体"的场景，其实是"需要更好的工具和更清晰的指令"。

---

## 章节约定

| 约定 | 说明 |
| --- | --- |
| 版本 | 以 openai-agents `0.25.0` 为基准；API 若与旧教程冲突，以本课程内附的源码路径为准 |
| 代码 | Python 3.10+；`from agents import ...`；工具装饰器优先 `from agents.decorators import tool` |
| 文件路径 | 文中 `repo/docs/xxx.md`、`repo/examples/xxx.py` 均指仓库内路径 |
| 术语 | handoff=交接；guardrail=护栏；turn=轮次；session=会话；tracing=追踪 |
| 练习 | 每章 `动手练习` 至少完成前两题，第三题是"改仓库示例"，最值钱 |

---

## 版本与更新记录

当前基线 **0.25.0**（2026-11-17 发布）。课程会随上游同步：每次更新都记录"公开 API 改了什么、影响哪些章节、怎么复现"，并保留可执行的更新流程。

- 本次更新：`0.24.0 → 0.25.0`（会话适配器工具、handoff 错误恢复、generation span 工具字段、模型默认参数钩子）
- 详见 [版本与更新记录.md](版本与更新记录.md)

## 学完之后往哪走

- 想把 Agent 部署成服务：看第 21 章（流式）+ 第 22 章（追踪）+ 第 29 章（重试）。
- 想让 Agent 操作真实代码仓库：看第 13 章（沙箱）。
- 想做语音助手：看第 25/26 章。
- 想贡献回仓库：读 `repo/CONTRIBUTING.md` 与 `repo/AGENTS.md`（这个仓库对 PR 的工程要求很严）。

> 最后一句：Agent 工程难的不是"调用模型"，而是**在不确定的输出上建立确定的系统**——状态、边界、可观测、可回归。这套课的每一章都在为这四件事服务。
