# 第3章 Agent对象解剖

上一章我们把环境跑通了，也认识了仓库的五个区域。从这一章起进入模块 1：这台机器由哪些零件组成。

`Agent`（智能体）是整套 SDK 里唯一一个"你写得多、它跑得少"的对象。它几乎不做任何事，只负责声明。本章逐个字段拆开它，交接（handoff）与护栏（guardrail）相关字段也会一并标出，最后讲清 `clone()` 那个被源码注释专门警告过的浅拷贝陷阱。

按这章走完，你会得到三样东西：一张能照着填的字段表、一个能跑的动态指令脚本、一套安全的 `clone()` 派生写法。

---

## 学习目标

- 能画出 `AgentBase → Agent → SandboxAgent` 与 `AgentBase → RealtimeAgent` 的继承关系，并说出基类为什么只保留五个字段。
- 能逐个说明 `Agent` 的十余个字段各自控制什么，以及在运行时的哪一步生效。
- 能写出静态与动态两种 `instructions`，并说清 `prompt` 模板的适用条件。
- 能列举 `tool_use_behavior` 的四种形态，并解释 `reset_tool_choice` 防的是什么死循环。
- 能解释 `clone()` 为什么是浅拷贝，并用它安全地批量派生角色。

---

## 一、先看继承树：三种 Agent，一个基类

三种 Agent 共用一个基类，只是派生方向不同。`repo/src/agents/agent.py` 里定义了两个类，`sandbox/` 与 `realtime/` 各派生出第三个。

```text
AgentBase[TContext]        # name / handoff_description / tools / mcp_servers / mcp_config
   ├── Agent[TContext]     # instructions / prompt / handoffs / model / model_settings /
   │                       # guardrails / output_type / hooks / tool_use_behavior / reset_tool_choice
   │      └── SandboxAgent[TContext]   # + default_manifest / base_instructions / capabilities / run_as
   └── RealtimeAgent[TContext]        # + instructions / prompt / handoffs / output_guardrails / hooks
```

`AgentBase` 是抽象基类，只保留"所有形态都需要"的五个字段。连 `instructions` 都不在基类里，因为 `RealtimeAgent` 的指令签名与 `Agent` 不同，它拿到的 agent 参数类型是 `RealtimeAgent`。

三个类的分工列成一张表：

| 类 | 与基类的关系 | 要点 |
| --- | --- | --- |
| `AgentBase` | 抽象基类 | 只保留"所有形态都需要"的字段：`name`、`handoff_description`、`tools`、`mcp_servers`、`mcp_config`。连 `instructions` 都不在基类里，因为 `RealtimeAgent` 的指令签名与 `Agent` 不同，它拿到的 agent 参数类型是 `RealtimeAgent`。 |
| `SandboxAgent` | `Agent` 的子类 | 普通 Agent 的一切写法它都接受，只是多了一层"工作区"配置。运行时传输细节（沙箱客户端、会话）放在 `RunConfig(sandbox=...)` 里，不在 Agent 上。 |
| `RealtimeAgent` | 直接继承基类 | 刻意**不支持** `model`、`model_settings`、`output_type`、`tool_use_behavior`。因为一个 `RealtimeSession` 里所有 Agent 共用一个实时模型。这个设计细节解释了第 26 章里"为什么实时 Agent 长得不太一样"。 |

`Agent` 是 `@dataclass`，字段顺序就是源码里的声明顺序。`__post_init__` 会做一轮类型校验，例如 `name` 必须是 `str`、`tools` 必须是 `list`。错误信息相当直白，是排查配置错误的第一道防线。

### 跑通本章示例的配置清单

本章每段脚本都会发起模型调用，所以第 2 章那套运行时配置必须先就位。下面把本章涉及的每一项列全，逐项说明漏了会报什么错。

| 配置项 | 在哪设 | 漏了或设错会报什么错 |
| --- | --- | --- |
| `OPENAI_API_KEY`（或网关 key） | 环境变量，见第 2 章 | 模型调用鉴权失败，报 key 相关错误 |
| 模型名 | `Agent(model=...)` 或 `OPENAI_DEFAULT_MODEL` | 网关场景沿用默认 `gpt-5.6-luna`，报 `model not found` |
| base URL（仅网关） | `AsyncOpenAI(base_url=...)` 或 `OPENAI_BASE_URL` | 请求发到官方地址，报 401 或连接错误 |
| API 形态（仅网关） | `set_default_openai_api("chat_completions")` | 默认发 Responses API，网关报 404 |
| `instructions` 动态函数签名 | `def f(ctx, agent)`，两个位置参数 | 少写参数报 `TypeError` |
| context 类型与传参 | `Agent[Session]` 加 `Runner.run(context=...)` | 工具里访问属性报 `AttributeError` |

两条铁律来自第 2 章：所有配置必须在**第一次模型调用之前**生效；传了自定义 client 后，client 就是唯一真相。下面所有脚本都假设你已经按第 2 章配好了 key、端点、模型名和 API 形态。

---

## 二、身份与指令字段

两个身份字段负责标识，两个指令字段负责每次调用的提示，四者互不替代。

| 字段 | 类型 | 默认 | 生效位置 |
| --- | --- | --- | --- |
| `name` | `str` | 必填 | 追踪、日志、`result.last_agent.name` |
| `handoff_description` | `str \| None` | `None` | 被当成交接目标时，进入另一个 Agent 的工具描述 |
| `instructions` | `str \| 可调用对象 \| None` | `None` | 每次模型调用前的 system prompt |
| `prompt` | `Prompt \| DynamicPromptFunction \| None` | `None` | Responses API 的 prompt 模板 |

`name` 不只是装饰。它出现在 trace 的 span 名、`HandoffOutputItem`，以及你以后写断言的地方（`result.last_agent.name == "退款专员"`）。给它取一个业务含义明确的名字，比 `"assistant"` 有用得多。

`instructions` 有两种写法，第二种是本章第一个必须掌握的技巧：把系统提示写成函数，每次调用前现拼文本。下面这段验证"指令可以是函数，而不是固定文本"。

```python
import asyncio
from dataclasses import dataclass

from agents import Agent, RunContextWrapper, Runner


@dataclass
class Session:
    user_name: str
    tier: str


def build_instructions(ctx: RunContextWrapper[Session], agent: Agent[Session]) -> str:
    """每次模型调用前现算系统提示，因此可以带上运行时信息。"""
    user = ctx.context
    return (
        f"你在为 {user.user_name}（等级：{user.tier}）服务。\n"
        "回答前先确认订单号；无法确认时请用户补充，不要猜测。"
    )


async def main() -> None:
    agent = Agent[Session](
        name="订单客服",
        instructions=build_instructions,
    )
    ctx = Session(user_name="王女士", tier="VIP")
    result = await Runner.run(agent, "你好，我想问一下订单", context=ctx)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `dynamic_instructions_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python dynamic_instructions_demo.py
```

预期结果是屏幕打印一句带订单确认要求的回复，说明 `build_instructions` 在调用前读到了 `ctx.context`。四个细节值得记住：

| 细节 | 说明 |
| --- | --- |
| 签名 | 固定为 `(RunContextWrapper[TContext], Agent[TContext])`，返回值必须是 `str`。 |
| 同步与异步 | 可以是普通函数，也可以是 `async def`。SDK 用 `inspect.isawaitable` 判断，两种都接受。 |
| 调用时机 | 在**每次模型调用前**被调用，所以能读到 `ctx.context` 这种随请求变化的数据。这也意味着不要在里面做重 IO，否则每个回合（turn）都要等一次。 |
| 泛型标注 | `Agent[Session]` 的标注只在类型检查期生效，运行时不做校验（第六节展开）。 |

`prompt` 是有条件的。它指向 OpenAI 平台上创建的 prompt 模板，形如 `{"id": "pmpt_...", "version": "1", "variables": {...}}`，**只在用 OpenAI 模型走 Responses API 时可用**。

两个字段在对象上是并列的，SDK 分别解析 `get_system_prompt()` 与 `get_prompt()`。但语义完全不同：`instructions` 是你自己写的系统提示，`prompt` 是平台侧托管的配置。别把 `prompt` 当成 `instructions` 的替代品。

要动态生成模板，就传一个接收 `GenerateDynamicPromptData`（含 `context` 与 `agent`）的函数，返回 `Prompt` 字典。

---

## 三、能力字段：tools、mcp_servers、mcp_config

三个字段都回答"这个 Agent 能用什么工具"，差别在工具从哪来、怎么准备。

| 字段 | 说明 |
| --- | --- |
| `tools` | 本地工具列表，元素是 `Tool`（函数工具、托管工具、其他 Agent 的 `as_tool` 结果等） |
| `mcp_servers` | MCP 服务器列表；**每次运行**都会从这些服务器拉取工具，混进可用工具集 |
| `mcp_config` | 控制 MCP 工具怎么准备，是个 `TypedDict` |

`mcp_config` 只有三个键，但每个都有实际影响：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `convert_schemas_to_strict` | `False` | 尽力把 MCP 的 JSON Schema 转成 strict 模式 |
| `failure_error_function` | `default_tool_error_function` | MCP 工具失败时给模型看什么；显式传 `None` 则直接抛异常 |
| `include_server_in_tool_names` | `False` | 用服务器前缀给工具命名，避免多个 MCP 服务器重名 |

这里有一个容易忽略的运行时事实：`mcp_servers` 的**生命周期由你管理**。源码注释明确写着要自己 `server.connect()` 与 `server.cleanup()`，或者用 `MCPServerManager` 把连接与清理放在同一个任务里。Agent 只负责"运行时去取工具"，不负责"帮你连"（第 9 章展开）。

注意：`tools` 的赋值被 `AgentBase.__setattr__` 拦截了。如果你在并发运行期间替换同一个 Agent 的 `tools`，SDK 会抛 `UserError`。建议改成"每次运行用独立的 Agent"，例如 `agent.clone(tools=[*agent.tools])`。原地 `append` 不走这个检查，所以更危险，这正是第八节要讲的坑。

---

## 四、模型字段：model、model_settings 与工具行为

模型字段决定"用哪个模型、配什么参数"，工具行为字段决定"工具跑完后怎么办"。下面这段把两组字段写在同一个 Agent 上，并真正跑一次。

```python
import asyncio

from agents import Agent, ModelSettings, Runner
from agents.decorators import tool


@tool
def get_balance(account_id: str) -> str:
    """查询账户余额。"""
    return "余额 128.00 元"


async def main() -> None:
    agent = Agent(
        name="账单助手",
        instructions="回答账单问题，必要时查余额。",
        model="gpt-5-nano",
        model_settings=ModelSettings(temperature=0.2, tool_choice="auto"),
        tools=[get_balance],
    )
    result = await Runner.run(agent, "帮我查一下账户余额")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

把它存成 `model_fields_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python model_fields_demo.py
```

预期输出是模型对账单问题的一句回答；它是否调用 `get_balance` 由模型决定，但屏幕一定有文本结果。三个模型字段的细节如下：

| 字段 | 说明 |
| --- | --- |
| `model` | 可以是模型名字符串，也可以是 `Model` 实例（自建供应商时用，第 19 章）。不填就走 `get_default_model()`，当前默认 `gpt-5.6-luna`，可用环境变量 `OPENAI_DEFAULT_MODEL` 覆盖。 |
| `model_settings` | 接受 `ModelSettings` 或**同名字典**（SDK 会强制转换）。写错字段名会抛 `TypeError`，这是好事，比静默忽略强。 |
| 隐式默认 | 如果你没有显式碰过 `model_settings`，它会被标记为"隐式默认"。`clone(model="...")` 时会按新模型重新推导默认设置（源码 `_uses_implicit_model_settings` 的逻辑），避免你把 gpt-5 系列的 reasoning 默认值带到一个不吃这套参数的模型上。 |

`tool_use_behavior` 控制"工具有结果之后怎么办"，四种形态：

| 取值 | 行为 | 典型用途 |
| --- | --- | --- |
| `"run_llm_again"`（默认） | 工具结果回填给模型，继续下一轮 | 绝大多数场景 |
| `"stop_on_first_tool"` | 第一个工具的输出直接当最终答案 | 纯查询型 Agent，省一次模型调用 |
| `StopAtTools(stop_at_tool_names=[...])` | 命中指定工具名就停，用它输出当答案 | "提交表单"这类终结动作 |
| 自定义函数 | 拿到 `list[FunctionToolResult]`，自己返回 `ToolsToFinalOutputResult` | 需要复杂判定条件 |

配套的是 `reset_tool_choice`（默认 `True`）：工具调用后把 `tool_choice` 复位成默认值。为什么需要它？因为如果你设了 `tool_choice="get_weather"` 强制调用，模型拿到结果后**还会**继续调同一个工具，形成无限循环。复位就是刹车。这个字段只在"Agent 已经用过工具之后"生效。

---

## 五、输出与安全字段：output_type、护栏、hooks

这一组字段决定"输出长什么样、要不要检查、要不要挂回调"。其中护栏（guardrail）负责在固定的位置插一道检查：

| 字段 | 作用 | 何时生效 |
| --- | --- | --- |
| `output_type` | 让最终输出是结构化对象而不是 `str` | 每次判定"最终答案"时校验 |
| `input_guardrails` | 输入检查 | **只在链条的第一个 Agent 上跑**，且默认与模型调用并行 |
| `output_guardrails` | 输出检查 | 该 Agent 产出最终输出时 |
| `hooks` | `AgentHooks`，作用域是"这一个 Agent" | 生命周期回调 |

三条容易踩的边：

1. **`input_guardrails` 不是"每个 Agent 都检查一次"**。源码注释原文是 "Runs only if the agent is the first agent in the chain"。交接之后的 Agent 只带 `output_guardrails`。
2. **`output_type` 一旦设置，模型的输出方式就变成结构化输出**，`final_output` 也随之变成那个类型。取用时要 `result.final_output_as(MyModel)`（第 5 章）。
3. **`hooks` 是 `AgentHooks` 而不是 `RunHooks`**，方法名也不一样：`AgentHooks` 用 `on_start`/`on_end`，`RunHooks` 用 `on_agent_start`/`on_agent_end`。传错对象会在 `__post_init__` 里被 `isinstance` 拦下。

---

## 六、泛型 context：Agent[TContext]

写 `Agent[Session](...)` 的唯一作用是让类型检查器帮你抓错，运行时没有任何额外保障。`Agent` 与 `AgentBase` 都是 `Generic[TContext]`。

如果你把 `instructions` 写成 `def f(ctx: RunContextWrapper[OtherContext], ...)`，mypy/pyright 会报不匹配。运行时不校验，传错 context 类型不会立刻报错，而是到工具里访问属性时才炸。

所以这条实践值得坚持：只要用了自定义 context，就总是写 `Agent[MyContext]`。并在 `Runner.run(..., context=...)` 处保持同一个类型，第 6 章会把这条约束展开成完整的依赖注入（dependency injection）模式。

顺带一个细节：`clone()` 的返回值类型仍是 `Agent[TContext]`，泛型参数会原样保留。所以派生出来的角色在类型检查层面依旧要求同一个 context 类型。

这既是保护，也是约束。如果两个角色真的需要不同的 context，就别用 clone 派生，直接分别构造更诚实。

---

## 七、clone() 浅拷贝：源码注释里写明的坑

`clone(**overrides)` 的实现就是 `dataclasses.replace`，所以它天然是浅拷贝。源码 docstring 把后果写得很清楚（`repo/src/agents/agent.py`）。

| 情况 | 结果 |
| --- | --- |
| 复制范围 | 从不复制 `tools`、`handoffs`、`mcp_servers`、`input_guardrails`、`output_guardrails` 这些列表。 |
| 没传的字段 | 拿到的是原 Agent 的那个 list 本身，两边共享同一个容器和同一批元素。 |
| 传了的字段 | 按原样使用。`agent.clone(tools=agent.tools)` 仍然共享，`agent.clone(tools=[other])` 才独立。 |
| 想要隔离 | 传新 list，例如 `agent.clone(tools=[*base.tools, extra_tool])`。但里面的**元素仍然是同一批工具对象**。 |

用三行断言把这件事钉死。下面这段验证"容器是否被复制"。

```python
from agents import Agent
from agents.decorators import tool


@tool
def now() -> str:
    """返回当前时间字符串。"""
    return "2026-01-01 00:00:00"


def main() -> None:
    base = Agent(name="基线", instructions="……", tools=[now])
    only_renamed = base.clone(name="只改名字")
    new_list = base.clone(name="新工具表", tools=[*base.tools])

    print(only_renamed.tools is base.tools)    # 预期输出：True（同一个 list）
    print(new_list.tools is base.tools)        # 预期输出：False（新 list）
    print(new_list.tools[0] is base.tools[0])  # 预期输出：True（元素仍是同一个工具对象）


if __name__ == "__main__":
    main()
```

把它存成 `clone_shallow_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python clone_shallow_demo.py
```

预期输出依次是 `True`、`False`、`True`。前两行说容器，第三行说元素。

---

## 八、用 clone 批量派生角色

真实项目里，"同一套工具、不同的指令与温度"是很常见的形态。下面这个例子用 clone 派生三个客服角色，并刻意演示正确与错误两种写法。

```python
from agents import Agent, ModelSettings
from agents.decorators import tool


@tool
def query_order(order_id: str) -> str:
    """查询订单状态。"""
    return f"订单 {order_id}：已发货"


@tool
def refund_order(order_id: str, reason: str) -> str:
    """为订单发起退款。"""
    return f"订单 {order_id} 已提交退款（原因：{reason}）"


@tool
def escalate_to_human(queue: str) -> str:
    """把会话转给人工队列。"""
    return f"已转接到 {queue} 队列"


def main() -> None:
    base = Agent(
        name="一线客服",
        instructions="你是客服。先查订单再给结论；不确定就转人工。",
        tools=[query_order],
        model_settings=ModelSettings(temperature=0.2),
    )

    vip = base.clone(
        name="VIP 客服",
        instructions="你是 VIP 客服，语气主动，可以直接退款。",
        tools=[*base.tools, refund_order],       # 新 list：与 base 完全隔离
    )

    supervisor = base.clone(
        name="升级客服",
        instructions="只处理需要人工介入的工单。",
        tools=[query_order, escalate_to_human],
    )

    print(len(base.tools), len(vip.tools), len(supervisor.tools))   # 预期输出：1 2 2

    oops = base.clone(name="错误示范")

    oops.tools.append(refund_order)              # 危险：改的是共享的那一个 list
    print(len(base.tools), len(oops.tools))       # 预期输出：2 2（base 被悄悄改动了）


if __name__ == "__main__":
    main()
```

把它存成 `clone_roles_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下。运行命令：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python clone_roles_demo.py
```

预期输出是 `1 2 2` 后跟 `2 2`。这段验证的是"没传的字段共享、传了新 list 才隔离"。

- `vip` 与 `supervisor` 都传了新 list，因此它们的 `tools` 与 `base` 无关。
- `oops` 没有传 `tools`，直接 `append` 就污染了 `base.tools`。最后一行输出里 `base` 变成了 2 个工具。
- 三个角色共享同一个 `query_order` 工具对象，这是**期望行为**，因为工具无状态。但如果你在工具对象上挂状态（例如自增计数器），就会在角色间串味。

**为什么 SDK 要选浅拷贝？** 因为 Agent 被设计成"不可变的声明"，而工具对象本应无状态、可复用。深拷贝会把 `FunctionTool`、`Handoff`、乃至 MCP 服务器连接一起复制，既昂贵又危险。你不会想为了派生一个角色而多连一台 MCP 服务器。

浅拷贝把"复制到哪里为止"的决定权交给调用方：容器由你给，元素默认复用。理解这一点，你就不会把 `clone()` 当成"安全沙箱"。

结论很简单：**clone 适合改标量字段（`name`、`instructions`、`model`、`model_settings`）；凡是 list 字段，一律显式传新 list**。更稳妥的做法是再包一层工厂函数，把"哪些字段允许覆盖"写进签名。

---

## 常见坑与排查

按症状查，每条都给出"症状 → 原因 → 修法"。

1. **症状**：`Agent(instructions=my_func)` 里 `my_func` 只接收一个参数，运行时报 `TypeError`。
   **原因**：动态指令的签名固定为 `(RunContextWrapper[TContext], Agent[TContext])`，两个位置参数。
   **修法**：补上 `agent` 参数；不需要就写 `_agent`。

2. **症状**：给第二个 Agent 也配了 `input_guardrails`，交接过去之后完全没生效。
   **原因**：输入护栏只在链条的第一个 Agent 上运行。
   **修法**：把输入检查放在入口 Agent，或改用工具护栏/输出护栏（第 14、15 章）。

3. **症状**：`Agent(model_settings={"temprature": 0.2})` 报 `TypeError`。
   **原因**：字典会按字段名强制转换成 `ModelSettings`，未知字段直接报错。这是刻意设计，防拼写错误被静默忽略。
   **修法**：拼对字段名；不确定时看 `repo/src/agents/model_settings.py`。

4. **症状**：`base.clone()` 出来的 Agent 改了工具，原 Agent 也跟着变。
   **原因**：浅拷贝，未覆盖的 list 字段与原对象共享。
   **修法**：`clone(tools=[*base.tools, extra])`；或改用工厂函数每个实例重新构造。

5. **症状**：给 `RealtimeAgent` 传 `model="gpt-realtime-2.1"`，发现没有任何效果。
   **原因**：`RealtimeAgent` 不支持逐 Agent 的 `model`/`model_settings`/`output_type`/`tool_use_behavior`，整个 session 共用一个实时模型。
   **修法**：模型配置放在 session/运行层，见第 26 章。

---

## 动手练习

1. **列一张自己的字段表**：挑一个你打算做的 Agent，把本章第一节的字段表抄一遍，只填你会用到的字段，并注明每个字段"为什么需要"。填不出来的，就是还没想清楚的需求。
2. **动态指令 + 静态指令对比**：用 `build_instructions` 的例子，把用户等级分别设为普通与 VIP，观察输出差异。再把函数改成 `async def`，确认行为一致。
3. **改仓库示例**：打开 `repo/examples/basic/dynamic_system_prompt.py`，把它改成"从 `os.environ` 读取风格"而不是 `random.choice`。然后用 `clone()` 从同一个基础 Agent 派生出"海盗版"和"机器人版"两个实例，跑同一条输入对比结果。

改之前先跑一遍原版，拿到基线。若仓库 clone 在别处，按自己的路径替换：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python examples/basic/dynamic_system_prompt.py
```

预期输出是一句带随机风格的问候，每次运行措辞不同。

---

## 本章小结

- 继承树：`AgentBase`（name/handoff_description/tools/mcp_servers/mcp_config）→ `Agent` → `SandboxAgent`；`RealtimeAgent` 直接继承基类并刻意砍掉模型相关字段。
- `instructions` 可以是字符串或 `(ctx, agent) -> str` 的函数，每次模型调用前求值，支持 async；`prompt` 是 OpenAI 平台模板，只在 OpenAI 模型 + Responses API 下可用，不能当 `instructions` 的替代。
- `mcp_config` 三个键：strict 转换、失败文案、服务器前缀命名；MCP 服务器生命周期由调用方管理。
- `tool_use_behavior` 四种形态，配 `reset_tool_choice` 防"强制 tool_choice 造成的无限调用"。
- 输入护栏只在链条第一个 Agent 上跑；`hooks` 是 `AgentHooks`（`on_start`/`on_end`），不是 `RunHooks`。
- `clone()` 是浅拷贝：未传的 list 字段共享，传新 list 才隔离，元素始终共享。派生角色时 list 一律显式传新 list。

---

## 延伸阅读

- Agent 全部字段与官方说明：`repo/docs/agents.md`
- 源码：`repo/src/agents/agent.py`（`AgentBase`、`Agent`、`clone`、`as_tool`）
- 实时与沙盒子类：`repo/src/agents/realtime/agent.py`、`repo/src/agents/sandbox/sandbox_agent.py`
- 示例：`repo/examples/basic/dynamic_system_prompt.py`、`repo/examples/basic/prompt_template.py`
- 现场：`repo/examples/agent_patterns/forcing_tool_use.py`（`tool_choice` 与 `reset_tool_choice` 的对照）
- 下一章：这些字段最终都要交给 `Runner`，第 4 章讲它怎么把它们跑起来。
