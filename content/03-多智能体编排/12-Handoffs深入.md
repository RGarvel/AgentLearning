# 第12章 Handoffs深入

第 11 章我们把"谁拥有最终答案"当成选架构的第一问。选定交接之后，问题立刻变得具体：交接工具叫什么、模型能不能带参数、下一个 Agent 看到多少历史、交错了怎么办。

这一章把 `handoff()` 的每个参数、输入过滤器的写法，以及 0.25 里仍是 beta 的"嵌套历史"讲清楚。最后落到一个三级转接的完整实现。

## 学习目标

- 能解释交接（handoff）在运行时表现为"一个工具调用 + 一次 Agent 切换"。
- 能列出 `handoff()` 的全部参数，并说明 `input_type` 与 `on_handoff` 的签名约束。
- 能写出三种 `input_filter`：删除工具项、只留最近 N 条、脱敏。
- 能说清 `RunConfig.handoff_input_filter` 与 per-handoff 过滤器的优先级。
- 能解释 `nest_handoff_history` 解决什么问题，以及为什么它不能当脱敏用。
- 能处理多跳交接、`last_agent` 定位，以及 session 与服务端会话的互斥约束。

## 一、handoff 在运行时是什么

对模型来说，交接就是一个工具调用。

给 `Refund Agent` 做交接，模型看到的工具名默认是 `transfer_to_refund_agent`。这个名字由 `Handoff.default_tool_name()` 生成，并经过函数名规范化处理。

模型调用它之后，SDK 按固定顺序做五件事：

1. 记下这次调用（`HandoffCallItem`）；
2. 执行 `on_invoke_handoff`，拿到目标 Agent；
3. 写一条工具输出 `{"assistant": "<agent name>"}`（`HandoffOutputItem`）；
4. 触发 `on_handoff` 钩子，按需过滤历史；
5. 把"当前 Agent"换成目标 Agent，继续同一个 run 的下一轮。

所以交接**始终在同一个 run 内**：不新开 trace，不重置 usage。

护栏的边界也随之确定。输入护栏只作用于链首 Agent，输出护栏只作用于产出最终输出的 Agent。

## 二、handoff() 的全参数

`handoff()` 的参数不多，但每一个都对应一处行为。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `agent` | 必填 | 交接目标；`handoff()` 永远只返回这一个目标 |
| `tool_name_override` | `None` | 覆盖默认的 `transfer_to_<name>` |
| `tool_description_override` | `None` | 覆盖默认描述（默认会拼接 `handoff_description`） |
| `on_handoff` | `None` | 交接被调用时执行；参数个数由 `input_type` 决定 |
| `input_type` | `None` | 声明交接工具的参数模型；必须同时给 `on_handoff` |
| `input_filter` | `None` | 过滤传给下一个 Agent 的历史 |
| `nest_handoff_history` | `None` | 单次交接覆盖 `RunConfig.nest_handoff_history` |
| `is_enabled` | `True` | bool 或 `(ctx, agent) -> bool`，关掉即从工具列表消失 |
| `failure_error_function` | `None` | 交接调用失败时给"调用方"的文本；`None` 表示异常照抛 |

签名规则很严格，写错直接 `UserError`。三种情况对照如下：

| 写法 | 结果 |
| --- | --- |
| 给了 `input_type` 却没给 `on_handoff` | 直接报错 |
| 有 `input_type` 时 `on_handoff` 的参数 | 必须恰好两个：`(ctx, input)` |
| 无 `input_type` 时 `on_handoff` 的参数 | 必须恰好一个：`(ctx)` |

这段验证带参数的交接。`input_type` 声明元数据，`on_handoff` 负责把它记下来。

```python
import asyncio

from pydantic import BaseModel

from agents import Agent, RunContextWrapper, Runner, handoff, trace


class EscalationData(BaseModel):
    reason: str
    priority: str = "normal"


async def log_escalation(ctx: RunContextWrapper[None], data: EscalationData) -> None:
    print(f"[handoff] escalate reason={data.reason} priority={data.priority}")


human_queue = Agent(
    name="Human queue",
    instructions="Acknowledge the escalation and tell the customer a human will follow up.",
)

triage = Agent(
    name="Triage",
    instructions=(
        "Help with simple questions. Escalate to the human queue when the customer is angry "
        "or the request involves money already taken."
    ),
    handoffs=[
        handoff(
            human_queue,
            tool_name_override="escalate_to_human",
            tool_description_override="Escalate the conversation to a human agent.",
            on_handoff=log_escalation,
            input_type=EscalationData,
        )
    ],
)


async def main() -> None:
    with trace("Escalation demo"):
        result = await Runner.run(
            triage,
            "I was charged twice and nobody replies. This is unacceptable.",
        )
    print("last_agent:", result.last_agent.name)
    print(result.final_output)
```

预期先看到一行 `[handoff] escalate reason=... priority=...`，再看到 `last_agent: Human queue` 和人工 Agent 的答复。

`input_type` 只描述**交接工具的参数**。它不替换下一个 Agent 的主输入，也不参与选择目标。

它适合传"模型当场决定的小元数据"，比如原因、优先级、语言。应用状态不要放这里，那属于 `RunContextWrapper.context`。

## 三、直接传 Agent 与显式 handoff() 的差别

两种写法在运行时等价。

`handoffs=[billing_agent]` 和 `handoffs=[handoff(billing_agent)]` 效果一样，SDK 会把裸 Agent 转成默认 Handoff。差别只在可定制程度。

| 能力 | 直接传 Agent | 显式 `handoff()` |
| --- | --- | --- |
| 工具名 | 固定 `transfer_to_<name>` | 可覆盖 |
| 描述 | 默认描述 + `handoff_description` | 可完全覆盖 |
| 参数化交接 | 不支持 | `input_type` |
| 日志/预取 | 不支持 | `on_handoff` |
| 历史过滤 | 只能靠 `RunConfig.handoff_input_filter` | per-handoff `input_filter` |
| 动态开关 | 不支持 | `is_enabled` |

实用建议：**先用裸 Agent 跑通，需要定制时再升级成 `handoff()`**。

裸 Agent 的 `handoff_description` 就是最轻量的"何时该选我"提示。很多项目到这一步就够了。

## 四、input_filter 的三种典型写法

交接默认把整段历史交给目标 Agent，这在多数场景是对的。但三种情况必须过滤。

**1. 删除所有工具项**。工具调用记录对下一个 Agent 通常无用，还占 token。官方准备了现成的：

```python
from agents import Agent, handoff
from agents.extensions import handoff_filters

faq_agent = Agent(name="FAQ agent", instructions="Answer FAQ questions.")
faq_handoff = handoff(faq_agent, input_filter=handoff_filters.remove_all_tools)
```

预期：目标 Agent 拿到的历史里不再有任何工具条目，只剩对话文本。

它删掉 `ToolCallItem`、`ToolCallOutputItem`、`HandoffCallItem`、`ReasoningItem`、审批项等结构化条目，也清掉 `input_history` 里对应类型的 dict。

**它不会删掉已经写进普通消息文本里的工具结果**。这一点在脱敏场景很致命。

**2. 只保留最近 N 条**。长对话交接给专家时，前面的寒暄没必要带走：

```python
from agents import HandoffInputData


def keep_last_six(data: HandoffInputData) -> HandoffInputData:
    history = data.input_history
    if isinstance(history, tuple):
        history = history[-6:]
    return data.clone(input_history=history, pre_handoff_items=())
```

预期：目标 Agent 只看到最后 6 条历史，本轮之前产生的条目被清空。

`HandoffInputData` 有五个字段，别记混：

| 字段 | 装什么 |
| --- | --- |
| `input_history` | run 开始前的输入 |
| `pre_handoff_items` | 本轮之前产生的条目 |
| `new_items` | 本轮新产生的条目，含交接调用本身 |
| `run_context` | 运行上下文 |
| `input_items` | 只影响模型输入，不影响 session 历史 |

`clone(**kwargs)` 是最安全的改法，别手工 new 一个。

**3. 脱敏**。把手机号、卡号从文本里替换掉：

```python
import re

from agents import HandoffInputData

CARD = re.compile(r"\b\d{16}\b")


def redact_cards(data: HandoffInputData) -> HandoffInputData:
    def scrub(item):
        if isinstance(item, dict) and isinstance(item.get("content"), str):
            return {**item, "content": CARD.sub("[redacted]", item["content"])}
        return item

    history = data.input_history
    if isinstance(history, tuple):
        history = tuple(scrub(item) for item in history)
    return data.clone(input_history=history)
```

预期：卡号在交给下一个 Agent 之前变成 `[redacted]`，其余文本一字不动。

## 五、RunConfig.handoff_input_filter：全局默认

一个一个交接写过滤器不现实。`RunConfig(handoff_input_filter=...)` 给整次 run 的所有交接设默认值。

优先级上，**per-handoff 的 `input_filter` 优先**。

```python
from agents import RunConfig

run_config = RunConfig(handoff_input_filter=handoff_filters.remove_all_tools)
result = await Runner.run(triage, "Where is my order?", run_config=run_config)
```

预期：这次 run 里的每次交接都按 `remove_all_tools` 过滤，包括那些没有单独写 `input_filter` 的交接。

它适合"公司统一合规要求：任何交接都不允许带工具参数"这类场景。

注意它与 `nest_handoff_history` 互斥。只要设了任一过滤器，无论 handoff 级还是 run 级，自动嵌套就不生效。

## 六、nest_handoff_history 与 handoff_history_mapper

多级交接最烦的问题是**历史复利**。

A 交给 B，B 交给 C，每次交接都把前面全部消息原样带过去。到第五跳时，上下文里已经有四份"交接说明"，token 爆炸、重点模糊。

`nest_handoff_history` 解决的正是这件事。它在 `RunConfig` 上默认 `False`，仍是 beta。

开启后，它把可归纳的历史压成**有序的 assistant 摘要段**，用 `<CONVERSATION HISTORY>` 包起来，同时把无损的消息项留在原位置。后续再交接时，之前的摘要段会被"摊平"后重新组织，不会层层套娃。

这段验证自定义摘要：只截尾部 8 条，再交给内置 mapper。

```python
from agents import RunConfig, TResponseInputItem
from agents.handoffs import default_handoff_history_mapper


def compact(transcript: list[TResponseInputItem]) -> list[TResponseInputItem]:
    """Keep only the tail of the transcript, then summarise it."""
    return default_handoff_history_mapper(transcript[-8:])


run_config = RunConfig(
    nest_handoff_history=True,
    handoff_history_mapper=compact,  # 不传则用内置的分段摘要
)
```

预期：下一跳收到的是尾部 8 条的摘要版本，而不是完整历史。

规则要记牢，否则会踩到很隐晦的坑：

- 只设 `nest_handoff_history=True` 时用内置摘要；设了 `handoff_history_mapper` 时，**它的返回值就是下一跳的完整输入历史**。
- 单次交接可以用 `handoff(..., nest_handoff_history=True/False)` 覆盖全局。
- **它不是脱敏机制**。摘要由 `input_history`、`pre_handoff_items`、`new_items` 拼出来，工具参数与输出可能原样进摘要。要脱敏，就在调用它之前清洗这三个字段，或清洗它返回的 `input_history`。
- 只过滤 `input_items` **不能**阻止内容进入嵌套摘要。
- 想换包裹标记，用 `set_conversation_history_wrappers(start=..., end=...)`；换回来用 `reset_conversation_history_wrappers()`。

## 七、on_handoff 里做什么

`on_handoff` 在"确定要交接"之后、"切换 Agent"之前执行。

这是唯一一个"你已经知道要转给谁、但对方还没开始说话"的时刻。适合做三件事：

1. **留痕**：把 `input_type` 里的 `reason` 写进业务日志或工单系统（上面的例子）。
2. **预取**：立刻按客户 ID 拉订单，塞进 `ctx.context`，目标 Agent 一上来就有数据。
3. **授权检查**：`is_enabled` 在模型产出参数之前求值，**无法**校验参数内容；需要按字段做授权时，就在 `on_handoff` 开头检查并 `raise`，抛异常即中止交接。

注意 `on_handoff` 里已经发生的副作用不会回滚。

如果不想只为日志写一个 `on_handoff`，也可以挂 `RunHooks`/`AgentHooks` 的 `on_handoff(context, from_agent, to_agent)`。它没有交接参数可用，但胜在全局统一，且不需要改每个 handoff 的定义。

两者的分工是：**需要模型决定的元数据用 `on_handoff`，只需要知道"谁转给谁"用 hooks**。

## 八、多跳、last_agent 与"多个交接同时请求"

多跳很常见：分诊 → 专家 → 人工。

全程一个 run，`result.last_agent` 指向最后接手的 Agent。流式场景则用 `result.current_agent`。

想看完整轨迹，遍历 `result.new_items` 里的 `HandoffCallItem` 与 `HandoffOutputItem`。

还有一个提示词层面的技巧。交接工具的描述是模型唯一的决策依据，官方在 `agents.extensions.handoff_prompt` 里提供了 `RECOMMENDED_PROMPT_PREFIX`。

把它拼进 Agent 的 instructions，模型对"何时该交接、交接后该做什么"的理解会稳定很多。它不是魔法，但能显著减少"该转不转"和"转完还自己答"这两类问题。

如果模型在同一轮请求了多个交接，SDK **只执行第一个**。其余各写一条 `"Multiple handoffs detected, ignoring this one."` 的工具输出，并在 handoff span 上记错误。

这是刻意的：一次只能有一个"当前 Agent"。

## 九、session 与服务端会话的互斥约束

交接与服务端托管会话互斥。

- 交接**不支持服务端托管会话**（`conversation_id`、`previous_response_id`、`auto_previous_response_id`）。设了 `input_filter` 会直接 `UserError`；设了 `nest_handoff_history` 会打 warning 并自动关闭，退回"只发增量输入"。
- 客户端 `session` 与交接兼容，因为历史由 SDK 组装。但一个 run 只能选一种状态策略。
- 交接发生在**同一个 run** 内，所以 `max_turns` 是整个链条共享的预算，不是每跳一份。多级转接很容易撞上限，记得调大。

实践上的取舍很清楚。需要精细控制"每一跳看到什么"的系统，必须用客户端 `session` 加过滤器。

只想省事、且能接受整体历史自动延续的，才用服务端会话。这时要把交接设计成"不改变权限级别"的平级转接。

## 十、三级转接完整示例

分诊 → 账单专家 → 人工队列。两跳，三种工具，一个结构化交接参数。

这段验证完整链路：两次交接，一个 `input_type`，一个 `on_handoff` 日志。

```python
import asyncio

from pydantic import BaseModel

from agents import Agent, RunContextWrapper, Runner, handoff, trace


class Escalation(BaseModel):
    reason: str
    priority: str = "normal"


async def on_escalate(ctx: RunContextWrapper[None], data: Escalation) -> None:
    print(f"[escalate] reason={data.reason} priority={data.priority}")


human_agent = Agent(
    name="Human agent",
    instructions=(
        "You are a human support specialist. Acknowledge the case, state what you will do next, "
        "and never promise a refund amount you cannot verify."
    ),
)

billing_agent = Agent(
    name="Billing agent",
    instructions=(
        "Resolve billing questions: invoices, duplicate charges, refund requests. "
        "If the customer demands compensation or the amount exceeds 500 CNY, escalate to the human."
    ),
    handoffs=[
        handoff(
            human_agent,
            tool_name_override="escalate_to_human",
            tool_description_override="Escalate a billing case that needs human approval.",
            on_handoff=on_escalate,
            input_type=Escalation,
        )
    ],
)

triage_agent = Agent(
    name="Triage agent",
    instructions=(
        "Greet the customer, then route: billing issues go to the billing agent, everything else "
        "answer yourself."
    ),
    handoffs=[billing_agent],
)


async def main() -> None:
    with trace("Three-level transfer"):
        result = await Runner.run(
            triage_agent,
            "I was charged 899 CNY twice this month and I want compensation.",
        )

    print("final agent:", result.last_agent.name)
    print("handoffs:", [i.type for i in result.new_items if i.type.startswith("handoff")])
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

预期输出里能看到 `final agent: Human agent`，`handoffs` 列表有两条交接记录，最后是人工 Agent 的答复。

如果第二跳没发生，先检查账单专家的 instructions 是否真的写了阈值。交接是否发生，本质上是模型基于工具描述做的决策，而不是代码分支。

## 常见坑与排查

1. **交接后目标 Agent 完全不记得前文**
   - 症状：接手后一问三不知，像刚进对话。
   - 原因：你设了 `input_filter` 把历史清空了，或用了服务端会话导致只发增量。
   - 修法：先用默认过滤器跑通，再逐条加限制。

2. **`on_handoff` 报"必须接收一个/两个参数"**
   - 症状：定义 Agent 时直接抛参数错误。
   - 原因：签名与 `input_type` 不匹配。
   - 修法：有 `input_type` 写 `(ctx, data)`，否则写 `(ctx)`。

3. **开了 `nest_handoff_history` 却毫无变化**
   - 症状：上下文占用没有下降，历史还是原样。
   - 原因：同时设了 `input_filter`（任一层级），自动嵌套被跳过。
   - 修法：二选一，或在自定义过滤器里自己调 `nest_handoff_history`。

4. **以为嵌套摘要能脱敏**
   - 症状：敏感字段仍然出现在下一跳的输入里。
   - 原因：摘要里可能含工具参数原文。
   - 修法：先清洗源字段再摘要，或清洗其返回的 `input_history`。

5. **配了 `conversation_id` 后交接报错**
   - 症状：一跑就 `UserError`。
   - 原因：服务端会话不支持输入过滤器。
   - 修法：去掉过滤器，或改用客户端 `session`。

6. **多跳后撞 `MaxTurnsExceeded`**
   - 症状：链条没走完就中断。
   - 原因：`max_turns` 是整条链共享。
   - 修法：按链路长度设置（例如每跳预留 3-5 轮）。

## 动手练习

三题都在 SDK 根目录下完成。先跑一遍基线示例，确认环境是通的：

```bash
# 工作目录：repo/openai-agents-python/（SDK 根目录）
cd repo/openai-agents-python
python examples/handoffs/message_filter.py
```

如果你的仓库 clone 在别处（比如目录名就叫 `repo`），把上面的路径换成自己的即可，后文命令同此。

1. 给 `handoff(..., input_type=...)` 加一个 `priority` 字段，在 `on_handoff` 里按优先级决定是否直接 `raise` 拒绝交接。
2. 写一个 `input_filter`：保留全部 user 消息、删除所有工具项、并把 assistant 消息截断到 200 字。用 `to_input_list()` 打印验证效果。
3. 打开 `repo/examples/handoffs/message_filter.py`，把它的 `spanish_handoff_message_filter` 改成同时调用 `nest_handoff_history`，并说明为什么"先 remove_all_tools 再嵌套"与"先嵌套再过滤"结果不同。

## 本章小结

- 交接 = 一个工具调用 + 一次 Agent 切换，全程同一个 run，共享 usage 与 `max_turns`。
- 裸 Agent 够用就不要写 `handoff()`，需要改名、参数、日志、过滤时再升级；`input_type` 只装"模型当场决定的元数据"，状态请放 context。
- `input_filter` 用 `clone()` 改，`remove_all_tools` 不负责脱敏；per-handoff 过滤器优先于 `RunConfig.handoff_input_filter`，且任一过滤器都会让自动嵌套失效。
- `nest_handoff_history` 治"历史复利"，不是安全机制；`handoff_history_mapper` 可完全接管下一跳输入。
- 服务端托管会话与交接过滤器互斥，多级转接要留足 `max_turns`。
- `handoff_description` 与 `RECOMMENDED_PROMPT_PREFIX` 决定模型会不会在该转的时候转，值得和 instructions 一起打磨。

## 延伸阅读

- `repo/docs/handoffs.md`（参数、input_type、input filter、nested history 全节）
- `repo/src/agents/handoffs/__init__.py`（`handoff()`、`Handoff`、`HandoffInputData`）
- `repo/src/agents/handoffs/history.py`（`nest_handoff_history`、`default_handoff_history_mapper`）
- `repo/src/agents/extensions/handoff_filters.py`、`repo/src/agents/extensions/handoff_prompt.py`
- `repo/examples/handoffs/message_filter.py`、`repo/examples/agent_patterns/routing.py`
- 下一章：《第13章 沙箱Agent与真实工作区》——把 Agent 放进一个可控的真实文件系统里干活。
