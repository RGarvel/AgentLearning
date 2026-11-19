# 第6章 上下文与依赖注入

上一章我们看到，一次 run 会留下 message、tool call、handoff 等一堆 item。这些 item 的产出者——工具函数、护栏、钩子、动态指令——都需要拿到"这一次请求的业务现场"：当前用户是谁、数据库连接在哪、日志器怎么拿。把它们塞进全局变量是灾难，塞进 prompt 是浪费 token。本章讲 SDK 给的答案：**本地上下文（local context）**，也叫依赖注入。

但先要拆掉一个高频混淆：SDK 里"上下文"有两个完全不同的东西。

---

## 学习目标

- 能区分"本地上下文"与"LLM 上下文"，并说出让数据进入 LLM 视野的四条正规路径。
- 能说出 `RunContextWrapper` 里哪些字段属于你、哪些属于 SDK。
- 能写出在 instructions、工具、护栏、hooks、交接回调五处取 context 的代码。
- 能判断什么时候该用 `ToolContext` 而不是 `RunContextWrapper`，并记住它的导入路径。
- 能设计一个可序列化、可并发安全的上下文对象，并解释 `Agent[TContext]` 带来的类型收益。

---

## 一、两个"上下文"必须先分清

`repo/docs/context.md` 开篇就把这个词劈成两半：

| | 本地上下文（local context） | LLM 上下文（agent/LLM context） |
| --- | --- | --- |
| 是什么 | 你创建的 Python 对象 | 模型能看到的对话历史 |
| 谁用 | 你的工具、护栏、钩子、指令函数 | 模型 |
| 存放 | `RunContextWrapper.context` | `instructions` + 输入项 + 工具返回值 + 检索结果 |
| 会发给模型吗 | **不会** | 就是发给模型的东西 |
| 典型内容 | 数据库连接、logger、用户对象、租户配置 | 用户问题、历史消息、工具执行结果 |

> 注意：context 对象**不会**被发送给模型。这是最常见的误解来源——你在 context 里放了"用户余额 128 元"，模型并不会因此知道，除非你把它写进指令、输入或工具返回值。

那怎么让模型知道？四条正规路径：

1. **写进 `instructions`**（可以是动态函数，每次都带上最新值）；
2. **放进 `input`**（比指令层级更低的消息）；
3. **通过工具按需取**（模型自己决定何时查）；
4. **通过检索或联网搜索**（把外部知识"落地"到对话里）。

这四条对应四种成本：指令是每轮都付、工具是按需付、检索是按相关性付、塞进输入是最笨但最直接的方式。

还有一个反向的坑：把对话历史塞进 context 里"省事"。这条路会同时踩两个雷——模型看不到它（于是你又得复制进指令，白付一遍 token），`RunState` 序列化时又会把它整段写进快照（体积与隐私双输）。历史只有三个正经去处：`to_input_list()`、`session`、服务端的 `conversation_id`/`previous_response_id`（第 18 章）。

---

## 二、RunContextWrapper 里到底有什么

`RunContextWrapper[TContext]` 是个 dataclass，字段分两类：

| 字段 | 归属 | 说明 |
| --- | --- | --- |
| `context` | **你的** | 你传给 `Runner.run(context=...)` 的那个对象 |
| `usage` | SDK | 本次 run 累计的 token 与请求数 |
| `turn_input` | SDK | 当前 turn 的输入项列表 |
| `tool_input` | SDK | 嵌套 `Agent.as_tool()` 运行时的结构化输入 |
| `approve_tool` / `reject_tool` | SDK | 以代码方式改审批状态（第 15、16 章） |

源码注释写得直白：**"Only `wrapper.context` is your app-defined object"**。其余都是运行时元数据，你可以读，但不应该改写。尤其 `usage`：

```python
result = await Runner.run(agent, "订单 A123 什么状态？", context=user_ctx)

usage = result.context_wrapper.usage
print(usage.requests, usage.input_tokens, usage.output_tokens, usage.total_tokens)
# 预期输出（示例）：2 1834 216 2050
for entry in usage.request_usage_entries:
    print(entry.input_tokens, entry.output_tokens)
```

这段要验证的是：**用量是 run 级别的，不是 Agent 级别的**。

- 一次 run 里可能发生多次模型调用（工具回填、交接），`usage.requests` 反映的是真实调用次数。
- 流式场景下 `usage` 要等流的最后几个块处理完才准确（源码注释原文：will be stale until the last chunk）。
- `AgentHookContext` 是 `RunContextWrapper` 的子类，专门给 `on_agent_start`/`on_agent_end` 用，所以你在这两个钩子里同样能读 `context.usage`。

---

## 三、把 context 传进去

标准写法是"dataclass 定义 + 泛型标注 + 传参"三步：

```python
import asyncio
from dataclasses import dataclass

from agents import Agent, RunContextWrapper, Runner
from agents.decorators import tool


@dataclass
class SupportContext:
    user_id: str
    tenant: str
    tier: str


@tool
def fetch_open_tickets(ctx: RunContextWrapper[SupportContext]) -> str:
    """查询当前用户的未结工单。"""
    user = ctx.context
    return f"{user.tenant} 租户下 {user.user_id} 有 2 张未结工单"


async def main() -> None:
    agent = Agent[SupportContext](
        name="工单助手",
        instructions="先确认用户的未结工单，再回答。",
        tools=[fetch_open_tickets],
    )
    ctx = SupportContext(user_id="u_1024", tenant="acme", tier="pro")
    result = await Runner.run(agent, "我还有哪些工单没处理？", context=ctx)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

要点：

- 工具函数把 `RunContextWrapper[...]` 写在**第一个参数**，SDK 会自动把它从工具 schema 里剔除——模型看不到这个参数，也不会试图填它。
- 这个位置是硬约束：`repo/src/agents/function_schema.py` 会检查"上下文参数出现在非首位"并抛出明确错误。
- `context` 可以是任意 Python 对象；dataclass 只是最常见的一种。
- 同一份 context 会被所有 Agent、工具、护栏、钩子共享——**它们必须是同一个类型**，否则类型检查器会红，运行期则会在访问属性时炸。

---

## 四、五个取 context 的地方

| 位置 | 拿到的对象 | 用途 |
| --- | --- | --- |
| `instructions` 动态函数 | `RunContextWrapper[T]` | 每次调用前拼系统提示 |
| 工具函数 | `RunContextWrapper[T]` 或 `ToolContext[T]` | 取依赖、做权限判断 |
| `@input_guardrail` / `@output_guardrail` | `RunContextWrapper[T]` | 按租户/用户做差异化检查 |
| `RunHooks` / `AgentHooks` | `RunContextWrapper` 或 `AgentHookContext` | 记录审计、上报指标 |
| `handoff(on_handoff=...)` | `RunContextWrapper[Any]`（带 `input_type` 时第二个参数是解析后的输入） | 交接前的权限校验、埋点 |

下面这段把三类回调放在一起（省略了业务实现）：

```python
from agents import (
    Agent,
    GuardrailFunctionOutput,
    RunContextWrapper,
    RunHooks,
    input_guardrail,
)
from agents.handoffs import handoff


@input_guardrail
async def tenant_allowlist(
    ctx: RunContextWrapper[SupportContext],
    agent: Agent[SupportContext],
    user_input: str | list,
) -> GuardrailFunctionOutput:
    allowed = ctx.context.tenant in {"acme", "globex"}
    return GuardrailFunctionOutput(
        output_info={"tenant": ctx.context.tenant},
        tripwire_triggered=not allowed,
    )


class AuditHooks(RunHooks[SupportContext]):
    async def on_agent_start(self, context, agent):      # context 是 AgentHookContext
        print(f"[audit] {context.context.user_id} 进入 {agent.name}")

    async def on_tool_end(self, context, agent, tool, result):  # 通常是 ToolContext
        print(f"[audit] {context.context.user_id} 调用 {tool.name}")


billing_agent = Agent[SupportContext](name="账单专员", instructions="处理账单问题。")


def build_billing_handoff():
    def on_handoff(ctx: RunContextWrapper[SupportContext]) -> None:
        # 交接前做一次权限校验；不通过就抛异常中断（返回 None 不会阻止交接）
        if ctx.context.tier != "pro":
            raise PermissionError("仅 pro 租户可转账单专员")

    return handoff(billing_agent, on_handoff=on_handoff)
```

几个值得记住的细节：

- **护栏函数签名是固定的三参数**：输入护栏是 `(context, agent, input)`，输出护栏是 `(context, agent, output)`。
- **`on_handoff` 不能靠"返回值"阻止交接，也不能动态换目标**（`handoff()` 总是返回你在参数里捕获的那个 Agent，源码 docstring 明确说了这点）。要按 context 拒绝，就在回调里抛异常：默认 `failure_error_function=None`，异常会向上传播、直接结束这次 run；如果你给 `handoff(..., failure_error_function=default_tool_error_function)`，异常会变成模型可见的错误消息，交接失败但 run 继续。这个差别决定了"拒绝"是硬中断还是软回退。
- **别在回调里改 `agent.tools`**。并发运行时替换工具列表会被检测并抛 `UserError`；要按运行切换能力，用 `FunctionTool.is_enabled` 这类基于 context 的回调（第 10 章）。

---

## 五、ToolContext：工具级元数据

当工具需要知道"这次调用的名字、call_id、原始参数字符串"时，用 `ToolContext`。它是 `RunContextWrapper` 的子类，最常用的几个额外字段是：

| 字段 | 含义 |
| --- | --- |
| `tool_name` | 工具名 |
| `tool_call_id` | 本次调用的 ID（写幂等日志、关联外部系统时有用） |
| `tool_arguments` | 模型给的原始参数字符串（未解析） |
| `tool_call` | 原始 `ResponseFunctionToolCall` |
| `tool_namespace` | Responses 命名空间（用了 `tool_namespace()` 时） |
| `qualified_tool_name` | 带命名空间的完整工具名（属性） |

导入路径有一个坑：**`ToolContext` 不在 `agents` 顶层导出**，要从子模块拿：

```python
from agents import Agent
from agents.decorators import tool
from agents.tool_context import ToolContext


@tool
def refund(ctx: ToolContext[SupportContext], order_id: str) -> str:
    """为订单发起退款。"""
    print(f"[trace] tool={ctx.tool_name} call_id={ctx.tool_call_id} args={ctx.tool_arguments}")
    return f"订单 {order_id} 已退款（操作人 {ctx.context.user_id}）"
```

选择原则很简单：**只需要业务依赖 → `RunContextWrapper`；需要本次调用的元数据 → `ToolContext`**。因为 `ToolContext` 是子类，你随时可以只把它当 wrapper 用，不会失去 `.context`。

---

## 六、上下文对象怎么设计

一条经验：**context 是"依赖容器 + 请求现场"，不是"储物间"**。推荐形态：

```python
from dataclasses import dataclass, field
from typing import Any, Protocol


class UserRepo(Protocol):
    async def open_tickets(self, user_id: str) -> list[dict[str, Any]]: ...


@dataclass
class RequestContext:
    user_id: str
    tenant: str
    tier: str
    repo: UserRepo                      # 依赖：仓储/客户端
    logger: Any                         # 依赖：日志器
    trace_id: str = ""                  # 现场：链路 ID
    cache: dict[str, Any] = field(default_factory=dict)   # 一次请求内的临时缓存
```

四条设计准则：

1. **依赖用协议或抽象类型**，不要写死具体类——测试时能换成假实现（第 23 章）。
2. **一次请求一个实例**，不要在模块级共享。并发 run 共享同一个可变 context 会互相污染。
3. **别放密钥**。`RunState` 序列化会把 context 一起写出去（下一节）。
4. **别把对话历史放进去**。历史属于 `session` / `to_input_list()` / `previous_response_id`，那是另一套机制（第 17、18 章）。

---

## 七、序列化与并发

这是本章最容易被低估的一节。`RunState` 在持久化时**会尝试序列化 context**（`repo/src/agents/run_state.py` 的 `_serialize_context_payload`）：

| context 类型 | 序列化方式 | 恢复时 |
| --- | --- | --- |
| `Mapping`（dict） | 直接作为字典 | 原样可用 |
| Pydantic 模型 | `model_dump(mode="json")` | 类型丢失，需要 `context_deserializer` 或 `context_override` |
| dataclass | `dataclasses.asdict` 且能 JSON 化 | 同上，会给出警告 |
| 其他自定义对象 | **退化为空 dict** 并告警 | 必须提供 `context_serializer` |

对应的 API 是 `RunState.to_json(context_serializer=..., strict_context=...)` 与 `RunState.from_string(initial_agent, s, context_deserializer=..., context_override=...)`。`strict_context=True` 时，非 mapping 且没有 serializer 会直接抛 `UserError`，而不是悄悄丢数据——生产环境建议打开。

并发方面有三条硬事实：

- **同一次 run 内**，派生出来的 wrapper 共享 `usage` 与审批状态；嵌套 `Agent.as_tool()` 会 fork 一个 wrapper（只多一个 `tool_input`），不会给你的应用状态做隔离副本。
- **`usage` 是原地累加的**（`Usage.add` 直接改对象）。所以从同一个 `RunResult` 切出多个 `RunState` 时，SDK 会 `deepcopy` usage，避免一个断点的 token 记到另一个断点上。
- **跨 run 并发**时，每个 run 传自己的 context 实例；共享一个可变对象就等于共享一把没有锁的账本。
- **`turn_input` 是当前 turn 的输入项快照**。在钩子里记录"这一轮模型到底看到了什么"，用它比用 `result.to_input_list()` 更贴近现场；但它不是历史存储，别拿它做持久化。

---

## 八、Agent[TContext] 带来的类型安全

`Agent` 是泛型的，`Agent[SupportContext]` 的收益只有一个，但很值钱：**让"传错 context 类型"在编辑器里就报错，而不是在凌晨三点的线上**。

- 工具函数签名写 `RunContextWrapper[SupportContext]`，Agent 写 `Agent[SupportContext]`，`Runner.run(context=ctx)` 处的 `ctx` 就受约束。
- `AgentHooks`/`RunHooks` 也可以参数化（`RunHooks[SupportContext]`），钩子里的 `context.context` 就有类型。
- 运行时**不做**校验。传错类型不会立刻报错，而是在访问属性时抛 `AttributeError`。所以泛型不是"安全网"，只是"早发现"。

一个团队级约定值得写进代码规范：**只要定义了自定义 context，就处处显式参数化**，包括 Agent、工具、护栏、Hooks、`as_tool`。不一致的参数化本身就是一种文档缺陷。

---

## 常见坑与排查

1. **症状**：在 `instructions` 里写"用户余额见上下文"，模型开始编造数字。
   **原因**：context 不发给模型。
   **修法**：用动态指令把值拼进字符串，或提供工具让模型按需查询。

2. **症状**：工具函数里 `ctx.context` 是 `None`。
   **原因**：`Runner.run` 时忘了传 `context=`，wrapper 里存的就是 `None`。
   **修法**：统一在入口层构造并传入；或者在工具里显式判断 `None` 并抛 `UserError`。

3. **症状**：`from agents import ToolContext` 报 `ImportError`。
   **原因**：`ToolContext` 不在顶层导出。
   **修法**：`from agents.tool_context import ToolContext`。

4. **症状**：工具签名写成 `def f(order_id: str, ctx: RunContextWrapper[C])`，启动时报错。
   **原因**：上下文参数必须是第一个参数。
   **修法**：把 `ctx` 挪到第一位；其余参数保持正常顺序。

5. **症状**：从 `RunState` 恢复后，工具里 `ctx.context` 变成一个空 dict 或普通 dict。
   **原因**：原 context 是自定义类，序列化时退化或丢失类型。
   **修法**：改用 mapping context，或提供 `context_serializer` / `context_deserializer`；也可用 `context_override` 直接给新实例。

6. **症状**：同一份 context 在并发请求间"串数据"（A 用户看到 B 用户的缓存）。
   **原因**：模块级共享了一个可变 context 实例。
   **修法**：每次 run 新建实例；确有共享需求时只共享不可变配置。

---

## 动手练习

1. **区分两种 context**：写一个 Agent，把"用户等级"分别放进 (a) context，(b) `instructions` 字符串，(c) 一个查询工具。分别问"我是什么等级"，记录三种做法下模型能否答对，并解释原因。
2. **给工具加审计**：用 `ToolContext` 打印每次工具调用的 `tool_name` 与 `tool_call_id`，然后在 `RunHooks.on_tool_end` 里打印同一条信息。对比两处的可获取信息差异。
3. **改仓库示例**：打开 `repo/examples/basic/dynamic_system_prompt.py`，把 `CustomContext` 扩成一个含 `user_id` 与 `logger` 的 dataclass，并把风格选择改为由 `context.tier` 决定；再补一个只允许特定 tier 通过的 `@input_guardrail`。

---

## 本章小结

- 两个上下文：本地 context（注入依赖，不发给模型）与 LLM context（对话历史，模型唯一可见的信息）。
- `RunContextWrapper` 里只有 `.context` 是你的；`.usage`、`.turn_input`、`.tool_input` 是 SDK 元数据。
- 取 context 的五个位置：动态 instructions、工具、护栏、hooks、`on_handoff`；签名各不相同但都以 wrapper 开头。
- `ToolContext` 多了工具调用元数据，导入路径是 `agents.tool_context`。
- context 应设计成"依赖容器 + 请求现场"：一次请求一个实例、依赖用协议、不放密钥、不放历史。
- `RunState` 会序列化 context：mapping 最安全，自定义类型需要 serializer/deserializer，`strict_context=True` 可避免静默丢数据。
- 同 run 内 usage 与审批状态共享；跨 run 并发必须各自持有 context。
- `Agent[TContext]` 只提供静态类型收益，运行时不校验——所以要处处一致地参数化。

---

## 延伸阅读

- 官方上下文指南（本章结构的主要依据）：`repo/docs/context.md`
- 源码：`repo/src/agents/run_context.py`（`RunContextWrapper`、`AgentHookContext`）、`repo/src/agents/tool_context.py`（`ToolContext`）、`repo/src/agents/function_schema.py`（上下文参数识别规则）
- 序列化：`repo/src/agents/run_state.py`（`_serialize_context_payload`、`to_json`、`from_string`）
- 示例：`repo/examples/basic/dynamic_system_prompt.py`、`repo/examples/basic/usage_tracking.py`
- 下一章进入模块 2：既然工具能拿到 context，我们就正式写第一个函数工具。
