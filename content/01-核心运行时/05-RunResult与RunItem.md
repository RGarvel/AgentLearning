# 第5章 RunResult与RunItem

上一章我们拆了发动机，这一章看它留下的**黑匣子**。每次 `Runner.run` 返回的 `RunResult` 不只是一个 `final_output`，它是一整条带类型、带归属、可回放的时间线。

绝大多数"我搞不清它到底干了什么"的问题，答案都藏在 `result.new_items` 里。本章教你把这条时间线读出来、渲染出来，并且拿它写断言。

按这章走完，你会得到三样东西：一份字段分工表、一个能跑的时间线渲染脚本、一组可复用的结构断言。

---

## 学习目标

- 能说出 `RunResult` 与 `RunResultStreaming` 的共同基类，以及各自独有的字段。
- 能解释 `final_output` / `final_output_as` / `to_input_list` / `new_items` / `raw_responses` / `last_agent` / `to_state` 七个入口各自的用途与陷阱。
- 能背出 `RunItem` 家族里最常用的七种类型，并知道每种对应什么业务事件。
- 能写一段代码，把 `new_items` 渲染成"用户可读的时间线"。
- 能用 `new_items` 写出稳定的断言，并知道什么情况下该改用测试替身（第 23 章）。

---

## 一、两种结果类型，一个基类

两种结果共用一个基类，差别只在"运行是否还在进行"。结构如下：

```text
RunResultBase            # input / new_items / raw_responses / final_output /
   │                     # 四类护栏结果 / context_wrapper / last_agent /
   │                     # last_response_id / to_input_list / final_output_as
   ├── RunResult              # + max_turns / interruptions / to_state()
   └── RunResultStreaming     # + current_agent / current_turn / is_complete /
                              #   stream_events() / cancel() / to_state()
```

非流式的结果在返回时已经终结，所有字段都是终值。流式对象在 `stream_events()` 消费完之前，`final_output`、`interruptions` 甚至会话写入都可能还在收敛。

所以有一条纪律：流式结果先消费完事件，再读字段（第 21 章）。

### 跑通本章示例的配置清单

本章脚本都会真正跑一次 run，所以第 2 章那套配置必须先就位。下面把本章涉及的每一项列全，逐项说明漏了会报什么错。

| 配置项 | 在哪设 | 漏了或设错会报什么错 |
| --- | --- | --- |
| `OPENAI_API_KEY`（或网关 key） | 环境变量，第 2 章 | 模型调用鉴权失败 |
| 模型名 | `Agent(model=...)` | 网关场景沿用默认模型，报 `model not found` |
| `output_type` | `Agent(output_type=...)` | 漏了 `final_output` 是 `str`，强转结构化类型会报 `TypeError` |
| context 传参 | `Runner.run(context=...)` | 工具里 `ctx.context` 是 `None` |
| 审批工具 `@tool(needs_approval=True)` | 工具定义处 | 漏了 `interruptions` 为空，恢复分支不触发 |
| `to_input_list` 的 `mode` | `mode="normalized"` | 交接场景用默认模式会带回未规范化的历史 |
| `raw_item` 的访问方式 | `Mapping` 安全访问 | 直接 `raw_item.name` 在 dict 上报 `AttributeError` |

---

## 二、五个核心字段

五个入口各有明确分工，用错位置就会读出错误的结论：

| 字段/方法 | 里面是什么 | 什么时候用它 | 常见误用 |
| --- | --- | --- | --- |
| `final_output` | 最后一个 Agent 的最终输出；类型随 `output_type` 变 | 展示给用户 | 以为它一定是 `str` |
| `new_items` | `list[RunItem]`，带 agent、工具、交接（handoff）、审批元数据 | 日志、UI、审计、调试 | 拿它当"给模型的输入" |
| `raw_responses` | `list[ModelResponse]`，每次模型调用的原始响应 | 供应商层排查、取 usage | 从里面挖业务语义 |
| `last_agent` | 最后实际执行的 Agent | 下一轮该用谁接着聊 | 以为它等于入口 Agent |
| `to_state()` | 一份可恢复的 `RunState` | 审批中断、断点续跑 | 当成"序列化结果"随手存 |

三个容易混的兄弟字段要一并记住：

- `input`：这一段 run 的**基础输入**。如果发生了交接且输入过滤器重写过历史，这里反映的是重写后的输入。
- `to_input_list()`：把"原始输入 + 新生成项"拼成下一次可直接喂给 `Runner.run` 的输入项列表。
- `raw_responses` vs `new_items`：前者是"模型说了什么"，后者是"SDK 认为发生了什么"。要排查供应商问题看前者，要做业务展示看后者。

举个具体差别。如果交接时用了 `input_filter` 把历史裁短，`result.input` 反映的是**裁剪后**的输入，也就是模型真正看到的。而 `result.to_input_list()` 默认仍保留 `new_items` 转换出的完整视图。

所以排查"模型为什么没看到某条消息"时，要看 `input`；要给用户看完整过程时，要看 `to_input_list()`。

---

## 三、final_output 与 final_output_as

`final_output` 的类型由**最后一个跑完的 Agent** 决定。没设 `output_type` 就是 `str`；设了就是那个类型；如果 run 因审批中断而暂停，它可能是 `None`。

`final_output_as` 是两个动作的合并：类型转换 + 可选校验。下面这段对比默认与严格两种取法。

```python
import asyncio

from pydantic import BaseModel

from agents import Agent, Runner


class Ticket(BaseModel):
    order_id: str
    issue: str
    severity: str


async def main() -> None:
    agent = Agent(
        name="工单抽取",
        instructions="从用户描述中抽取工单信息。",
        output_type=Ticket,
    )
    result = await Runner.run(agent, "订单 A123 三天没发货，很急")

    # 只做类型标注：运行时不做检查，类型错了也不会报
    ticket = result.final_output_as(Ticket)

    # 真校验：类型不符直接 TypeError
    strict = result.final_output_as(Ticket, raise_if_incorrect_type=True)

    print(ticket.order_id, strict.severity)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `final_output_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python final_output_demo.py
```

预期输出形如 `A123 high`，验证的是"默认取法不校验，严格取法才校验"。

- `raise_if_incorrect_type=False`（默认）时，它只是给类型检查器看的 `cast`，运行时完全信任你。
- 生产代码建议显式传 `True`，让"模型没按结构输出"在最早的地方炸掉，而不是等到下游 `AttributeError`。
- 兜底策略在 `error_handlers["invalid_final_output"]`：结构化校验失败时返回一个应用定义的降级对象（第 4 章）。

---

## 四、to_input_list：两种模式

`to_input_list()` 的签名是 `to_input_list(*, mode="preserve_all")`，两种取值的差别很具体：

| 模式 | 行为 | 什么时候用 |
| --- | --- | --- |
| `"preserve_all"`（默认） | 保留 `new_items` 转换出的完整历史视图 | 日志、审计、手工续聊 |
| `"normalized"` | 在交接输入过滤重写过模型历史时，优先返回"规范化的续跑输入" | 要把它直接喂给下一次 `Runner.run` |

手工续聊的标准写法是"取列表、追加一条、再跑一次"。下面这段验证"第二轮能接上第一轮的上下文"。

```python
import asyncio

from agents import Agent, Runner


async def main() -> None:
    agent = Agent(name="助手", instructions="记住用户说的订单号，并回答后续问题。")

    result = await Runner.run(agent, "订单 A123 什么状态？")
    next_input = result.to_input_list() + [{"role": "user", "content": "那什么时候到？"}]
    result = await Runner.run(agent, next_input)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `to_input_list_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python to_input_list_demo.py
```

预期输出是模型基于第一轮订单号给出的到货回答，而不是"不知道你说的是哪个订单"。

注意 Python 版**没有**"只含模型格式新项"的 `output` 属性（JavaScript 版有）。要 SDK 元数据就用 `new_items`，要原始模型负载就看 `raw_responses`。

另外，`to_input_list()` 在把输出转成可回放输入时会去掉供应商侧的 `created_by` 等输出专有字段，且不修改原始 raw item。

---

## 五、new_items 与 RunItem 家族

每个 `RunItem` 都带三个东西：`agent`（是谁产出的）、`raw_item`（Responses 原始项）、`type`（判别用的字面量）。家族里最常用的七种：

| `type` 字面量 | 类 | 业务含义 | 额外字段 |
| --- | --- | --- | --- |
| `message_output_item` | `MessageOutputItem` | 模型说了一段话 | `raw_item.content` |
| `tool_call_item` | `ToolCallItem` | 模型请求调用工具 | `tool_name`、`call_id`（属性） |
| `tool_call_output_item` | `ToolCallOutputItem` | 工具执行完了 | `output`、`call_id` |
| `handoff_call_item` | `HandoffCallItem` | 模型请求交接 | `raw_item`（函数调用） |
| `handoff_output_item` | `HandoffOutputItem` | 交接完成 | `source_agent`、`target_agent` |
| `reasoning_item` | `ReasoningItem` | 推理项（可回放） | `raw_item` |
| `tool_approval_item` | `ToolApprovalItem` | 某工具在等审批 | `tool_name`、`tool_namespace` |

还有四个"专项"成员，遇到再看即可：`InputItem`（恢复运行时被接纳的输入）、`ToolSearchCallItem`/`ToolSearchOutputItem`（托管工具搜索）、`MCPApprovalRequestItem`/`MCPApprovalResponseItem`/`MCPListToolsItem`（托管 MCP）、`CompactionItem`（上下文压缩）。

一个必须记住的实践：**`raw_item` 不保证是 Pydantic 对象，也可能是 `dict`**。例如程序化工具调用里的 shell/apply_patch。要取字段时写成映射安全的辅助函数，别直接写 `item.raw_item.name`。下面这段用替身数据验证这个辅助函数两种输入都能安全取值。

```python
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass
class StandInItem:
    """只用于验证 raw_field 的替身，模拟 RunItem 的 raw_item 字段。"""
    raw_item: Any


def raw_field(item, name):
    raw = item.raw_item
    if isinstance(raw, Mapping):
        return raw.get(name)
    return getattr(raw, name, None)


def main() -> None:
    as_dict = StandInItem(raw_item={"name": "shell", "status": "ok"})
    as_obj = StandInItem(raw_item=type("Raw", (), {"name": "apply_patch"})())
    print(raw_field(as_dict, "name"))
    print(raw_field(as_obj, "name"))
    print(raw_field(as_dict, "missing"))


if __name__ == "__main__":
    main()
```

把它存成 `raw_field_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python raw_field_demo.py
```

预期输出依次是 `shell`、`apply_patch`、`None`：无论 `raw_item` 是对象还是字典，`raw_field` 都能安全返回字段或 `None`，不会抛 `AttributeError`。

`RunItem.agent` 还有一层内存语义。它内部用弱引用保存 Agent，`RunResult` 又提供 `release_agents()` 主动释放强引用。

这解释了两个现象。一是长生命周期的缓存里只存 `result`，不会无限制地拖住整张 Agent 图。二是调用过 `release_agents()` 之后，再去读 `item.agent` 或 `last_agent` 可能拿到 `None` 或抛 `AgentsException`。

所以"归档结果"时应该只挑需要的字段，而不是把整个 `RunResult` 塞进长期缓存。

---

## 六、把 items 渲染成前端时间线

这是本章最有用的技能：把 `new_items` 变成"用户看得懂的事件流"。下面这段是一个完整脚本，覆盖七种常用类型，并跑一次真实 run 来验证。

```python
import asyncio

from agents import Agent, ItemHelpers, RunResult, Runner
from agents.decorators import tool


@tool
def get_weather(city: str) -> str:
    """查询天气。"""
    return f"{city} 晴，26 度"


def render_timeline(result: RunResult) -> list[str]:
    """把一次 run 的 items 渲染成便于展示/日志的时间线。"""
    lines: list[str] = []

    for item in result.new_items:
        speaker = item.agent.name

        if item.type == "message_output_item":
            text = ItemHelpers.text_message_output(item)
            lines.append(f"[{speaker}] 回复：{text}")

        elif item.type == "tool_call_item":
            lines.append(f"[{speaker}] 调用工具：{item.tool_name}（call_id={item.call_id}）")

        elif item.type == "tool_call_output_item":
            lines.append(f"[{speaker}] 工具返回：{item.output}")

        elif item.type == "handoff_call_item":
            lines.append(f"[{speaker}] 请求交接")

        elif item.type == "handoff_output_item":
            lines.append(
                f"[{item.source_agent.name}] → [{item.target_agent.name}] 交接完成"
            )

        elif item.type == "reasoning_item":
            lines.append(f"[{speaker}] （推理项，已在历史中保留）")

        elif item.type == "tool_approval_item":
            lines.append(f"[{speaker}] 等待审批：{item.tool_name}")

        else:
            lines.append(f"[{speaker}] 其他事件：{item.type}")

    return lines


async def main() -> None:
    agent = Agent(
        name="天气助手",
        instructions="回答天气问题，必须先用 get_weather 查询。",
        tools=[get_weather],
    )
    result = await Runner.run(agent, "上海天气怎么样？")
    for line in render_timeline(result):
        print(line)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `render_timeline_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python render_timeline_demo.py
```

预期输出是若干行带发言人前缀的事件，例如 `[天气助手] 调用工具：get_weather（call_id=...）`、`[天气助手] 工具返回：上海 晴，26 度`，最后一行是回复。这段验证的是：时间线由"类型判别 + 少数几个访问器"就能完整拼出来。

- `item.type` 是稳定的字符串判别式，比 `isinstance` 更适合跨版本渲染代码。
- 文本内容不要自己去挖 `raw_item.content` 的嵌套结构，用 `ItemHelpers.text_message_output(item)`。要一次性拼所有消息，用 `ItemHelpers.text_message_outputs(items)`。
- `HandoffOutputItem` 是唯一能直接告诉你"谁交给了谁"的 item。想知道"有没有交接"就找它。
- 这个函数只读不写，天然适合放在 Web 层。流式场景下把 `RunItemStreamEvent` 交给同一个渲染器即可（第 21 章）。

---

## 七、用 items 做断言

断言要断结构，不断措辞。第 23 章会讲完整的测试体系，这里先建立"能断言的形状"。**下面是片段，不是完整脚本**：它定义三个可复用的断言函数，没有 `main`。把它存成 `assert_helpers.py` 放进你的测试目录，或嵌到第 23 章的测试文件里；里面的 `result` 是函数参数，由同文件里一次 `await Runner.run(...)` 的返回值传入。

```python
from agents import RunResult


def assert_used_tool(result: RunResult, tool_name: str) -> None:
    called = [
        item.tool_name
        for item in result.new_items
        if item.type == "tool_call_item"
    ]
    assert tool_name in called, f"模型没有调用 {tool_name}，实际调用：{called}"


def assert_handoff_path(result: RunResult, source: str, target: str) -> None:
    pairs = [
        (item.source_agent.name, item.target_agent.name)
        for item in result.new_items
        if item.type == "handoff_output_item"
    ]
    assert (source, target) in pairs, f"没有发生 {source} → {target} 的交接，实际：{pairs}"


def assert_no_leak(result: RunResult, secret: str) -> None:
    for item in result.new_items:
        if item.type == "message_output_item":
            assert secret not in item.raw_item.model_dump_json()
```

三个函数覆盖三类结构事实：工具是否被调用、交接路径是否正确、消息里有没有泄漏密钥。三个断言全过时静默通过；任何一条失败，报错信息会直接列出实际观察到的调用或交接。

三条经验：

1. **断言"发生过什么"比断言"说了什么"稳**。工具是否被调用、交接是否发生、审批是否被请求，这些是结构事实；措辞会变。
2. **断言数量而不是内容**。例如"恰好 1 次工具调用"可以用 `len([i for i in result.new_items if i.type == "tool_call_item"]) == 1`。
3. **不要断言 token 数或耗时**。这些值受模型版本、并发、缓存影响，只会让测试随机红。

再补一条容易被忽略的：`raw_responses` 是用来做**成本与供应商诊断**的，不是用来断言的。想知道一次 run 花了多少 token，直接读 `result.context_wrapper.usage`：`input_tokens`、`output_tokens`、`total_tokens`、`requests`，以及逐次的 `request_usage_entries`。想定位"哪个模型调用返回了异常结构"，才去翻 `raw_responses[n]`。

真要做到"完全不花 token 的回归"，用 `agents.testing.ScriptedModel` 把模型替换成剧本。那是第 23 章的主角。

---

## 八、to_state 与 interruptions

最后一个入口是"把结果冻成快照"。下面这段用一个必须审批的工具，在审批点停下来、拒绝后继续，完整跑一遍。

```python
import asyncio

from agents import Agent, Runner
from agents.decorators import tool


@tool(needs_approval=True)
def delete_files(path: str) -> str:
    """删除临时文件。"""
    return f"已删除 {path}"


async def main() -> None:
    agent = Agent(
        name="运维助手",
        instructions="用户要求删除文件时，必须调用 delete_files 工具。",
        tools=[delete_files],
    )

    result = await Runner.run(agent, "删除临时文件 /tmp/cache")
    print("待审批：", [item.tool_name for item in result.interruptions])

    if result.interruptions:
        state = result.to_state()
        state.reject(result.interruptions[0], rejection_message="需要主管批准")
        result = await Runner.run(agent, state)
        print("恢复后：", result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `to_state_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python to_state_demo.py
```

预期先打印 `待审批： ['delete_files']`，然后 run 带着拒绝理由继续走完并打印收尾回复。

- `interruptions` 只在有工具等待审批时非空；此时 `final_output` 通常为 `None`。
- `to_state()` 保存的不只是输入输出，还包括当前 Agent、轮次、护栏结果、审批记录等。它**不是**"结果的 JSON 版"，而是一个可执行的断点。
- `RunState` 的 `approve` / `reject` / `add_input` / 序列化细节，全部在第 16 章。

---

## 九、一条典型 items 序列长什么样

把上面所有知识拼起来，看一个"分诊 → 交接"的真实顺序（两次模型调用、一次交接）。

```text
[message_output_item]  分诊 Agent ：先确认一下问题类型
[handoff_call_item]    分诊 Agent ：请求交接给退款专员（模型发出的函数调用）
[handoff_output_item]  分诊 → 退款专员 ：交接已执行
[message_output_item]  退款专员   ：请提供订单号
```

上图里只有两条 message，却只对应一次最终输出。读这条序列有四个要点：

- **交接会产出成对的 `handoff_call_item` 与 `handoff_output_item`**。前者是"模型请求交接"，后者是"交接已执行"。注意交接请求**不会**再额外产生一个 `tool_call_item`，尽管在模型眼里它就是一次函数调用，SDK 把它单列成了交接项。只有 `handoff_output_item` 带 `source_agent` / `target_agent`，所以判断"有没有真的换人"要找它。
- **`agent` 字段记录的是"谁产出的这个 item"**，不是"当前是谁"。上面前三个 item 的 `agent` 都是分诊 Agent，最后一个才是退款专员。
- **两次 `message_output_item` 不等于两个回合**。第一个 message 之后紧接着就发生了交接，它仍属于同一个回合的中间产物；真正的最终输出只有最后一条。想确认回合数，看 `raw_responses` 的长度或 trace 里的 generation span。
- **如果某个工具需要审批，序列里会多出 `tool_approval_item`**，并且后面不会立刻出现对应的 `tool_call_output_item`。这正是"run 暂停了"的可观测特征。看到它就该去读 `result.interruptions`，而不是怀疑模型出错。

---

## 常见坑与排查

按症状查，每条都给出"症状 → 原因 → 修法"。

1. **症状**：交接之后 `result.final_output` 的类型和自己预期的不一样。
   **原因**：`final_output` 的类型由最后跑完的 Agent 决定，而交接会换人。
   **修法**：给每个可能收尾的 Agent 都设一致的 `output_type`，或统一在入口 Agent 收口（第 11 章）。

2. **症状**：用 `to_input_list()` 续聊，多轮之后历史越来越长、模型开始"忘事"。
   **原因**：默认模式保留全量历史，没有压缩也没有规范化。
   **修法**：交接场景用 `to_input_list(mode="normalized")`；长对话改用 `session` + 上下文工程（第 17、18 章）。

3. **症状**：`item.raw_item.name` 在某些工具上抛 `AttributeError`。
   **原因**：`raw_item` 可能是 `dict`（程序化工具调用、部分 shell/apply_patch 项）。
   **修法**：用 `Mapping` 安全访问；`ToolCallItem` 优先用自带的 `tool_name` 属性。

4. **症状**：流式 run 里读 `result.final_output` 拿到 `None`，或 `interruptions` 是空的。
   **原因**：事件还没消费完，后台任务尚未终结。
   **修法**：先 `async for` 跑完 `stream_events()`；需要中途停下就 `cancel()` 并继续消费。

5. **症状**：把 `result` 直接 `json.dumps` 报错。
   **原因**：`RunResult` 是运行时对象，含 Pydantic 模型、Agent 引用等，没有内建 JSON 序列化。
   **修法**：要持久化就 `to_state()` 后用 `RunState.to_json()`；要日志就自己挑字段。

---

## 动手练习

1. **画一次 run 的时间线**：用带一个工具的 Agent 跑一次，把 `new_items` 逐项打印成 `type + agent.name`，标出"哪一项是模型说的、哪一项是工具做的"。
2. **写三条断言**：为上一步的 run 写三个断言：工具被调用过、消息输出非空、没有 `handoff_output_item`。然后故意把 `instructions` 改成"不要用工具"，看哪条断言先红。
3. **改仓库示例**：打开 `repo/examples/basic/stream_items.py`，把它的 `print` 逻辑抽出成本章的 `render_timeline` 风格函数，让流式与非流式两条路径共用同一个渲染器。

先跑一遍原版，看看它默认打印什么。若仓库 clone 在别处，按自己的路径替换：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python examples/basic/stream_items.py
```

预期输出是一串逐条到达的事件，每条都带各自的类型名。

---

## 本章小结

- `RunResult` 与 `RunResultStreaming` 共享 `RunResultBase`：`input`、`new_items`、`raw_responses`、`final_output`、护栏结果、`context_wrapper`、`last_agent`。
- `final_output` 的类型跟随"最后跑完的 Agent"；`final_output_as` 默认不校验，生产建议 `raise_if_incorrect_type=True`。
- `to_input_list()` 有 `"preserve_all"` 与 `"normalized"` 两种模式，后者用于交接重写历史后的续跑。
- `new_items` 是带元数据的时间线，`raw_responses` 是模型原始回复，两者用途不同；常用七种 item 是 message / tool_call / tool_call_output / handoff_call / handoff_output / reasoning / tool_approval。
- 渲染时间线靠 `item.type` 判别 + `ItemHelpers`；断言要断结构不断措辞。
- `interruptions` + `to_state()` 是"暂停 → 恢复"的入口，细节在第 16 章。

---

## 延伸阅读

- 结果字段的官方详解：`repo/docs/results.md`
- 源码：`repo/src/agents/result.py`（`RunResultBase`、`to_input_list`、`to_state`）、`repo/src/agents/items.py`（全部 `RunItem` 子类与 `ItemHelpers`）
- 示例：`repo/examples/basic/stream_items.py`、`repo/examples/basic/usage_tracking.py`
- 测试替身：`repo/src/agents/testing/model.py`（`ScriptedModel`）
- 下一章：这些 item、工具、护栏都会收到同一个"本地上下文"，第 6 章讲它怎么注入。
