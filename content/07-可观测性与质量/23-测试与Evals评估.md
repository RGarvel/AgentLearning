# 第23章 测试与Evals评估

第 22 章解决的是“跑完之后怎么查”，那是在生产里。这一章往前一步，回答上线之前你凭什么相信它。真模型是非确定性的，拿它做回归等于每天掷骰子；靠人肉点几下，等于没有回归。0.25.0 给的答案是 `agents.testing`：一套在内存里、零网络、确定性的替身模型（scripted model）。

本章先把这套工具用透，再谈评估（eval）该怎么搭。测试与评估解决的是两个不同的问题，混在一起谈会把两边都做坏。读完你会得到一套可直接跑的 pytest 文件、一条 PR 流水线命令，以及一个最小评估闭环。

先固定路径写法。课程里的 `repo/xxx` 是 SDK 仓库内的逻辑前缀，点击跳 GitHub 的 v0.25.0 文件；本机目录叫 `openai-agents-python/`，不叫 `repo`。下面所有命令都从 SDK 根目录发起，clone 在别处就把 `openai-agents-python` 换成自己的路径，后文不再重复。

| 课程里写的（可点击） | 你本机打开的文件 |
| --- | --- |
| `repo/docs/testing.md` | `openai-agents-python/docs/testing.md` |
| `repo/src/agents/testing/model.py` | `openai-agents-python/src/agents/testing/model.py` |
| `repo/examples/basic/stream_items.py` | `openai-agents-python/examples/basic/stream_items.py` |

### 跑通前先配齐：依赖与配置项对照表

PR 流水线不花钱、不联网，只需把下面几项装齐。每一项都写了“漏了会报什么错”。

| 配置项 | 怎么设 | 漏了会报什么错 / 后果 |
| --- | --- | --- |
| Python 3.10+ | 第 2 章已装 | 3.9 在 import 阶段报语法错 |
| `pytest` | `uv pip install pytest` | `pytest: command not found` |
| `pytest-asyncio` | `uv pip install pytest-asyncio` | `@pytest.mark.asyncio` 被当成未知标记，async 测试跳过或告警 |
| `asyncio_mode = "auto"` | 写进 `pyproject.toml`（见 23.10） | 出现 `PytestUnhandledCoroutineWarning`，测试体根本没执行 |
| `from agents.testing import ...` | 测试文件顶部 | 写成 `from agents import ScriptedModel` 会 `ImportError`，符号故意不在顶层 |
| `RunConfig(tracing_disabled=True)` | 每次 `Runner.run()` | 环境有 `OPENAI_API_KEY` 时上传噪声 trace、消耗额度 |
| marker 注册 `eval`、`slow` | `pyproject.toml`（见 23.10） | `PytestUnknownMarkWarning`，`-m` 过滤不可靠 |
| `OPENAI_API_KEY` | 仅评估（eval）需要 | PR 测试不需要；夜间评估没它则真模型 401 |

安装依赖的命令，在 SDK 根目录一次执行：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
uv pip install pytest pytest-asyncio
```

验证安装，能看到两个版本号即可：

```bash
python -m pytest --version
```

### 完整主线：五步走到底

按顺序做完，每一步都有“做完标志”。评估等替代方案都降级成后面的“可选微调”。

| 步骤 | 做什么 | 做完的标志 |
| --- | --- | --- |
| 1 | 装 pytest 与 pytest-asyncio | `pytest --version` 显示版本号 |
| 2 | 跑固定回答测试 | `1 passed` |
| 3 | 跑工具调用测试 | 累计 `2 passed` |
| 4 | 跑护栏与流式测试 | 累计 `4 passed` |
| 5 | 单独跑评估 | 看到通过率，低于 0.9 则失败 |

本主线把测试文件统一放在 `course_tests/` 目录（SDK 根目录下）。pytest 测试文件由 pytest 收集，不需要 `if __name__ == "__main__"`，每个文件本身就是一个可运行的完整测试模块。

---

## 学习目标

- 能说清 `ScriptedModel` 接受的五种脚本形态，以及 `ModelCall` 里哪些字段值得断言。
- 能用 `pytest` 加 `pytest-asyncio` 写出不花 token 的工具调用测试。
- 能用 `result.new_items` 而不是字符串匹配来断言工具、交接与消息。
- 能给护栏写测试，并知道 `run_in_parallel` 对确定性的影响。
- 能在测试里正确关闭 tracing，避免测试流量污染追踪后端。
- 能区分“确定性测试”与“评估”，并搭出一个最小评估闭环。

---

## 23.1 为什么需要替身模型

核心结论：真模型只能做探索，不能做回归；替身模型在 `Model` 这个边界上替换，让测试变确定。

真模型有三个结构性缺陷，所以它只能做探索，不能做回归。

| 缺陷 | 具体表现 |
| --- | --- |
| 结果不确定 | 同一输入两次给出不同回答，断言无从下手 |
| 慢 | 秒级起步，一个测试套件轻松跑到分钟级 |
| 贵 | 每次执行都在花钱，跑得越勤越贵 |

`agents.testing` 的思路是在 `Model` 这个边界上替换。运行循环、工具执行、护栏（guardrail）、交接（handoff）、session 全是真的，只有“模型说什么”是录好的。你测的是自己写的编排逻辑，不是模型的心情。

> 注意：`agents.testing` 的符号故意不放进顶层 `agents` 包，必须 `from agents.testing import ...`。这是设计决策，不是遗漏，目的是避免生产代码误用测试替身。

---

## 23.2 ScriptedModel：把模型调用变成脚本

核心结论：`ScriptedModel(steps, *, emit_traces=False, default_usage=None)` 里的 `steps` 是按调用顺序消费的队列。

`steps` 的每个元素可以是五种形态之一。

| 形态 | 写法 | 用途 |
| --- | --- | --- |
| `ModelStep` | `ModelStep.respond(fn)`、`ModelStep.raise_error(exc)`、`ModelStep.stream(events)` | 需要“按请求决定”或注入失败 |
| 字典 | `{"output": [...], "usage": ...}` | 从 JSON 夹具加载脚本 |
| `ModelResponse` | 直接给最终响应对象 | 复用真实响应样本 |
| output item 序列 | `[assistant_message("hi")]` | 最常见，手写最快 |
| 异常实例 | `RuntimeError("boom")` | 等价于 `raise_error` |

两个构造器能覆盖 90% 的场景。

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `assistant_message` | `(text, *, item_id="scripted-message")` | 生成一条 assistant 文本消息 |
| `function_call` | `(name, arguments, *, call_id, item_id=None, namespace=None)` | `arguments` 可传 dict，会被序列化 |

消费完之后，`ScriptedModel` 上有一组可断言的视图。

| 成员 | 内容 |
| --- | --- |
| `calls` | 所有 `ModelCall`（按调用顺序，深拷贝快照） |
| `first_call` / `last_call` | 首/末次调用，没有则为 `None` |
| `remaining_steps` | 还没消费的步数 |
| `enqueue()` / `extend()` | 增量追加脚本 |
| `assert_complete()` | 还有剩余步骤就抛 `UnconsumedModelSteps` |

`ModelCall` 的字段就是一次模型调用的完整输入。包括 `system_instructions`、`input`、`model_settings`、`tools`、`output_schema`、`handoffs`、`tracing`、`previous_response_id`、`conversation_id`、`prompt`、`streamed`。要断言“SDK 到底发了什么”，就断言这几个字段，不要去摸运行器私有状态。

三种脚本错误也值得记住，它们各自带结构化字段。

| 错误 | 关键字段 | 含义 |
| --- | --- | --- |
| `InvalidModelStep` | `reason`、`input_index` | 脚本本身写错 |
| `UnexpectedModelCall` | `call`、`call_index` | 脚本用完了，模型还在被调 |
| `UnconsumedModelSteps` | `remaining_steps` | 流程提前结束 |

后两个是“工作流漂移”的探测器。

---

## 23.3 第一个测试：固定回答

核心结论：最小测试只有三步——给一条脚本、跑一次、两头断言。

最小测试只有三步：给一条脚本、跑一次、两头断言。下面这段验证的就是这三步。把它存成 `test_fixed_response.py`，放在 SDK 根目录的 `course_tests/` 下。

```python
import pytest

from agents import Agent, RunConfig, Runner
from agents.testing import ScriptedModel, assistant_message


@pytest.mark.asyncio
async def test_fixed_response() -> None:
    model = ScriptedModel([[assistant_message("巴黎是法国的首都。")]])
    agent = Agent(name="Geography assistant", model=model)

    result = await Runner.run(
        agent,
        "法国的首都是哪里？",
        run_config=RunConfig(tracing_disabled=True),
    )

    assert result.final_output == "巴黎是法国的首都。"
    assert len(model.calls) == 1
    model.assert_complete()
```

运行单个文件：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest course_tests/test_fixed_response.py -q
```

预期结果是 `1 passed`，四条断言全过，`model.calls` 里只有一条记录。

四个要点里，最容易漏的是最后一条。

| 要点 | 说明 |
| --- | --- |
| `@pytest.mark.asyncio` | 需要 `pytest-asyncio`，记得在 `pyproject.toml` 里设 `asyncio_mode` |
| `ScriptedModel` 直接当模型用 | 它是 `Model` 子类，直接传给 `Agent(model=...)` |
| `tracing_disabled=True` | 让测试不上传，下一节细说 |
| `assert_complete()` 放最后 | 确保流程没有“少跑一步” |

`assert_complete()` 的价值在反向。它抓的是“我以为会调两次模型，实际只调了一次”。没有它，多数的编排退化测试仍会通过。

---

## 23.4 测工具调用：两步脚本，两头断言

核心结论：工具测试的脚本永远是两步——先让模型发出工具调用，再让模型根据工具结果给出最终回答。

中间的工具执行是真的。把下面这段存成 `test_inventory_tool.py`，放在 `course_tests/` 下。

```python
import pytest

from agents import Agent, RunConfig, Runner
from agents.decorators import tool
from agents.testing import ScriptedModel, assistant_message, function_call


@tool
def get_inventory(sku: str) -> str:
    """查询指定 SKU 的可用库存。"""
    return "12"


@pytest.mark.asyncio
async def test_inventory_tool_workflow() -> None:
    model = ScriptedModel(
        [
            [function_call("get_inventory", {"sku": "SKU-88"}, call_id="call_1")],
            [assistant_message("SKU-88 还有 12 件。")],
        ]
    )
    agent = Agent(name="Inventory assistant", model=model, tools=[get_inventory])

    result = await Runner.run(
        agent,
        "SKU-88 还有货吗？",
        run_config=RunConfig(tracing_disabled=True),
    )

    assert result.final_output == "SKU-88 还有 12 件。"
    assert len(model.calls) == 2
    assert model.last_call is not None
    # 第二次调用里应能看到工具的输出回填
    assert any(
        item.get("type") == "function_call_output" for item in model.last_call.input
    )
    model.assert_complete()
```

连跑两个文件：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest course_tests/test_fixed_response.py course_tests/test_inventory_tool.py -q
```

预期结果是 `2 passed`，`final_output` 命中脚本里的第二句话，且第二次调用的输入里有一条 `function_call_output`。

这段测试覆盖的东西比看上去多：工具参数校验、工具执行、结果转成 `function_call_output`、下一轮输入拼装。四项都在真实路径上跑过。如果直接 `get_inventory("SKU-88")` 调函数，这四项全部绕过。

断言用 `item.get("type")` 而不是 `item["type"]`。因为 `ModelCall.input` 的元素可能是 Pydantic 对象，也可能是 dict，取决于上游，用 `get` 更稳。要更精确时，可以按 `call_id` 找对应项。

---

## 23.5 用 items 断言：比字符串匹配可靠

核心结论：`final_output` 只告诉你“最后说了什么”，过程信息在 `result.new_items` 里。

它是 `RunItem` 的列表，每项带 `type` 与 `agent`。

| `item.type` | 类 | 你能读到 |
| --- | --- | --- |
| `message_output_item` | `MessageOutputItem` | `raw_item`，配合 `ItemHelpers.text_message_output()` |
| `tool_call_item` | `ToolCallItem` | `raw_item.name`、`raw_item.arguments` |
| `tool_call_output_item` | `ToolCallOutputItem` | `output` |
| `handoff_call_item` / `handoff_output_item` | `HandoffCallItem` / `HandoffOutputItem` | `source_agent` / `target_agent` |
| `reasoning_item` | `ReasoningItem` | 推理条目 |
| `tool_approval_item` | `ToolApprovalItem` | 待审批调用 |

下面这段把整条轨迹拍平成字符串列表，便于一次性比对。这是片段，不是完整脚本：把它作为函数放进 `test_inventory_tool.py`，在 `result = await Runner.run(...)` 之后调用；`result` 来自那次 `Runner.run()`，`ItemHelpers`、`ToolCallItem`、`ToolCallOutputItem`、`HandoffOutputItem` 按下面的 import 补到文件顶部。

```python
from agents import ItemHelpers
from agents.items import HandoffOutputItem, ToolCallItem, ToolCallOutputItem


def summarize_items(result) -> list[str]:
    lines: list[str] = []
    for item in result.new_items:
        if isinstance(item, ToolCallItem):
            lines.append(f"tool_call:{item.raw_item.name}")
        elif isinstance(item, ToolCallOutputItem):
            lines.append(f"tool_output:{item.output}")
        elif isinstance(item, HandoffOutputItem):
            lines.append(f"handoff:{item.source_agent.name}->{item.target_agent.name}")
        elif item.type == "message_output_item":
            lines.append(f"message:{ItemHelpers.text_message_output(item)}")
    return lines


# 断言示例
# assert summarize_items(result) == ["tool_call:get_inventory", "tool_output:12", "message:SKU-88 还有 12 件。"]
```

预期结果是列表顺序与编排顺序一致，换行、换工具都会直接体现在列表里。

这种“拍平再比对”的写法在回归测试里非常有效。一旦编排顺序变了，diff 一眼就能看出差在哪。它比逐个 `assert isinstance(...)` 更能表达意图。

---

## 23.6 测护栏：注意 run_in_parallel

核心结论：护栏默认 `run_in_parallel=True`，写确定性测试时把它关掉。

护栏默认 `run_in_parallel=True`，意味着它和 Agent 并发执行。对测试而言，这会让“模型是否被调用”变得不确定，因为 tripwire 可能在模型调用前后任意时刻触发。把下面这段存成 `test_guardrail.py`，放在 `course_tests/` 下。

```python
import pytest

from agents import (
    Agent,
    GuardrailFunctionOutput,
    InputGuardrailTripwireTriggered,
    RunConfig,
    Runner,
    input_guardrail,
)
from agents.testing import ScriptedModel, assistant_message


@input_guardrail(name="no_pii", run_in_parallel=False)
async def no_pii(ctx, agent, user_input) -> GuardrailFunctionOutput:
    text = user_input if isinstance(user_input, str) else ""
    return GuardrailFunctionOutput(
        output_info={"checked": True},
        tripwire_triggered="身份证" in text,
    )


@pytest.mark.asyncio
async def test_input_guardrail_blocks_pii() -> None:
    model = ScriptedModel([[assistant_message("不会走到这里")]])
    agent = Agent(name="Support", model=model, input_guardrails=[no_pii])

    with pytest.raises(InputGuardrailTripwireTriggered):
        await Runner.run(
            agent,
            "我的身份证是 110101199001011234",
            run_config=RunConfig(tracing_disabled=True),
        )

    assert model.remaining_steps == 1  # 模型一步都没消费
```

连跑三个文件：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest course_tests/test_fixed_response.py course_tests/test_inventory_tool.py course_tests/test_guardrail.py -q
```

预期结果是 `3 passed`；护栏在模型之前拦下，`ScriptedModel` 的脚本一条都没被消费。`remaining_steps == 1` 这条断言同时证明了两件事：拦截确实发生，且发生在模型之前。它比只断言异常类型更有信息量。

输出护栏的写法对称，用 `@output_guardrail` 与 `OutputGuardrailTripwireTriggered`。注意输出护栏跑在最终输出上，所以模型脚本要准备到能产出最终结果为止。

---

## 23.7 测试里的 tracing：默认关掉

核心结论：测试里必须关掉 tracing，因为它是测试最容易忽略的副作用。

只要环境里有 `OPENAI_API_KEY`，默认处理器就会把测试流量传到追踪后端。你会得到一堆名为 `Agent workflow` 的噪声 trace，还会顺带消耗额度。

三种做法，按推荐度排序。

| 做法 | 写法 | 适用 |
| --- | --- | --- |
| 每次运行显式关闭 | `RunConfig(tracing_disabled=True)` | 最精确，推荐写进每个测试 |
| 全局夹具关闭 | `set_tracing_disabled(True)` 放 `conftest.py` | 整套测试都不想上报 |
| 环境变量 | `OPENAI_AGENTS_DISABLE_TRACING=1` | CI 环境统一配置 |

全局兜底用自动生效的夹具最省事。把下面这段存成 `conftest.py`，和上面的测试文件一起放在 `course_tests/` 里，让整个测试会话都不上报。

```python
# conftest.py
import pytest
from agents import set_tracing_disabled


@pytest.fixture(autouse=True)
def _disable_tracing() -> None:
    set_tracing_disabled(True)
```

预期结果是套件跑完，追踪后端里没有任何新增 trace。

注意两个细节。`set_tracing_disabled` 是全局状态，一旦设置会影响同进程后续所有运行，所以不要在某些测试里设 `True`、另一些里设 `False` 然后指望顺序无关。`ScriptedModel` 还有 `emit_traces` 参数，默认 `False`，只有确实想测 tracing 行为时才打开。

---

## 23.8 测流式：同一步脚本，两种消费方式

核心结论：一个普通的响应步同时支持 `Runner.run()` 与 `Runner.run_streamed()`，不用写两份脚本。

`ScriptedModel` 会自动生成 `response.created`、增量、`response.completed` 等规范化事件，所以大多数流式测试不需要手写事件序列。把下面这段存成 `test_streaming.py`，放在 `course_tests/` 下。

```python
import pytest

from agents import Agent, RawResponsesStreamEvent, RunConfig, Runner, RunItemStreamEvent
from agents.testing import ScriptedModel, assistant_message


@pytest.mark.asyncio
async def test_streaming_emits_message_item() -> None:
    model = ScriptedModel([[assistant_message("分三步完成。")]])
    agent = Agent(name="Planner", model=model)

    result = Runner.run_streamed(
        agent, "给个计划", run_config=RunConfig(tracing_disabled=True)
    )
    names: list[str] = []
    async for event in result.stream_events():
        if isinstance(event, RunItemStreamEvent):
            names.append(event.name)
        elif isinstance(event, RawResponsesStreamEvent):
            continue

    assert "message_output_created" in names
    assert result.final_output == "分三步完成。"
    model.assert_complete()
```

跑全部四个确定性测试：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest course_tests/ -m "not eval and not slow" -q
```

预期结果是 `4 passed`，`names` 里出现 `message_output_created`，`final_output` 与脚本一致。这条命令就是 PR 流水线的验收点。

只有当你需要精确的事件序列（例如测试“前三个 delta 的顺序”），才用 `ModelStep.stream(events, output=[...])`。文档明确提醒：那是 SDK 规范化后的事件，不是供应商的 wire chunk。想测协议序列化，请用真实适配器加可控网络层，那是另一个测试层级。

---

## 23.9 测试之后：评估（eval）在测什么

核心结论：测试问“我的编排逻辑对不对”，评估问“模型在真实任务上够不够好”，先把两者分开。

| 维度 | 测试（testing） | 评估（eval） |
| --- | --- | --- |
| 回答的问题 | 我的编排逻辑对不对 | 模型在真实任务上够不够好 |
| 是否调用真模型 | 否 | 是 |
| 判定方式 | 精确断言 | 指标、评分、人工抽检 |
| 频率 | 每次提交 | 每次发版或每晚 |
| 失败含义 | 代码有 bug | 质量回退或数据漂移 |

0.25.0 没有 `agents.evals` 这样的模块，官方也没有独立 evals 页面。`repo/docs/testing.md` 就是这套能力的权威说明。

仓库里的“eval”实践是另一种形态。`repo/examples/sandbox/tutorials/dataroom_metric_extract/evals.py` 与 `repo/examples/sandbox/tutorials/repo_code_review/evals.py` 都是黄金数据集校验脚本：把期望值写成常量表，读产物，逐条比对，失败就 `AssertionError`。

这给了我们一个务实的最小闭环：数据集、运行、评分、报告。下面这个骨架有真实模型参与，因此标记为慢测试。把它存成 `test_answer_quality.py`，放在 `course_tests/` 下；`real_agent` 是本文件内置的夹具，用 `Agent` 默认模型，需要 `OPENAI_API_KEY`。

```python
from dataclasses import dataclass

import pytest

from agents import Agent, RunConfig, Runner


@dataclass
class Case:
    question: str
    expected_keywords: list[str]


CASES = [
    Case("退货期是几天？", ["7", "天"]),
    Case("发票怎么开？", ["发票", "申请"]),
]


@pytest.fixture
def real_agent() -> Agent:
    return Agent(name="Support", instructions="简洁回答用户问题。")


@pytest.mark.eval
@pytest.mark.asyncio
async def test_answer_quality(real_agent: Agent) -> None:
    hits = 0
    for case in CASES:
        result = await Runner.run(
            real_agent,
            case.question,
            run_config=RunConfig(tracing_disabled=True, workflow_name="Eval nightly"),
        )
        answer = str(result.final_output)
        if all(keyword in answer for keyword in case.expected_keywords):
            hits += 1
    assert hits / len(CASES) >= 0.9
```

单独跑评估（会真实调用模型、产生费用）：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest course_tests/test_answer_quality.py -m eval -q
```

预期结果是打印或断言出通过率；低于 0.9 时这条测试失败，输出形如 `1 failed`。

三个设计原则决定评估集有没有用。

| 原则 | 具体做法 |
| --- | --- |
| 从真实失败里长出来 | 每个线上 bad case 都该变成一条用例，而不是凭空造题 |
| 评分要与业务对齐 | 关键词命中只是最低成本的代理指标；结构化任务更适合比对字段（第 20 章的 `output_type` 在这里直接复用）；开放式回答才需要 LLM-as-judge 或人工 |
| 看趋势不看单次 | 0.9 的阈值只是闸门，真正有价值的是通过率随时间的变化 |

> 提示：评估会花钱，也会因为模型升级而漂移。把它做成“每晚报一次”，而不是“每次提交跑一遍”。否则团队会因为等待和噪声直接把它关掉。

---

## 23.10 CI 里怎么分层

核心结论：CI 用 pytest marker 切成两条流水线——PR 跑确定性测试，评估放夜间。

| 流水线 | 命令 | 依赖 | 时长 |
| --- | --- | --- | --- |
| PR 快速检查 | `pytest -m "not eval and not slow"` | 无 API key、无网络 | 秒级 |
| 夜间评估 | `pytest -m eval` | 有 key、有配额 | 分钟级 |

要让 `-m` 生效，先在 `pyproject.toml` 或 `pytest.ini` 里注册 marker，否则 pytest 会警告。下面这段就是注册写法，追加到 SDK 根目录的 `pyproject.toml` 里。

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
markers = [
    "eval: 调用真实模型的质量评估，不在 PR 流水线运行",
    "slow: 耗时超过 5 秒的测试",
]
```

验证注册是否生效：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python -m pytest --markers | grep -E "eval|slow"
```

预期结果是 `pytest --markers` 能列出这两个 marker，未知标记的警告消失。

另外三条工程约束值得一起落地。第一，PR 流水线里不要注入 `OPENAI_API_KEY`，从机制上保证不会误调真模型。第二，把 `ScriptedModel` 的脚本当作“期望的编排形状”来维护，脚本改动必须与业务改动同 PR。第三，对每个 `ScriptedModel` 测试都调 `assert_complete()`，否则“少调了一次模型”这类退化不会被发现。

---

## 23.11 同一套思路的其他替身

核心结论：`agents.testing` 不只服务 Agent 运行，替身按边界分了三处，思路都是“在内存里、不发请求”。

| 边界 | 导入路径 | 主要符号 |
| --- | --- | --- |
| Agent 模型与沙箱 | `agents.testing` | `ScriptedModel`、`scripted_sandbox_session` |
| 实时会话 | `agents.realtime.testing` | `ScriptedRealtimeModel`、`RealtimeStep` |
| 语音流水线 | `agents.voice.testing` | `ScriptedSTTModel`、`ScriptedTTSModel` |

沙箱场景特别值得提一句。`scripted_sandbox_session()` 让你在不启动 Docker 的前提下测 `SandboxAgent` 的能力编排（第 13 章的内容）。脚本里按全局 FIFO 顺序描述 `exec`、`read`、`write` 等方法各自的返回值。这让“沙箱 Agent 的工具选择逻辑”终于可以被 CI 覆盖。

---

## 常见坑与排查

按症状查，每条都给出“症状 → 原因 → 修法”。

1. **症状**：测试偶发失败，报 `UnexpectedModelCall` 或 `UnconsumedModelSteps`。
   **原因**：脚本步数与实际编排不匹配（通常是改代码时忘了改脚本），或测试里存在并发与重试，导致多调了一次。
   **修法**：把脚本当作规格维护；用 `assert_complete()` 暴露剩余步；对重试类测试显式给出足够步数，并断言 `len(model.calls)`。

2. **症状**：测试跑了但什么都没验证，改坏代码也照样绿。
   **原因**：只断言了 `final_output`，而编排问题（少调工具、顺序颠倒）不体现在最终文本里。
   **修法**：按 23.5 用 `new_items` 拍平轨迹做整体断言；至少断言 `len(model.calls)` 与关键 item 类型。

3. **症状**：护栏测试时好时坏。
   **原因**：护栏默认 `run_in_parallel=True`，与模型并发，触发时机不确定。
   **修法**：测试里用 `@input_guardrail(run_in_parallel=False)`；或者只断言异常类型，不断言模型消费了几步。

4. **症状**：CI 上出现大量 `Agent workflow` 的 trace，还产生了费用。
   **原因**：环境里注入了 `OPENAI_API_KEY`，而 `ScriptedModel` 之外仍有真实客户端被构造（例如某个 Agent 没接管模型），tracing 默认开启。
   **修法**：CI 不注入 key；每个测试 `RunConfig(tracing_disabled=True)`；`conftest.py` 里 `set_tracing_disabled(True)` 兜底。

5. **症状**：脚本用对了却报 `InvalidModelStep`。
   **原因**：字典形态里写了不支持的键（只接受 `output`、`usage`、`response_id`、`request_id`、`raw_usage`、`error`、`responder`、`stream_events`、`retry_advice`），或同时给了 `error` 与 `responder`。
   **修法**：看 `InvalidModelStep.reason`（`unsupported_field`、`conflicting_outcomes` 等）与 `input_index`，直接定位第几步。

---

## 动手练习

工作目录是 SDK 根目录 `openai-agents-python/`。若 clone 在别处，按自己的目录替换，后文不再重复。

1. **写第一个回归**：先把主线的 `4 passed` 跑出来，再给你第 7 章写的任意一个工具 Agent 补一个 `ScriptedModel` 测试，要求覆盖“工具被调用”与“最终回答”两个断言，并调用 `assert_complete()`，确认变成 `5 passed`。
2. **注入失败**：用 `ModelStep.raise_error(RuntimeError("rate limited"))` 让第一次模型调用失败、第二次成功，验证你的重试或降级逻辑是否按预期工作（注意：`retry` 需要 `ModelSettings(retry=...)` 才会生效）。
3. **改造示例**：打开 `repo/examples/basic/stream_items.py`，为它补一个 `ScriptedModel` 版本（两步脚本：先 `function_call("how_many_jokes", {}, call_id="c1")`，再 `assistant_message("...")`），断言事件里出现 `tool_called` 与 `tool_output`。

---

## 本章小结

- `agents.testing` 在 `Model` 边界替换模型，运行循环、工具、护栏、session 都是真的。
- `ScriptedModel` 按序消费脚本，支持 `ModelStep`、字典、`ModelResponse`、output item 序列与异常五种形态；断言分两层，`model.calls` 看 SDK 发了什么，`result.new_items` 看 SDK 做了什么。
- `assert_complete()` 是防“工作流漂移”的最低成本手段，每个测试都该有。
- 护栏测试用 `run_in_parallel=False` 换取确定性，用 `remaining_steps` 证明拦截发生在模型之前。
- 测试里必须关 tracing，三种方式按精确度选择。
- 0.25.0 没有 `agents.evals`，评估要自建闭环；CI 分两层，PR 跑 `pytest -m "not eval and not slow"` 得到 `4 passed`，评估放夜间并看趋势。

---

## 延伸阅读

- 测试权威说明：`repo/docs/testing.md`
- 测试 API 参考：`repo/docs/ref/testing/model.md`、`repo/docs/ref/testing/sandbox.md`
- 源码：`repo/src/agents/testing/model.py`、`repo/src/agents/testing/sandbox.py`
- 黄金数据校验范式：`repo/examples/sandbox/tutorials/dataroom_metric_extract/evals.py`、`repo/examples/sandbox/tutorials/repo_code_review/evals.py`
- 仓库测试实践：`repo/tests/README.md`
- 下一章：《第24章 调试与可视化》——把失败的测试变成十分钟内可定位的问题。
