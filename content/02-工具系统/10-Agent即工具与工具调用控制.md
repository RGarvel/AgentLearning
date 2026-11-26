# 第10章 Agent即工具与工具调用控制

第 9 章我们把"别人的工具"接了进来。但 SDK 里还有一种更特别的工具：另一个 Agent。

一个负责分诊的管理者 Agent，可以把账单、物流、账号三个专家 Agent 当成工具来调用，自己保留与用户对话的控制权。这一章讲三件事：`Agent.as_tool()` 的每个参数、manager 模式的完整实现、以及如何用 `tool_use_behavior` 和 `tool_choice` 精确控制"模型必须调用谁"。

先定一条默认主线：第三节的"分诊 + 三个专家 + 结构化汇总"是完整可运行的标准用法。先把它跑通，再看其余参数与控制项，它们都按"可选微调"看待。

---

## 学习目标

- 能解释 `as_tool()` 内部发生了什么：Agent 如何变成一个 `FunctionTool`，输入输出如何被包装。
- 能列出 `as_tool()` 的十个以上参数，并说出每个在什么场景下必须传。
- 能独立实现"分诊 + 三个专家 + 结构化汇总"的 manager 模式。
- 能说出 `tool_use_behavior` 四种形态的差别，并在合适的时候用 `StopAtTools`。
- 能解释 `tool_choice` 强制调用为什么会死循环，以及 `reset_tool_choice` 怎么救场。
- 能在一张表里判断该用 agent-as-tool 还是 handoff。
- 能把示例存成脚本、在 SDK 根目录跑起来，并说出预期输出。

---

## 一、as_tool 到底做了什么

`Agent.as_tool()` 返回的是一个 `FunctionTool`，不是 `Handoff`。这是理解全章的前提。

内部流程分四步：

1. 用 `AgentAsToolInput`（就是一个 `{"input": str}` 的 Pydantic 模型）作为默认入参 schema；
2. 模型调用这个工具时，SDK 解析 JSON 拿到 `input` 字符串；
3. 用它作为 `Runner.run` 的输入，新开一次嵌套 run 跑目标 Agent；
4. 嵌套 run 结束后，把结果交回外层，外层继续自己的循环。

所以它有两个与 handoff 根本不同的性质，源码 docstring 写得很直白：

- **输入是"生成的"，不是完整历史**。嵌套 Agent 只看到你给的那段 `input`（或结构化参数渲染出的文本），看不到外层对话。
- **控制权不外移**。嵌套 Agent 跑完就结束，外层 Agent 继续拥有与用户的对话。

动手前把跑通本章要配的东西看全。表里每一项都标了漏配的后果。

| 配置项 | 在哪设 | 默认值 | 漏了或设错会报什么错 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 环境变量（第 2 章） | 无 | 第一次 `Runner.run` 报鉴权失败 |
| `tool_name` | `as_tool(tool_name=...)` | 必填 | 漏传会在构造期报缺参；传 `None` 则由 Agent 名派生 function 风格名 |
| `tool_description` | `as_tool(tool_description=...)` | 必填 | 模型失去"何时该用"的判断依据，专家几乎不被调用 |
| `tools=[...]` | 外层 `Agent(...)` | 空列表 | 工具没挂上，外层永远不会调用专家 |
| `output_type` | 外层 `Agent(output_type=...)` | `None` | manager 产不出结构化汇总，只能给自由文本 |
| `custom_output_extractor` | `as_tool(custom_output_extractor=...)` | `None` | 嵌套结果是 Pydantic 实例时被 `str()` 成单引号 repr |
| `session` | `as_tool(session=...)` | `None` | 嵌套 run 看不到父 run 的对话历史，专家答非所问 |
| `previous_response_id` / `conversation_id` | `as_tool(...)` | `None` | 服务端会话续接失效；与 `session` 混用会冲突 |
| `parameters` + `input_builder` | `as_tool(...)` | `None` | 只有自由文本 `input`，模型传参更容易出错 |
| `run_config` / `max_turns` / `hooks` | `as_tool(...)` | 继承父 run / `DEFAULT_MAX_TURNS` / `None` | 影响嵌套 run 的轮次与钩子，漏配则按默认走 |
| `reset_tool_choice` | `Agent(...)` | `True` | 关掉后强制调用无中断，run 打满 `max_turns` |
| `tool_choice` | `ModelSettings(tool_choice=...)` | `"auto"` | 设为 `"required"` 时只读请求也可能触发写工具 |
| `parallel_tool_calls` | `ModelSettings(parallel_tool_calls=True)` | 由 provider 决定 | 本该并行的多个专家调用被串行化 |
| `on_stream` / `on_stream_max_pending_events` | `as_tool(...)` | `None` / `1024` | 嵌套 run 是黑箱；队列长期满会取消嵌套 run 并走 `failure_error_function` |
| `needs_approval` | `as_tool(needs_approval=...)` | `False` | 专家动真格时不会暂停等人批准 |
| `tool_use_behavior` | `Agent(...)` | `"run_llm_again"` | 只对 `FunctionTool` 生效，托管工具无法截断 |

下面这段是最小可运行版本：一个支持 Agent 把账单专家当工具调用。存成 `as_tool_min.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
import asyncio

from agents import Agent, Runner

billing_agent = Agent(
    name="Billing agent",
    instructions="Answer billing questions: invoices, refunds, payment methods.",
)

support_agent = Agent(
    name="Support agent",
    instructions="Always call the billing tool for billing questions, then answer the user yourself.",
    tools=[
        billing_agent.as_tool(
            tool_name="ask_billing",
            tool_description="Answer questions about invoices, refunds and payment methods."
        )
    ],
)


async def main() -> None:
    result = await Runner.run(support_agent, "Why was I charged twice this month?")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python as_tool_min.py
```

预期结果：外层 Agent 先调 `ask_billing`，拿到专家的回答后自己组织语言回给用户，`final_output` 里是外层的措辞。

注意 `tool_name` 与 `tool_description` 是必须显式传的位置参数。可以传 `None`，此时 `tool_name` 回退为把 Agent 名转成 function 风格。

漏传 `tool_description` 会让模型失去"什么时候该用"的判断依据。这不是风格问题，是功能问题。

---

## 二、as_tool 的全参数表

参数不少，但常用的就那么几个，其余按需查表即可。

| 参数 | 默认 | 作用与注意点 |
| --- | --- | --- |
| `tool_name` | 必填 | 工具名；传 `None` 时由 Agent 名派生 |
| `tool_description` | 必填 | 工具描述，决定模型是否会在正确时机调用 |
| `custom_output_extractor` | `None` | `async (RunResult) -> str`，自定义返回给外层的文本 |
| `is_enabled` | `True` | bool 或 `(run_context, agent) -> bool`，隐藏工具 |
| `on_stream` | `None` | 接收嵌套 run 的流式事件，同步/异步皆可 |
| `on_stream_max_pending_events` | `1024` | 事件队列上限，`None` 表示不限制 |
| `run_config` | `None` | 为 `None` 时继承父 run 的 `run_config` |
| `max_turns` | `None` | 嵌套 run 的轮次上限，`None` 用 `DEFAULT_MAX_TURNS` |
| `hooks` | `None` | 只作用于嵌套 run 的 `RunHooks` |
| `previous_response_id` | `None` | 服务端会话续接（与 session 互斥） |
| `conversation_id` | `None` | 服务端会话续接 |
| `session` | `None` | 客户端会话；不会自动继承父 run 的 session |
| `failure_error_function` | `default_tool_error_function` | 嵌套失败时给外层的文案；`None` 表示抛出 |
| `needs_approval` | `False` | 与函数工具同一套中断/恢复流程 |
| `parameters` | `None` | Pydantic 模型或 dataclass，声明结构化入参 |
| `input_builder` | `None` | 把结构化参数渲染成嵌套 Agent 输入 |
| `include_input_schema` | `False` | 结构化输入时一并附上完整 JSON Schema |

三个最容易被忽略的参数值得展开。

**`custom_output_extractor`**。默认行为是直接返回嵌套 run 的 `final_output`。如果嵌套 Agent 设了 `output_type=SomeModel`，`final_output` 是一个 Pydantic 实例，而工具输出最终会被 `str()`，外层模型看到的是 Python repr。想给外层干净的 JSON，就自己抽。

下面这段从嵌套 run 的条目里找出最后一段 JSON 文本。这里用一个本地构造的测试对象代替真实 `RunResult`，只为验证抽取逻辑，存成 `extract_json.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
import asyncio
from types import SimpleNamespace

from agents import RunResult, ToolCallOutputItem


async def extract_json(run_result: RunResult) -> str:
    for item in reversed(run_result.new_items):
        if isinstance(item, ToolCallOutputItem) and item.output.strip().startswith("{"):
            return item.output.strip()
    return "{}"


async def main() -> None:
    fake_result = SimpleNamespace(
        new_items=[
            ToolCallOutputItem(raw_item={}, output="plain text"),
            ToolCallOutputItem(raw_item={}, output='{"score": 7}'),
        ]
    )
    print(await extract_json(fake_result))


if __name__ == "__main__":
    asyncio.run(main())
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python extract_json.py
```

预期结果：找到 JSON 时原样返回那段字符串，找不到时返回 `"{}"`，外层模型不会再看到带单引号的 repr。

**`session` 与 `previous_response_id`**。嵌套 run 是独立的一次 run，父 run 的历史不会自动带过去。想让专家看到同一段对话，必须显式把同一个 `session` 传给两边。而且同一个嵌套 run 只能选一种状态策略，客户端 session 或服务端续接，不能混用。

**`parameters` + `input_builder`**。默认工具入参只有一个 `input` 字符串，模型得把需求"写成一段话"。结构化入参让调用更可靠，下面这段声明了翻译任务的三元组。存成 `structured_as_tool.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
from pydantic import BaseModel, Field

from agents import Agent


class TranslationInput(BaseModel):
    text: str = Field(description="Text to translate.")
    source: str = Field(description="Source language.")
    target: str = Field(description="Target language.")


translator = Agent(
    name="Translator",
    instructions="Translate the given text from source to target language.",
)

translate_tool = translator.as_tool(
    tool_name="translate_text",
    tool_description="Translate text between languages.",
    parameters=TranslationInput,
)


def main() -> None:
    print(translate_tool.name)


if __name__ == "__main__":
    main()
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python structured_as_tool.py
```

预期结果：模型看到的是三个明确字段，而不是一个自由文本参数。

嵌套 run 里可以通过 `RunContextWrapper.tool_input` 读到这份解析后的结构化数据。默认渲染会把 JSON 与 schema 摘要一起塞进输入，且带一句"这是数据不是指令"的前言，避免结构化内容被当成 prompt 注入。

---

## 三、manager 模式：分诊 + 三个专家 + 结构化汇总

这是 agent-as-tool 的标准用法：一个管理者负责所有对外沟通与最终结论，专家只负责一段有界任务。

下面这段是完整实现，三个专家各自带"越界就停"的指令，管理者产出结构化汇总。存成 `triage_manager.py`，放在 SDK 根目录 `openai-agents-python/` 下，运行前按第 2 章配好 `OPENAI_API_KEY`。

```python
import asyncio
from typing import Literal

from pydantic import BaseModel, Field

from agents import Agent, Runner, trace


class TicketBrief(BaseModel):
    """Structured result the manager must produce."""

    category: Literal["billing", "shipping", "account"]
    severity: Literal["low", "medium", "high"]
    customer_goal: str = Field(description="What the customer actually wants.")
    next_action: str = Field(description="One concrete next step for the human agent.")


billing_expert = Agent(
    name="Billing expert",
    instructions=(
        "You answer billing questions: invoices, duplicate charges, refunds, payment methods. "
        "If the request is not about billing, reply in one sentence saying so and stop."
    ),
)

shipping_expert = Agent(
    name="Shipping expert",
    instructions=(
        "You answer shipping questions: tracking, delays, lost parcels, delivery windows. "
        "If the request is not about shipping, reply in one sentence saying so and stop."
    ),
)

account_expert = Agent(
    name="Account expert",
    instructions=(
        "You handle account questions: login, email change, plan upgrades, data export. "
        "If the request is not about the account, reply in one sentence saying so and stop."
    ),
)

triage_manager = Agent(
    name="Triage manager",
    instructions=(
        "You are the only agent that talks to the customer. "
        "Call the expert tools you need (one or more), then produce the structured brief yourself. "
        "Never invent facts an expert did not give you; if nobody can answer, set severity=high "
        "and put the open question in next_action."
    ),
    tools=[
        billing_expert.as_tool(
            tool_name="ask_billing",
            tool_description="Ask the billing expert about invoices, charges and refunds.",
        ),
        shipping_expert.as_tool(
            tool_name="ask_shipping",
            tool_description="Ask the shipping expert about tracking and delivery delays.",
        ),
        account_expert.as_tool(
            tool_name="ask_account",
            tool_description="Ask the account expert about login, profile and plan changes.",
        ),
    ],
    output_type=TicketBrief,
)


async def main() -> None:
    with trace("Support triage"):
        result = await Runner.run(
            triage_manager,
            "My invoice shows a duplicate charge AND my parcel is two weeks late.",
        )

    brief: TicketBrief = result.final_output
    print(brief.model_dump_json(indent=2))
    # 预期输出（示意）：
    # {
    #   "category": "billing",
    #   "severity": "high",
    #   "customer_goal": "Refund the duplicate charge and locate the delayed parcel.",
    #   "next_action": "Open a billing dispute and a shipping investigation in parallel."
    # }


if __name__ == "__main__":
    asyncio.run(main())
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python triage_manager.py
```

预期结果：`final_output` 是一个 `TicketBrief` 实例，`model_dump_json` 打出四个字段，`category` 与 `severity` 都是允许值之一。

设计要点有四个，都值得抄进自己的项目：

- **专家指令里写"越界就停"**。否则专家会热情地回答一切，manager 拿到的全是重复信息。
- **manager 的 `output_type` 承担"汇总"职责**。别指望专家各自输出结构化对象再拼，它们看到的上下文不同，字段对不齐。
- **一次调用可以并行调多个工具**（默认 `parallel_tool_calls` 由 provider 决定）。所以"账单一事、物流一事"能在同一轮里问完，延迟接近单个专家。
- **嵌套 run 的所有 token 都计入总成本**。三个专家就是三份额外账单；分诊逻辑能写在代码里就不要交给模型（见下一章 routing）。

---

## 四、tool_use_behavior：工具结果要不要回给模型

默认情况下，工具跑完要把结果喂回模型，让模型决定下一步。有三种情况你想"截断"这个循环：结果是最终答案、只关心某一个工具、或者你想自己拼输出。这就是 `tool_use_behavior`。

| 取值 | 行为 | 典型场景 |
| --- | --- | --- |
| `"run_llm_again"`（默认） | 工具结果回给模型，模型继续 | 绝大多数情况 |
| `"stop_on_first_tool"` | 第一个工具的输出直接作为最终结果 | 单工具、确定性流程 |
| `StopAtTools(stop_at_tool_names=[...])` | 命中指定工具名时停止并取其输出 | 混合场景：普通工具继续，终结工具截断 |
| `ToolsToFinalOutputFunction` | 你自己写函数判断"是不是最终结果" | 需要业务判断或格式化 |

下面这个 Agent 只在 `get_weather` 命中时截断，`sum_numbers` 照常回给模型。存成 `stop_at_tools.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
from agents import Agent, StopAtTools
from agents.decorators import tool


@tool
def get_weather(city: str) -> str:
    """Return the weather for a city."""
    return f"{city}: sunny"


@tool
def sum_numbers(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


agent = Agent(
    name="Stop-at-tools agent",
    instructions="Get weather or sum numbers.",
    tools=[get_weather, sum_numbers],
    tool_use_behavior=StopAtTools(stop_at_tool_names=["get_weather"]),
)


def main() -> None:
    print(agent.name, agent.tool_use_behavior)


if __name__ == "__main__":
    main()
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python stop_at_tools.py
```

预期结果：问天气时 run 直接以工具输出收尾；问求和时结果回到模型，由模型继续组织回答。

自定义函数形态要注意签名：它收到的是 `list[FunctionToolResult]`，返回 `ToolsToFinalOutputResult`。存成 `custom_behavior.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
import asyncio
from typing import Any

from agents import (
    FunctionToolResult,
    RunContextWrapper,
    ToolsToFinalOutputResult,
)
from agents.decorators import tool


async def custom_behavior(
    context: RunContextWrapper[Any], results: list[FunctionToolResult]
) -> ToolsToFinalOutputResult:
    weather = results[0].output
    return ToolsToFinalOutputResult(is_final_output=True, final_output=f"{weather} (cached)")


@tool
def get_weather(city: str) -> str:
    """Return the weather for a city."""
    return f"{city}: sunny"


async def main() -> None:
    ctx = RunContextWrapper(context={})
    results = [FunctionToolResult(tool=get_weather, output="Hangzhou: sunny", run_item=None)]
    outcome = await custom_behavior(ctx, results)
    print(outcome.is_final_output, outcome.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python custom_behavior.py
```

预期结果：`is_final_output=True` 时 run 立刻收尾，最终输出是拼上 `(cached)` 的那句话。

> 注意：`tool_use_behavior` 只对 `FunctionTool` 生效。`WebSearchTool`、`FileSearchTool` 这类托管工具的结果永远由模型处理，你无法用这个开关截断。

---

## 五、tool_choice：让模型"必须调用"

`tool_use_behavior` 管的是"调用之后"，`tool_choice` 管的是"调用之前"。它设在 `ModelSettings` 上，下面这段强制先查工单。存成 `tool_choice.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
from agents import Agent, ModelSettings
from agents.decorators import tool


@tool
def lookup_ticket(ticket_id: str) -> str:
    """Look up a support ticket by id."""
    return "status: open"


agent = Agent(
    name="Ticket agent",
    instructions="Look up the ticket before answering.",
    tools=[lookup_ticket],
    model_settings=ModelSettings(tool_choice="lookup_ticket"),
)


def main() -> None:
    print(agent.name)


if __name__ == "__main__":
    main()
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python tool_choice.py
```

预期结果：第一轮请求里模型必定调用 `lookup_ticket`，而不是先寒暄或直接编答案。

四种取值各有用途：`"auto"`（默认）、`"required"`（必须用某个工具，模型自选）、`"none"`（禁止工具）、以及具体工具名。托管 MCP 场景还可以用 `MCPToolChoice(server_label="...", name="...")` 精确指定。

这里有个必须理解的机制：模型被强制要求调用工具，而工具结果又要回给模型，模型就会再调一次，于是无限循环。

SDK 的对策是 `Agent.reset_tool_choice`（默认 `True`）：工具调用发生后把 `tool_choice` 重置为默认值，循环自然被打断。只有当你明确要"每一轮都必须调工具"时才关掉它，并且自己保证有终止条件。

强制调用还有一个安全提醒。`"required"` 会让模型从现有工具里随便挑一个。如果这个 Agent 只有"关闭工单""加评论"这类写工具，一个只读的查询请求也可能触发写操作。只读场景请只暴露只读工具，或用具体工具名而不是 `"required"`。

---

## 六、把嵌套 run 变成可见的

manager 模式最大的运维痛点是"黑箱"：外层模型只拿到一段最终文本，中间发生了什么你看不到。两个参数解决它。

`on_stream` 让你订阅嵌套 run 的流式事件。事件类型与 `stream_events()` 一致，即 `raw_response_event`、`run_item_stream_event`、`agent_updated_stream_event`。

下面这个回调把每条嵌套事件打一行日志，并带上来源 Agent 与 call_id。存成 `nested_stream.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
from agents import Agent, AgentToolStreamEvent

billing_agent = Agent(
    name="Billing agent",
    instructions="Answer billing questions: invoices, refunds, payment methods.",
)


def log_nested(event: AgentToolStreamEvent) -> None:
    stream = event["event"]
    tool_call = event.get("tool_call")
    call_id = tool_call.call_id if tool_call is not None else "direct"
    print(f"[{event['agent'].name}] {stream.type} call={call_id}")


billing_tool = billing_agent.as_tool(
    tool_name="ask_billing",
    tool_description="Ask the billing expert.",
    on_stream=log_nested,
)


def main() -> None:
    print(billing_tool.name)


if __name__ == "__main__":
    main()
```

在 SDK 根目录运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python nested_stream.py
```

预期结果：嵌套 run 的每条事件按序打印，行首是专家名，行尾是 call_id 或 `direct`。

传了 `on_stream` 之后，嵌套 Agent 自动以流式方式执行，事件按序送达后再返回最终输出。`on_stream_max_pending_events` 控制积压上限，队列长期满会取消嵌套 run 并走 `failure_error_function`。

`needs_approval` 则把"专家要动真格"的时刻变成可中断的。为工具设 `True` 或策略函数后，run 会在调用专家前暂停，待审批项进 `result.interruptions`，`RunState.approve/reject` 后带着 state 续跑。

嵌套 run 的待审批项会一并出现在外层的 `result.interruptions` 里。`RunState.approve/reject` 会自动路由到对应的嵌套状态，你不需要自己进内层去批。

---

## 七、Agent 当工具 vs handoff

两者的分界线是"谁拥有最终答案"，其余差异都从这一条派生。

| 维度 | `as_tool()`（manager 模式） | `handoff`（去中心化） |
| --- | --- | --- |
| 谁拥有最终答案 | 管理者（外层）Agent | 接手的目标 Agent |
| 子 Agent 看到的历史 | 只有你生成的输入 | 默认是完整对话历史 |
| 控制权 | 回来后继续 | 转移出去，不再回来 |
| 能否并行调用 | 能（同一轮多个工具） | 不能（一次只交接给一个） |
| 用户可见的"说话人" | 始终是管理者 | 会切换成专家 |
| 成本 | 每次调用都多一份上下文与 token | 只在交接后多一份 |
| 适合 | 有界子任务、需要汇总多方结论、统一话术 | 专家要直接服务用户、话术差异大、任务长 |

一句话判断："专家说完话要回来汇报"用 `as_tool`；"专家接手后自己跟用户聊下去"用 handoff。handoff 的完整参数与多级转接在第 12 章。

---

## 常见坑与排查

按症状查，每条都给出"症状 → 原因 → 修法"。

1. **管理者回答"我不知道"，专家明明答了**
   症状：专家侧有输出，外层却说没拿到信息。
   原因：没传 `tool_description`，模型不知道何时调用；或专家输出被 `str()` 成 repr。
   修法：写清 `tool_description`，需要干净 JSON 时加 `custom_output_extractor`。
2. **嵌套 Agent 完全不知道上文**
   症状：专家答非所问，像第一次见到这个问题。
   原因：这是设计如此，嵌套 run 只看你生成的输入，不是 bug。
   修法：把必要背景写进调用参数，或父子共享同一个 `session`。
3. **`tool_choice="required"` 导致 run 打满 `max_turns`**
   症状：run 一轮接一轮，最后撞上轮次上限。
   原因：模型每轮都被要求调工具，结果回给模型后又被要求再调。
   修法：保留 `reset_tool_choice=True`，或只在第一轮用 `required`。
4. **设了 `tool_use_behavior="stop_on_first_tool"` 但托管工具没截断**
   症状：托管工具跑完，模型仍在继续生成。
   原因：该开关只对 `FunctionTool` 生效。
   修法：把托管工具换成函数工具包一层，或改用自定义结束条件。
5. **嵌套 run 超时/超轮次，外层却"正常返回"**
   症状：专家其实失败了，外层只看到一句模糊提示。
   原因：`failure_error_function` 默认把失败转成一句脱敏文案。
   修法：显式传 `None` 让异常抛出，或自定义函数带上可诊断信息。
6. **并行调用被串行化**
   症状：本该同时发起的多个工具调用一个接一个。
   原因：模型没被允许并行，或 provider 默认关闭。
   修法：`ModelSettings(parallel_tool_calls=True)`，并确认工具之间真的无依赖。

---

## 动手练习

本章练习都在 SDK 根目录 `openai-agents-python/` 下执行；若 clone 在别处，按自己的目录替换。

1. 把第 7 章的"查库存 + 下单"拆成两个专家 Agent，用 `as_tool` 挂到一个管理者上，观察管理者是否会先查库存再下单。
2. 给管理者加上 `output_type` 的结构化汇总，再用 `custom_output_extractor` 把专家输出裁成纯 JSON 返回，对比加与不加时 `result.final_output` 的差异。
3. 打开 `repo/examples/agent_patterns/agents_as_tools.py`，把第三个翻译 Agent 的 `as_tool` 加上 `is_enabled` 条件（例如"目标语言是意大利语时禁用"），验证从工具列表消失后模型的行为。

---

## 本章小结

- `as_tool()` 把 Agent 包成 `FunctionTool`：输入是生成的，控制权不外移。
- `tool_name`/`tool_description` 是必填位置参数；描述决定模型是否在对的时机调用。
- 嵌套 run 的状态、轮次、hooks 都是独立的，需要显式传 `session`、`max_turns`、`hooks`；`parameters` + `input_builder` 让"传参"比"写一段话"更可靠。
- `tool_use_behavior` 四种形态决定"结果回不回模型"，且只对函数工具生效。
- `tool_choice` 强制调用，靠 `reset_tool_choice` 防死循环；只读场景别滥用 `"required"`。
- `on_stream` 让嵌套 run 可见，`needs_approval` 让嵌套 run 可中断；manager vs handoff 的核心区别是"谁拥有最终答案"。
- 脚本都放 `openai-agents-python/`，先跑第三节 manager 主线，用 `python <文件名>` 运行。

---

## 延伸阅读

- `repo/docs/tools.md`（Agents as tools 一节，含 structured input、streaming、conditional enabling）
- `repo/src/agents/agent.py`（`as_tool`、`ToolsToFinalOutputResult`、`StopAtTools`）
- `repo/src/agents/agent_tool_input.py`（默认入参与结构化渲染）
- `repo/examples/agent_patterns/agents_as_tools.py`、`agents_as_tools_structured.py`、`agents_as_tools_streaming.py`、`agents_as_tools_conditional.py`
- 下一章：《第11章 多智能体设计模式》——把这套零件组织成可维护的架构。
