# 第7章 函数工具 function_tool

第 6 章我们把 `RunContextWrapper` 交到了工具手里，这一章开始真正给 Agent "装上手脚"。函数工具（function tool）是整套 SDK 里使用频率最高的原语：它把一个普通 Python 函数变成模型可以调用的工具，中间自动完成 schema 生成、参数校验、异常兜底和追踪。

学完这一章，你应该能凭直觉判断"这个函数能不能直接当工具用"，以及"它出错时模型到底看到了什么"。

## 学习目标

- 能写出 `@tool` 与 `@function_tool` 两种等价写法，并说明官方当前推荐哪一种。
- 能解释 SDK 从类型注解、docstring、Pydantic 生成工具 schema 的三步流程。
- 能判断一个工具该写同步还是异步、`context` 参数该放哪、能不能放别处。
- 能根据业务选择返回值形态：文本、结构化对象、`ToolOutputImage`、`ToolOutputFileContent`。
- 能配置 `failure_error_function`、`strict_mode`、`timeout`、`needs_approval`，并排查对应故障。

## 一、两种写法，其实是一个对象

仓库里有两种导入方式，导出的东西完全一样：`agents/decorators.py` 第 10 行就是一句 `tool = function_tool`。所以下面两个装饰器等价：

```python
import asyncio

from agents import Agent, Runner, function_tool
from agents.decorators import tool


@tool
def get_weather(city: str) -> str:
    """Return the current weather for a city.

    Args:
        city: City name in English, such as "Hangzhou".
    """
    return f"{city}: sunny, 24C"


@function_tool
def get_weather_legacy(city: str) -> str:
    """Return the current weather for a city."""
    return f"{city}: sunny, 24C"


async def main() -> None:
    agent = Agent(
        name="Weather agent",
        instructions="Answer weather questions with the provided tools.",
        tools=[get_weather],
    )
    result = await Runner.run(agent, "What's the weather in Hangzhou?")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

这段要验证的是"装饰器把函数变成了什么"：两个函数都被替换成 `FunctionTool` 实例，不再是普通函数。关键点：

- 官方在 0.25 的示例与文档里统一用 `from agents.decorators import tool`，`function_tool` 仍从 `agents` 顶层导出，等价可用。**新代码请用 `tool`**。
- 装饰器有两种调用形态：不带括号的 `@tool`（直接传函数）和带参数的 `@tool(name_override=..., timeout=...) `（返回装饰器）。
- `FunctionTool` 是 `@dataclass`，字段包括 `name`、`description`、`params_json_schema`、`on_invoke_tool`、`strict_json_schema`、`is_enabled`、`needs_approval`、`timeout_seconds` 等；想手工构造工具时（比如从 JSON 配置生成），直接实例化它即可。

> 提示：`@tool` 生成的 `FunctionTool` 暴露只读的 `__wrapped__` 指向原函数，便于测试与内省；但直接调用 `__wrapped__` 会绕过 schema 校验、context 注入、护栏、超时、错误兜底和追踪——它只适合"看一眼"，不能用来执行业务。

## 二、schema 是怎么"长"出来的

`@tool` 在装饰的那一刻就完成了 schema 生成，不会等到运行时。源码在 `repo/src/agents/function_schema.py`，分四步：

1. `inspect.signature` 取参数列表与默认值；
2. `get_type_hints(..., include_extras=True)` 解析类型注解，含 `Annotated` 里的元数据；
3. `griffe` 解析 docstring，得到工具描述与每个参数描述；
4. 用 `pydantic.create_model` 动态建一个 `{函数名}_args` 模型，再 `model_json_schema()` 出 JSON Schema。

因此 schema 的质量完全取决于你写的三样东西：**类型注解、docstring、`Field` 约束**。

```python
import json

from agents import FunctionTool

for item in agent.tools:
    if isinstance(item, FunctionTool):
        print(item.name, item.strict_json_schema)
        print(json.dumps(item.params_json_schema, indent=2, ensure_ascii=False))
```

预期输出（节选）：`params_json_schema` 是一个 `type: "object"`、`additionalProperties: false`、`required: ["city"]` 的对象，`city` 带 `description`（来自 docstring 的 `Args:` 段）。

docstring 支持 `google`、`numpy`、`sphinx` 三种风格，SDK 会自动探测；探测是启发式的，混写风格时请用 `@tool(docstring_style="google")` 显式指定，或用 `use_docstring_info=False` 完全关掉 docstring 解析（此时描述只能靠 `description_override`）。

想把约束写进 schema，用 Pydantic 的 `Field`，两种写法都支持：

```python
from typing import Annotated

from pydantic import Field

from agents.decorators import tool


@tool
def issue_coupon(
    amount: Annotated[int, Field(ge=1, le=500, description="Discount in CNY, 1-500.")],
    reason: Annotated[str, Field(min_length=4, max_length=60)],
) -> str:
    """Issue a coupon to the current customer."""
    return f"coupon {amount} CNY issued: {reason}"
```

生成的 JSON Schema 会带上 `minimum`/`maximum`/`minLength` 等关键字，模型侧看到的约束和运行时 Pydantic 校验是同一套。

> 注意：strict 模式（`strict_mode=True`，默认值）会把每个 object 的 `additionalProperties` 置为 `false`，并把 `required` 补成**全部**属性——见 `repo/src/agents/strict_schema.py` 里 `json_schema["required"] = list(properties.keys())`。这意味着即便参数在 Python 里有默认值，模型在 strict 下通常也会被要求显式给出该字段。如果你确实需要"可省略"的参数，请显式 `@tool(strict_mode=False)`，代价是模型填错 JSON 的概率上升。

## 三、同步、异步，与那个特殊的第一个参数

函数可以是同步的，也可以是异步的，SDK 都能处理：异步函数直接 `await`；同步函数会被丢进 `asyncio.to_thread` 执行，避免阻塞事件循环。所以"我的工具是阻塞 IO"不是问题，但**超时配置只对异步工具有效**，这一点很关键（见下一节）。

如果工具需要访问依赖（数据库连接、租户 ID、HTTP 客户端），把 `RunContextWrapper` 或 `ToolContext` 作为**第一个参数**：

```python
from dataclasses import dataclass

from agents import Agent, RunContextWrapper, Runner
from agents.decorators import tool


@dataclass
class ShopContext:
    tenant_id: str
    units_reserved: int = 0


@tool
async def place_order(ctx: RunContextWrapper[ShopContext], sku: str, quantity: int) -> str:
    """Place an order for a SKU.

    Args:
        sku: Product SKU, for example "SKU-1001".
        quantity: Number of units, must be positive.
    """
    if quantity <= 0:
        raise ValueError("quantity must be positive")
    ctx.context.units_reserved += quantity
    return f"order {ctx.context.tenant_id}-{sku} created, total units={ctx.context.units_reserved}"


async def main() -> None:
    agent = Agent[ShopContext](
        name="Order agent",
        instructions="Create orders with the place_order tool.",
        tools=[place_order],
    )
    result = await Runner.run(
        agent,
        "Order 2 units of SKU-1001.",
        context=ShopContext(tenant_id="tenant_acme"),
    )
    print(result.final_output)
```

三个要点：

- 这个参数**不会出现在 schema 里**，模型看不到也不需要填；`function_schema` 检测到第一个参数类型是 `RunContextWrapper`/`ToolContext` 时把它从参数列表剔除，并置 `takes_context=True`。
- 它必须严格在第一位。放在第二位会直接抛 `UserError`："RunContextWrapper/ToolContext param found at non-first position"。
- 需要工具名、调用 ID、原始参数时用 `ToolContext`（它是 `RunContextWrapper` 的子类，多了 `tool_name`、`tool_call_id`、`tool_arguments`、`tool_call`），审计日志和幂等键都靠它。

## 四、返回值：模型到底看到什么

这是最容易踩坑的一节。`ToolCallOutputItem` 在把结果转成 `function_call_output` 时遵循一条明确规则（`repo/src/agents/items.py` 的 `_convert_tool_output`）：

| 返回类型 | 模型看到的内容 | 适用场景 |
| --- | --- | --- |
| `str` | 原样字符串 | 绝大多数工具 |
| `ToolOutputText` | 文本项 | 需要和图片/文件混排时 |
| `ToolOutputImage` / `ToolOutputImageDict` | 图片项（`image_url` 或 `file_id`） | 截图、二维码、图表 |
| `ToolOutputFileContent` / `ToolOutputFileContentDict` | 文件项（`file_data`/`file_url`/`file_id`） | PDF、CSV、导出物 |
| `list`/`tuple`（元素是上面几种） | 多段输出 | 一次返回"文本 + 附件" |
| 其他任意对象 | `str(output)` 的结果 | **不推荐** |

看最后一行：返回 `{"sku": "SKU-1001", "stock": 12}` 这种 dict，模型收到的是 `{'sku': 'SKU-1001', 'stock': 12}`——Python repr，单引号，不是 JSON。返回 Pydantic 对象同理。想给模型结构化数据，请自己 `json.dumps(...)` 成字符串，或者返回 `ToolOutputText` 并在文本里放 JSON。

```python
from agents import ToolOutputFileContent, ToolOutputImage, ToolOutputText
from agents.decorators import tool


@tool
def export_invoice(order_id: str) -> list[ToolOutputText | ToolOutputFileContent]:
    """Export an invoice as text plus a PDF attachment."""
    return [
        ToolOutputText(text=f"invoice {order_id} generated"),
        ToolOutputFileContent(file_data="JVBERi0xLjQK...", filename=f"{order_id}.pdf"),
    ]


@tool
def render_qr(payload: str) -> ToolOutputImage:
    """Render a QR code for a short payload."""
    return ToolOutputImage(image_url="data:image/png;base64,iVBORw0KGgo...", detail="high")
```

`ToolOutputImage` 要求 `image_url` 与 `file_id` 至少给一个（模型校验会直接报错）；`ToolOutputFileContent` 要求 `file_data`、`file_url`、`file_id` 至少给一个。仓库里最直观的例子是 `repo/examples/basic/image_tool_output.py`，它同时演示了 Pydantic 模型与 TypedDict 两种返回写法。

## 五、错误怎么回到模型：failure_error_function

工具抛异常时，SDK 有两条路：把错误"翻译"成一段模型可见的文本，让模型自己决定重试还是道歉；或者直接把异常抛给调用方。选择权在 `failure_error_function`：

| 取值 | 行为 |
| --- | --- |
| 不传（默认） | 使用 `default_tool_error_function`，返回固定文案 `"An error occurred while running the tool."` |
| 传自定义函数 | 用你的返回值作为工具输出，异常不外泄 |
| 显式传 `None` | 异常向外抛（`ModelBehaviorError` 或你的异常），运行失败 |

默认文案是刻意"不含信息"的：它不暴露异常类型、堆栈和内部数据，防止敏感信息顺着 traceback 进模型上下文。代价是调试时你什么都看不到——所以开发期建议临时换成自定义函数，把**受控**的信息写进去。

```python
from typing import Any

from agents import RunContextWrapper
from agents.decorators import tool


def order_error_message(ctx: RunContextWrapper[Any], error: Exception) -> str:
    """Turn a tool crash into a model-visible, non-sensitive message."""
    return f"下单失败（{type(error).__name__}）：请先确认库存，再重试。"


@tool(failure_error_function=order_error_message)
def reserve_stock(sku: str, quantity: int) -> str:
    """Reserve stock for a SKU."""
    raise RuntimeError("inventory service unavailable")
```

注意区分三类失败，它们的处理路径并不相同：

- **模型给的 JSON 不合法 / 不符合 schema**：抛 `ModelBehaviorError`，属于模型行为问题，不是你的代码 bug。
- **你的函数内部异常**：交给 `failure_error_function`（未配置则默认兜底）。
- **工具超时**：走 `timeout_behavior`，见下一节。

## 六、strict_mode、timeout 与 needs_approval

**`strict_mode`**（默认 `True`）控制是否把 JSON Schema 转成 OpenAI 的 strict 规范。强烈建议保持默认：strict 会让模型几乎不可能输出多余字段，也便于结构化校验。只有一种常见例外——你想用 `**kwargs` 收参数：strict 下 `**kwargs` 会直接报 `UserError`，必须 `strict_mode=False` 并把关键字放进以参数名命名的嵌套对象里。

**`timeout`**（秒）是每个工具调用的超时，配套两个参数：

```python
import asyncio

from agents import Agent, Runner, ToolTimeoutError
from agents.decorators import tool


@tool(timeout=1.5, timeout_behavior="raise_exception")
async def slow_quote(sku: str) -> str:
    """Fetch a supplier quote (slow upstream)."""
    await asyncio.sleep(5)
    return f"{sku}: 199 CNY"


async def main() -> None:
    agent = Agent(name="Quote agent", tools=[slow_quote])
    try:
        await Runner.run(agent, "Quote SKU-1001.")
    except ToolTimeoutError as exc:
        print(f"{exc.tool_name} timed out in {exc.timeout_seconds} seconds")
```

- 默认 `timeout_behavior="error_as_result"`，模型会收到 `Tool 'slow_quote' timed out after 1.5 seconds.`，从而有机会换策略（这正是"可恢复错误"该有的样子）。
- `timeout_behavior="raise_exception"` 抛 `ToolTimeoutError`，整个 run 失败，适合"超时等于业务不可继续"的场景。
- `timeout_error_function` 可定制 `error_as_result` 时的文案。
- 超时**只支持异步工具**：给同步工具配 `timeout` 会在构造期抛 `ValueError`（"only supported for async @function_tool handlers"），因为同步工具跑在线程里，取消不保证生效。

**`needs_approval`** 是"人在环"的入口，可以传 `True` 或一个 `(run_context, tool_parameters, call_id) -> Awaitable[bool]` 的策略函数。一旦要求审批，run 会中断，待审批项出现在 `result.interruptions`，你用 `result.to_state()` 拿到 `RunState`，再 `state.approve(item)` 或 `state.reject(item, rejection_message=...)` 后带着 state 重新 `Runner.run` 即可续跑。完整的暂停/恢复语义在《第15章 工具护栏与工具审批》和《第16章 人类在环与中断恢复》展开，这里只需记住：**审批是运行时的门，不是工具内部的 if**。

```python
@tool(needs_approval=True)
async def refund_order(order_id: str, amount: int) -> str:
    """Refund an order. High-impact: requires human approval."""
    return f"refunded {amount} CNY for {order_id}"
```

## 七、命名与冲突

工具名就是模型看到的名字，默认取函数名。三个规则要记住：

1. **默认名会派生，显式名原样用**。函数工具默认取 `__name__`；`name_override` 写什么就是什么，SDK **不会**替你规范化。规范化只发生在派生场景：handoff 的 `transfer_to_<agent>` 与 `as_tool()` 未给 `tool_name` 时的默认名，会过一遍 `transform_string_function_style`（空白转下划线、非字母数字下划线替换、转小写，并打 warning）。所以手写 `name_override="Lookup Order"` 这种带空格的名称是危险动作，请自己写成 `lookup_order`。
2. **重名不会报错，会"静默择一"**。默认 `RunConfig(tool_name_collision_policy="warn")`：日志里警告，模型只看到其中一个；同名的 handoff 优先于函数工具。想让它在模型调用前就炸掉，设 `"error"`。
3. **多服务器场景请用命名空间**。MCP 工具可以用 `mcp_config={"include_server_in_tool_names": True}` 加 `mcp_<server>__<tool>` 前缀（第 9 章）；普通函数工具可以用 `tool_namespace()` 分组，或干脆 `name_override` 写全限定名。

```python
from agents import RunConfig

run_config = RunConfig(tool_name_collision_policy="error")
```

## 八、工具可见性：is_enabled 与延迟加载

真实业务里，"有哪些工具"不该是编译期常量。`is_enabled` 让你按运行时条件开关一个函数工具：

```python
from agents import AgentBase, RunContextWrapper
from agents.decorators import tool


def refund_enabled(ctx: RunContextWrapper[ShopContext], agent: AgentBase) -> bool:
    """Only expose refunds to tenants on the pro plan."""
    return ctx.context.tenant_id.startswith("tenant_pro")


@tool(is_enabled=refund_enabled)
def refund_order(order_id: str, amount: int) -> str:
    """Refund an order."""
    return f"refunded {amount} CNY for {order_id}"
```

它可以是 `bool`，也可以是 `(run_context, agent) -> bool | Awaitable[bool]`。被关掉的工具会**从模型看到的工具列表里消失**，而不是"调用时被拒绝"——这对成本和误调用都更友好。注意 `is_enabled` 只管可见性与派发，**不是授权**：涉及金额、权限的判断仍然要写在函数内部，或交给工具护栏与审批。

另一个 0.25 的新能力是 `@tool(defer_loading=True)`：工具定义先不下发给模型，等模型通过 `ToolSearchTool()` 主动搜索时再加载。它适合"工具很多、单个会话只用其中几个"的场景，代价是必须同时配 `ToolSearchTool()`，否则这些工具永远不可见。工具面超过二三十个时，这是比"全部塞进 tools 列表"更省钱的做法，细节见下一章的托管工具搜索。

## 九、一个完整例子：查库存 + 下单

把上面所有零件拼起来：一个带依赖的 context、两个工具（一个只读、一个写）、自定义错误文案、下单前审批。

```python
import asyncio
from dataclasses import dataclass, field
from typing import Any

from agents import Agent, RunContextWrapper, Runner
from agents.decorators import tool


@dataclass
class ShopContext:
    tenant_id: str
    stock: dict[str, int] = field(default_factory=lambda: {"SKU-1001": 12, "SKU-2002": 0})
    orders: list[str] = field(default_factory=list)


def shop_error_message(ctx: RunContextWrapper[Any], error: Exception) -> str:
    return f"操作失败（{type(error).__name__}），请确认 SKU 与数量后重试。"


@tool
def check_inventory(ctx: RunContextWrapper[ShopContext], sku: str) -> str:
    """Check available stock for a SKU.

    Args:
        sku: Product SKU such as "SKU-1001".
    """
    available = ctx.context.stock.get(sku)
    if available is None:
        raise KeyError(sku)
    return f"{sku}: {available} units available"


@tool(failure_error_function=shop_error_message, needs_approval=True)
def place_order(ctx: RunContextWrapper[ShopContext], sku: str, quantity: int) -> str:
    """Place an order for a SKU.

    Args:
        sku: Product SKU such as "SKU-1001".
        quantity: Number of units, must be positive.
    """
    available = ctx.context.stock.get(sku, 0)
    if quantity <= 0 or quantity > available:
        raise ValueError(f"insufficient stock for {sku}")
    ctx.context.stock[sku] = available - quantity
    order_id = f"{ctx.context.tenant_id}-{len(ctx.context.orders) + 1:04d}"
    ctx.context.orders.append(order_id)
    return f"order {order_id} placed: {quantity} x {sku}"


async def main() -> None:
    agent = Agent[ShopContext](
        name="Shop agent",
        instructions=(
            "You help customers check stock and place orders. "
            "Always check inventory before placing an order."
        ),
        tools=[check_inventory, place_order],
    )
    result = await Runner.run(
        agent,
        "Do you have SKU-1001? If yes, order 2 units.",
        context=ShopContext(tenant_id="tenant_acme"),
    )
    print(result.final_output)
    print(result.interruptions)  # 下单需要审批，这里会有一项待审批


if __name__ == "__main__":
    asyncio.run(main())
```

预期输出：第一次 run 结束时 `final_output` 可能是空或一句"等待审批"，`result.interruptions` 里有一项 `ToolApprovalItem`；`state.approve(item)` 后再 `Runner.run(agent, state)` 才会真正扣库存。

## 常见坑与排查

1. **模型说"工具返回了奇怪的东西"**：工具返回了 dict/Pydantic 对象，被 `str()` 成了单引号 repr。**修法**：返回 `str`（内部 `json.dumps`）或 `ToolOutputText`。
2. **工具描述为空，模型几乎不调用或乱填参数**：函数没写 docstring，且没用 `description_override`。**修法**：补 docstring，或在 `@tool(description_override=...)` 里写清"什么时候该用、参数什么意思"。
3. **给同步工具配 `timeout` 直接构造失败**：`ValueError: only supported for async @function_tool handlers`。**修法**：改成 `async def`，或去掉 timeout 用外层 `asyncio.wait_for`。
4. **异常信息全部消失，只看到 "An error occurred while running the tool."**：默认 `default_tool_error_function` 故意脱敏。**修法**：开发期传自定义 `failure_error_function`；线上保持脱敏，靠 trace 定位。
5. **两个工具只有一个能被调用**：重名冲突被 `tool_name_collision_policy="warn"` 静默择一。**修法**：`name_override` 区分，或设 `"error"` 让问题尽早暴露。
6. **context 参数放在第二位报 `UserError`**：schema 只允许 context 在第一位。**修法**：调整签名顺序，其余参数照常。

## 动手练习

1. 写一个 `get_weather(city: str) -> str` 工具，给 Agent 用，并打印 `params_json_schema`，确认 `required`、`additionalProperties`、`description` 都符合预期。
2. 给上面的 `place_order` 加上 `Annotated[int, Field(ge=1, le=99)]` 与 `timeout=2.0`，再故意让内部 `await asyncio.sleep(5)`，分别用 `error_as_result` 和 `raise_exception` 观察模型输出与异常。
3. 打开 `repo/examples/basic/image_tool_output.py`，把 `fetch_random_image` 改成返回"一张图片 + 一段文本说明"的列表（`ToolOutputImage` + `ToolOutputText`），并保证 `return_typed_dict` 两条分支都能工作。

## 本章小结

- `tool` 就是 `function_tool` 的别名，新代码统一从 `agents.decorators` 导入。
- schema 来自类型注解 + docstring + Pydantic；docstring 风格自动探测，可显式指定或关闭。
- 第一个参数可以是 `RunContextWrapper`/`ToolContext`，它不进入 schema，且必须在第一位。
- 返回值只有 `str` 和 `ToolOutput*` 被正确理解，其他对象会被 `str()`。
- 默认错误兜底是脱敏的固定文案；要可恢复的错误信息就传自定义 `failure_error_function`。
- `strict_mode=True` 是默认，也是推荐值；`timeout` 只对异步工具有效。
- `needs_approval` 让 run 暂停并可恢复，细节在第 15、16 章；`is_enabled` 只控制可见性，不是授权。
- 工具太多时用 `defer_loading=True` + `ToolSearchTool()` 延迟加载，别把几十个 schema 全塞给模型。

## 延伸阅读

- `repo/docs/tools.md`（Function tools / Handling errors / Function tool timeouts 三节）
- `repo/src/agents/tool.py`（`function_tool`、`FunctionTool`、`default_tool_error_function`）
- `repo/src/agents/function_schema.py` 与 `repo/src/agents/strict_schema.py`
- `repo/examples/basic/tools.py`、`repo/examples/basic/image_tool_output.py`
- 下一章：《第8章 托管工具家族》——当函数工具不够用时，OpenAI 侧直接执行的工具长什么样。
