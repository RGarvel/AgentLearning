# 第31章 实战二：研究型 Agent 与评估闭环

第 30 章的客服系统有个奢侈的属性：对错分明。退款金额对不对、审批有没有走，都能断言。

研究型任务没有这个福气。"帮我调研一下 AI 编程工具市场"这种请求，没有唯一正确答案，甚至没有唯一正确结构。

问题于是从"怎么让它跑起来"变成三个更难的：怎么知道它做得好、怎么让好可复现、怎么把成本压住。

这一章我们搭一个研究型 Agent：规划、搜索、阅读、结构化报告。然后围绕它建一条能进 CI 的评估闭环。

## 学习目标

- 能画出 plan → search → read → write 四段式流水线，并说清为什么这一段该用代码编排而不是让模型自由交接。
- 能用 `output_type` 把报告做成可落库、可断言的结构，而不是一坨 Markdown。
- 能用 `asyncio` + 信号量并发跑搜索，并把每次 run 的 token 汇总成预算指标。
- 能写出三层评估：结构断言、事实断言、LLM 评审，并知道每层该抓什么错。
- 能设计一次"只改一个变量"的迭代，用同一套问题集对比前后版本。

## 一、研究型任务的三个难点

研究型任务有三个绕不开的难点：无唯一答案、上下文爆炸、成本不可控。后面每个设计决策都对着它们。

| 难点 | 表现 | 本章对策 |
| --- | --- | --- |
| 无唯一答案 | 两次跑出来的报告措辞不同，你不知道哪次更好 | 结构化产出 + 分层断言 + 评审模型 |
| 上下文爆炸 | 十几次搜索的原始网页塞进上下文，写作阶段直接超窗 | 每次搜索强制压成 300 词摘要，只传摘要 |
| 成本不可控 | 搜索次数、上下文长度、重试次数三者相乘 | 规划上限、并发上限、上下文档位、单次 token 预算 |

> 提示：研究型 Agent 的失败通常不是"模型不够聪明"，而是"你把太多未经压缩的信息塞给了它"。摘要即压缩，这是这一章最重要的工程直觉。

## 二、四段式流水线：plan → search → read → write

这四段的输入输出契约是固定的，所以交给代码编排，不让模型自由交接。

规划产出搜索项列表，搜索产出摘要，写作消费摘要。契约既然固定，让代码控制顺序，就比让模型在 4 个 Agent 之间自由 handoff 更便宜、更可调试。

参考实现见 `repo/examples/research_bot/`，其中 `manager.py` 正是把三个 Agent 串起来的编排层。先看形状：

```text
query
  │
  ▼
┌──────────┐   WebSearchPlan(searches[N])   ┌────────────────────────┐
│ Planner  │ ─────────────────────────────► │ 代码编排层（manager）    │
│ 小模型    │                                │ · 截断到 N 条           │
└──────────┘                                │ · 信号量并发            │
                                            │ · 失败降级              │
                                            └───────────┬────────────┘
                        ┌───────────────────────────────┤
                        ▼  并行（≤4）                    ▼ 串行（1 次）
              ┌──────────────────┐              ┌──────────────────┐
              │ Search Agent ×N  │              │ Writer Agent     │
              │ WebSearchTool    │              │ 大模型            │
              │ 输出 2-3 段摘要   │              │ output_type=Report│
              └────────┬─────────┘              └────────┬─────────┘
                       └────── summaries[] ─────────────►│
                                                        ▼
                                              ReportData(结构化报告)
```

图里三个角色各司其职：规划只出计划，搜索并行压缩，写作串行成文。

三个 Agent 的定义都很短，短到你可以逐字读完。这是刻意的。注意目录名用 `research_agents/` 而不是 `agents/`，后者会遮蔽已安装的 SDK 包。

研究型系统里，prompt 的每一句都在为评估指标负责。写长了，你就不知道是哪句起了作用。

先看规划器。这段验证的是"用 schema 把搜索计划钉死"。

```python
# research_agents/planner.py
from pydantic import BaseModel

from agents import Agent, ModelSettings

MAX_SEARCHES = 8


class WebSearchItem(BaseModel):
    reason: str
    """为什么这条搜索对回答原问题重要。"""

    query: str
    """实际送给搜索引擎的检索词。"""


class WebSearchPlan(BaseModel):
    searches: list[WebSearchItem]
    """按重要性排序的搜索计划。"""


planner_agent = Agent(
    name="Planner",
    instructions=(
        "你是研究规划员。针对用户的问题，产出 5 到 8 条互补的检索词，"
        "覆盖：定义与现状、主要玩家、关键数据、反面观点。"
        "每条检索词要能独立搜出结果，不要写成问句。"
    ),
    model="gpt-5-nano",
    output_type=WebSearchPlan,
)
```

预期结果是：模型返回 5 到 8 条 `WebSearchItem`，每条都带检索词和它存在的理由。

检索器只做一次搜索、一次压缩。这段验证的是"用指令给单次搜索封顶"。

```python
# research_agents/searcher.py
from agents import Agent, WebSearchTool

search_agent = Agent(
    name="Searcher",
    instructions=(
        "你是检索助手。针对给定检索词做一次网络搜索，然后用 2-3 段、不超过 300 词"
        "总结要点。只保留可被写作直接引用的事实、数字与结论，不要评论，不要客套。"
    ),
    model="gpt-5-nano",
    tools=[WebSearchTool(search_context_size="low")],
)
```

预期结果是：每条搜索打回 2-3 段摘要，总长不超过 300 词。

写作器消费摘要，产出结构化报告。这段验证的是"输出能被下游直接消费"。

```python
# research_agents/writer.py
from pydantic import BaseModel

from agents import Agent


class ReportData(BaseModel):
    short_summary: str
    """2-3 句话的核心结论。"""

    markdown_report: str
    """完整报告，Markdown 格式。"""

    follow_up_questions: list[str]
    """3 个值得继续研究的问题。"""

    sources: list[str]
    """报告中引用到的来源 URL。"""


writer_agent = Agent(
    name="Writer",
    instructions=(
        "你是资深研究员。基于给定的检索摘要写一份报告：先列提纲，再成文。"
        "所有数字必须来自摘要；摘要没给的信息就写"未找到可靠来源"，不要补。"
        "报告 1000 字以上，结尾附 3 个后续研究问题。"
    ),
    model="gpt-5.6-sol",
    output_type=ReportData,
)
```

预期结果是：`ReportData` 四个字段全部填满，正文里的数字都能在摘要里找到。

这三份定义要验证的是"职责单一 + 契约明确"。四个关键点如下。

| 要点 | 说明 |
| --- | --- |
| 模型分工 | 规划用便宜模型（`gpt-5-nano`）、写作用好模型，这是研究型系统里性价比最高的一次分工。规划错了重跑很便宜，写作重跑很贵。 |
| `WebSearchTool` | 它是**托管工具**，只在 OpenAI 模型 + Responses API 下可用。`search_context_size` 取 `"low" / "medium" / "high"`，是控制单次搜索上下文成本最直接的旋钮。 |
| 300 词上限 | 检索助手的指令里写死"不超过 300 词"，这不是风格要求，是在替写作阶段省上下文。 |
| 反幻觉条款 | 写作指令里"摘要没给的信息就写未找到"，既是反幻觉条款，也是后面评估要检查的点。 |

## 三、结构化产出：让报告能被断言

`output_type=ReportData` 的收益不止"好看"。它把一次 run 的输出变成了一个有 schema 的对象，于是下面三件事都变得可做。

| 用法 | 得到什么 |
| --- | --- |
| `result.final_output_as(ReportData)` | 拿到强类型对象，直接入库 |
| 对字段做断言 | `len(follow_up_questions) == 3`、`markdown_report` 长度下限，都能自动检查 |
| 把 `sources` 与检索摘要交叉核对 | 抓"编造引用"。这要求检索阶段保留 URL，否则只能核对域名 |

设计 schema 有两条经验：**字段少而语义清楚**，以及**把你要断言的字段单独列出来**。

`short_summary` 和 `markdown_report` 分开就是这个原因。前者适合做人工抽检和相似度比较，后者适合做长度与引用检查。

> 注意：不要为了"信息全"把 schema 嵌套成五层。结构化输出的失败模式是"字段填不满时模型开始瞎编"，schema 越复杂，瞎编概率越高。

## 四、并行与预算：把 token 花在刀刃上

搜索是天然并行的，也天然容易失控。8 条搜索同时打出去，既可能触发限流，也会让账单在一个瞬间跳起来。

对策是三件事：用信号量把并发压到 3-4，配一个 `max_turns` 兜底，再统一汇总 token。

下面这段是编排层，验证的是"并发可控、失败可降级、成本可计量"。

```python
# pipeline.py
import asyncio
from dataclasses import dataclass

from agents import MaxTurnsExceeded, Runner, custom_span, trace

from research_agents.planner import WebSearchPlan, planner_agent
from research_agents.searcher import search_agent
from research_agents.writer import ReportData, writer_agent

MAX_CONCURRENT_SEARCHES = 4
MAX_SEARCHES = 8


@dataclass
class ResearchResult:
    report: ReportData
    evidence: list[str]          # 落盘的检索摘要，评审时要当证据一起传
    total_tokens: int
    succeeded: int
    failed: int


async def run_research(query: str) -> ResearchResult:
    with trace("research-run", group_id=query):
        plan_result = await Runner.run(planner_agent, f"Query: {query}")
        plan = plan_result.final_output_as(WebSearchPlan)
        items = plan.searches[:MAX_SEARCHES]           # 上限在代码里，不在 prompt 里

        sem = asyncio.Semaphore(MAX_CONCURRENT_SEARCHES)

        async def one(item) -> tuple[str | None, int]:
            async with sem:
                try:
                    result = await Runner.run(
                        search_agent,
                        f"Search term: {item.query}\nReason: {item.reason}",
                        max_turns=6,
                    )
                    return str(result.final_output), result.context_wrapper.usage.total_tokens
                except MaxTurnsExceeded:
                    return None, 0                       # 单条失败不拖垮整条流水线

        with custom_span("parallel-search", data={"planned": len(items)}):
            pairs = await asyncio.gather(*(one(item) for item in items))

        summaries = [text for text, _ in pairs if text]
        tokens = plan_result.context_wrapper.usage.total_tokens + sum(t for _, t in pairs)

        writer_input = (
            f"Original query: {query}\n"
            f"Summarized search results ({len(summaries)} of {len(items)} succeeded):\n"
            + "\n\n".join(f"[{i + 1}] {text}" for i, text in enumerate(summaries))
        )
        report_result = await Runner.run(writer_agent, writer_input, max_turns=4)
        tokens += report_result.context_wrapper.usage.total_tokens

        return ResearchResult(
            report=report_result.final_output_as(ReportData),
            evidence=summaries,
            total_tokens=tokens,
            succeeded=len(summaries),
            failed=len(items) - len(summaries),
        )
```

预期结果是：`ResearchResult` 带回结构化报告、证据摘要、总 token，以及成功和失败的条数。四个关键行如下。

| 要点 | 说明 |
| --- | --- |
| `MAX_SEARCHES` 在代码里截断 | 不要写在 prompt 里求模型"最多 8 条"。模型不遵守数字，代码遵守。 |
| `asyncio.gather` + 信号量 | 一次性提交、内部限流，比 `as_completed` 更好读。需要"谁先完成先处理"时再用 `as_completed`，`repo/examples/research_bot/manager.py` 用的是后者。 |
| 单条失败降级 | 单条搜索抛 `MaxTurnsExceeded` 时返回 `None`，让"7 条成功 + 1 条失败"仍然能产出报告。研究型任务最忌讳因为一条搜索失败就整体 500。 |
| token 逐层相加 | `result.context_wrapper.usage.total_tokens` 是每次 run 的用量，逐层相加就是这次研究的总账。把它做成返回值，评估时才能画"质量 vs 成本"的曲线。 |

成本控制的完整清单如下。

| 环节 | 成本来源 | 手段 |
| --- | --- | --- |
| 规划 | 输入 + 输出 token | 用便宜模型；输出用 `output_type` 限制成短 JSON |
| 搜索 | 搜索次数 × 上下文档位 | 限条数、`search_context_size="low"`、并发限流 |
| 摘要 | 每条搜索的输出 token | 指令里写死"300 词以内" |
| 写作 | 一次大上下文 | 只传摘要不传原文；`max_turns=4` 防失控 |
| 重试 | 隐式翻倍 | 单条失败降级为 `None`，不整条重跑 |

## 五、评估闭环：三层断言 + LLM 评审

评估的最小可用形态是"**固定问题集 + 每次跑完写一行结果**"。

先建 20 条覆盖典型场景的问题，每条带上你能自动检查的期望。

下面这份 `cases.py` 验证的是"期望能写成字段"。

```python
# evals/cases.py
CASES = [
    {
        "id": "b2b-saas-pricing",
        "query": "2026 年主流 B2B SaaS 的按席位定价趋势",
        "min_chars": 1200,
        "required_terms": ["按席位", "定价"],
        "max_tokens": 60000,
    },
    {
        "id": "oss-license-risk",
        "query": "开源许可证变更对商业使用的影响",
        "min_chars": 1200,
        "required_terms": ["许可证", "商业"],
        "max_tokens": 60000,
    },
]
```

预期结果是：每条 case 都带 `min_chars`、`required_terms`、`max_tokens` 三个可断言的期望。

然后在同一份评估脚本里跑三层检查，每层抓不同的错。

| 层 | 抓什么 | 成本 |
| --- | --- | --- |
| 结构断言 | 报告非空、长度达标、`follow_up_questions` 数量对、`sources` 非空。这是必过项 | 免费 |
| 事实断言 | 必含关键词是否出现。如果检索摘要保留了来源 URL，就把 `sources` 与本轮摘要做字符串交叉核对，这条能抓住大部分编造引用。摘要没留 URL 时，这一项退化为核对域名是否出现在摘要里 | 免费，抓硬错 |
| LLM 评审 | 让一个评审 Agent 只根据给定摘要判断报告是否有 supported、是否有夸大 | 花钱，抓软错 |

评审 Agent 的关键是**把"你的观点"从判断里摘出去**，只允许对照证据打分。

`repo/examples/financial_research_agent/agents/verifier_agent.py` 是个好范本。它明确要求"只依据提供的证据判断，不要用你自己的记忆"，输出 `verified` 加问题列表。

下面这份评审 Agent 验证的是"把观点从判断里摘出去"。

```python
# evals/judge.py
from typing import Literal

from pydantic import BaseModel

from agents import Agent


class JudgeIssue(BaseModel):
    claim: str
    category: Literal["unsupported", "contradicted", "vague"]
    explanation: str


class JudgeVerdict(BaseModel):
    score: int
    """1-5 分，4 分及以上视为通过。"""
    issues: list[JudgeIssue]


judge_agent = Agent(
    name="Report judge",
    instructions=(
        "你是证据审计员。只依据给定的检索摘要评审报告，不得使用你自己的知识补全。"
        "检查：每个关键数字是否有摘要支撑、结论是否超出证据、是否把推测写成事实。"
        "score >= 4 表示可以发布。"
    ),
    model="gpt-5.6-sol",
    output_type=JudgeVerdict,
)
```

预期结果是：输出 `score`（1-5 分）与问题列表 `issues`，4 分及以上视为通过。

评估主循环把三层拼起来，每跑一条就写一行 JSONL，方便后面做对比。

```python
# evals/run_evals.py
import json
from pathlib import Path

from agents import Runner

from evals.cases import CASES
from evals.judge import JudgeVerdict, judge_agent
from pipeline import run_research


async def evaluate(out_path: Path) -> list[dict]:
    rows: list[dict] = []
    for case in CASES:
        result = await run_research(case["query"])
        report = result.report
        markdown = report.markdown_report

        checks = {
            "structure_ok": bool(markdown) and len(markdown) >= case["min_chars"],
            "has_followups": len(report.follow_up_questions) >= 3,
            "terms_present": all(t in markdown for t in case["required_terms"]),
            "within_budget": result.total_tokens <= case["max_tokens"],
        }

        verdict = (
            await Runner.run(
                judge_agent,
                "Query: "
                f"{case['query']}\n"
                "Evidence (search summaries):\n"
                + "\n\n".join(result.evidence)
                + f"\n\nReport:\n{markdown}",
            )
        ).final_output_as(JudgeVerdict)
        checks["judge_score"] = verdict.score

        rows.append(
            {
                "id": case["id"],
                "checks": checks,
                "tokens": result.total_tokens,
                "failed_searches": result.failed,
                "passed": all(v for k, v in checks.items() if k != "judge_score")
                and verdict.score >= 4,
            }
        )

    out_path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )
    return rows
```

预期结果是：每条 case 写一行 JSONL，`checks` 四项全过且 `judge_score >= 4`，`passed` 才是 `true`。

这段要验证的是"评估结果是数据，不是感觉"。写 JSONL 而不是打印，是因为下一步要做版本间对比：同一批 case、同一套指标、两次运行的差异。

## 六、迭代方法论：一次只改一个变量

拿到基线后，迭代纪律比技巧重要。每次都记录"改了什么 → 哪几个指标动了"，并且**一次只改一处**。

| 版本 | 改动 | 结构通过率 | judge 均分 | 平均 token |
| --- | --- | --- | --- | --- |
| v0 | 基线 | 18/20 | 3.4 | 52k |
| v1 | 检索指令从"总结要点"改为"300 词内、只留事实" | 19/20 | 3.9 | 41k |
| v2 | `search_context_size` 从 `medium` 降到 `low` | 19/20 | 3.7 | 33k |
| v3 | 写作模型换更强的 | 20/20 | 4.3 | 58k |

读这张表的正确方式是**看取舍**。v2 用 0.2 分换了 8k token，v3 用 25k token 换了 0.6 分。要不要换，取决于你的场景是"贵一点也要准"还是"便宜优先"。

三条经验：

- **先修结构性失败**（`structure_ok` 不过），再看软指标。报告都没写满 1200 字时，讨论文风没意义。
- **失败样本要存原文**。评估只告诉你"哪条没过"，不告诉你"为什么"。把失败 case 的输入、摘要、报告整份落盘，人工看三条胜过改十次 prompt。
- **别用评估集调 prompt**。20 条 case 全用来调参，你就过拟合了。留 5 条只跑不调，作为"上线前最后看一眼"的守门集。

## 七、上 CI：花钱的测试怎么跑

研究型评估每次都要调模型、要花钱、还不稳定，所以不能塞进"每次 push 都跑"的单元测试。分三层跑。

| 触发 | 跑什么 | 耗时/成本 | 目的 |
| --- | --- | --- | --- |
| 每次 push | `ScriptedModel` 写的流水线形状测试（不调真模型） | 秒级、免费 | 防"代码改坏了"：摘要拼接顺序、失败降级、预算计算 |
| 每日夜间 | 5 条快速 case + 结构/事实断言 | 分钟级、小额 | 防"模型或 prompt 改动引入回退" |
| 发版前 | 20 条全量 + LLM 评审 + 与基线对比 | 十几分钟、较大额 | 决定能不能发 |

中间那层最关键。它便宜到可以天天跑，又真的能发现回退。

把它写成 pytest，断言"通过率不低于基线 - 1 条"，比断言"必须 20/20"现实得多。模型输出有方差，卡死满分只会让你天天修测试。

下面这个测试验证的是"编排层的形状没被改坏"。

```python
# tests/test_pipeline_contract.py
import pytest

from agents import Agent, RunConfig, Runner
from agents.testing import ScriptedModel, assistant_message


@pytest.mark.asyncio
async def test_writer_input_keeps_all_summaries() -> None:
    model = ScriptedModel([[assistant_message('{"short_summary": "s", "markdown_report": "m", "follow_up_questions": ["a", "b", "c"], "sources": []}')]])
    writer = Agent(name="Writer stub", model=model)

    await Runner.run(
        writer,
        "Summarized search results (2 of 2 succeeded):\n[1] A\n\n[2] B",
        run_config=RunConfig(tracing_disabled=True),
    )

    assert model.last_call is not None
    assert "[1] A" in str(model.last_call.input)
    assert "[2] B" in str(model.last_call.input)
```

预期结果是：三条断言通过，两条摘要都出现在模型输入里。这个测试不调真模型、不花钱，但能在你重构 `run_research` 时立刻发现"摘要丢了第二条"这类致命问题。

这类 bug 在端到端评估里往往表现为"分数莫名其妙掉了 0.3"，极难定位。

## 常见坑与排查

研究型流水线最常翻的车有六处，每一处都能从症状直接反查到修法。

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 写作阶段报上下文超限 | 把搜索结果原文而不是摘要传给了写作 Agent | 检索 Agent 的输出必须经过长度约束（指令 + 事后截断），编排层只传摘要 |
| 2 | 报告里的数字对不上任何来源 | 写作 Agent 用了自己的先验知识补全 | 写作指令明确"只允许使用给定摘要"；评估层加"`sources` 必须出现在本轮搜索结果里"的断言 |
| 3 | 八条搜索同时打出去被限流 | `asyncio.gather` 没有配并发上限 | `asyncio.Semaphore(4)`，并把失败单条降级为 `None` 而不是整体重试 |
| 4 | 评估分数每次都不一样，无法判断改动有没有用 | 只跑了一遍、且指标是单一均分 | 固定 case 集、固定 `temperature` 类设置、记录多指标（结构通过率 / judge 均分 / token），看趋势而不是看单点 |
| 5 | 评估跑得越来越贵 | 每次都跑全量 + 每条都送大模型评审 | 分层：推送跑免费形状测试，夜间跑 5 条，发版跑全量 |
| 6 | `ToolCallItem` 里搜到了东西，报告却引用了不存在的链接 | 检索摘要里带了 URL，写作时改写或拼接了 | 把 `sources` 做成独立字段并要求"逐字复制"，评估时做字符串比对 |

## 动手练习

1. **加一条"反面观点"检索**：在规划 Agent 的指令里要求至少一条检索词用于寻找反面证据，然后用同一批 case 对比"报告是否变得更有争议性/更平衡"。
2. **做一次成本实验**：把 `search_context_size` 分别设为 `low` / `medium`，跑同一批 5 条 case，记录 `total_tokens` 与 judge 均分，画出你自己的取舍曲线。
3. **改造仓库示例**：打开 `repo/examples/research_bot/manager.py`，把 `_perform_searches` 里的无限并发改成信号量限流（建议 4），并在返回值里带上总 token，然后用 `repo/examples/research_bot/sample_outputs/` 里的输出做一次人工对照。

前两题改的是你自己的 `pipeline.py`，第三题改的是仓库示例。先切到 SDK 根目录。若你的仓库 clone 在别处（比如目录名就叫 `repo`），把路径按自己的目录替换。

```bash
# 工作目录：repo/openai-agents-python/（SDK 根目录）
cd repo/openai-agents-python
```

预期结果是：你能在这个目录下找到 `examples/research_bot/manager.py`，也就是上面提到的 `repo/examples/research_bot/manager.py`。

## 本章小结

- 研究型任务的三难：无唯一答案、上下文爆炸、成本失控；对策分别是评估、摘要、预算。
- 流水线四段：plan（便宜模型 + 结构化计划）→ search（托管工具 + 300 词摘要）→ read（编排层并发与降级）→ write（强模型 + `output_type`）。
- 上限写进代码（`MAX_SEARCHES`、`Semaphore`、`max_turns`），不要写进 prompt 求模型遵守。
- 单条搜索失败要降级为 `None`，"部分成功"远好于"整体失败"。
- 评估三层：结构断言（免费）、事实断言（免费、抓编造）、LLM 评审（花钱、抓夸大）。
- 迭代纪律：一次改一个变量，存失败样本原文，留守门集防止过拟合。
- CI 分三档：推送跑形状测试，夜间跑小样本，发版跑全量对比。

## 延伸阅读

- 官方追踪与分组：`repo/docs/tracing.md`
- 结构化输出：`repo/docs/agents.md`（Output types）、`repo/docs/results.md`
- 托管工具与搜索参数：`repo/docs/tools.md`
- 测试与脚本化模型：`repo/docs/testing.md`
- 并行编排参考：`repo/docs/multi_agent.md`
- 可运行范本：`repo/examples/research_bot/manager.py`、`repo/examples/research_bot/agents/planner_agent.py`、`repo/examples/financial_research_agent/agents/verifier_agent.py`
- 下一章：把前面 31 章压成一张能贴墙的速查表和一份避坑清单，第 32 章《速查表与避坑清单》见。
