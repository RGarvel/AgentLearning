# 第20章 结构化输出与output_type

上一章我们决定了“谁来回答”，这一章决定“答案长什么样”。当 Agent 的输出要直接入库、直接调下游 API、直接渲染表格时，一段自然语言就是负债：你没法可靠地解析它，也没法给它写测试。`output_type` 就是把这个负债变成资产的开关。

本章会从“能传什么类型”一路讲到“失败时到底抛哪个异常”，最后用一个简历解析的例子把它们串起来。

## 学习目标

- 能说清 `output_type` 接受哪些类型，以及哪些类型会被自动包一层 `response` 键。
- 能读懂 `AgentOutputSchema` 的五个方法与 strict 模式的四条硬限制。
- 能判断什么时候必须关掉 strict（并知道代价）。
- 能区分 `final_output`、`final_output_as()` 与 `AgentOutputSchema.validate_json()` 各自的职责。
- 能在模型拒答或校验失败时，用 `run_error_handlers` 做可控降级。
- 能独立写出“简历文本 → 结构化对象 → 工具入库”的完整链路。

## 20.1 能传什么：一句话与一张表

官方文档的说法是：支持任何能被 Pydantic `TypeAdapter` 包起来的类型。这句话的边界比听起来更宽：

| 类型 | 示例 | 是否被包 `response` 键 | 备注 |
| --- | --- | --- | --- |
| Pydantic 模型 | `class Resume(BaseModel)` | 否 | 最推荐，schema 可控 |
| dataclass | `@dataclass class Meta` | 是 | 需要严格 schema 时注意默认值 |
| TypedDict | `class Meta(TypedDict)` | 是 | 校验后仍是 dict，只能用键访问 |
| 列表 | `list[Resume]` | 是 | 顶层必须是对象，故被包一层 |
| 标量 | `int`、`bool` | 是 | 能用但不常见 |
| `None` / `str` | — | — | 视为纯文本，不启用结构化输出 |
| `AgentOutputSchemaBase` 实例 | 自定义 schema | 由你决定 | 完全接管解析 |

“包一层 `response` 键”不是实现细节，它会出现在模型的 JSON 里，也会影响你调试时看到的内容。源码 `repo/src/agents/agent_output.py` 的判断是：

```python
self._is_wrapped = not _is_subclass_of_base_model_or_dict(output_type)
```

也就是说，只有 Pydantic 模型与 `dict` 子类不包；dataclass、TypedDict、`list[...]` 都会被包成 `{"response": ...}`。模型看到的 schema 就是这个包装后的对象，而 `validate_json()` 会在最后把 `response` 拆出来还给你——所以业务代码里你拿到的仍然是 `list[Resume]`，不是包装字典。

## 20.2 AgentOutputSchema：五个方法定义的契约

`AgentOutputSchemaBase` 是抽象基类，只有五件事要交代：

| 方法 | 作用 | 什么时候被调用 |
| --- | --- | --- |
| `is_plain_text()` | 是否纯文本 | 每轮决定要不要走 JSON 校验 |
| `name()` | 类型名，用于日志与 trace | 构造时与调试时 |
| `json_schema()` | 发给模型的 JSON Schema | 纯文本时调用会抛 `UserError` |
| `is_strict_json_schema()` | 是否 strict | 由适配器决定请求形态 |
| `validate_json(json_str)` | 解析并校验，失败抛 `ModelBehaviorError` | 拿到最终文本后 |

`output_type` 到 schema 的转换发生在 `repo/src/agents/run_internal/turn_preparation.py`：

```python
def get_output_schema(agent: Agent[Any]) -> AgentOutputSchemaBase | None:
    if agent.output_type is None or agent.output_type is str:
        return None
    elif isinstance(agent.output_type, AgentOutputSchemaBase):
        return agent.output_type
    return AgentOutputSchema(agent.output_type)
```

三种输入、三种命运：`None` 与 `str` 直接不启用；传自定义 schema 实例则原样使用（`repo/examples/basic/non_strict_output_type.py` 就是这条路）；传类型则默认 `strict_json_schema=True`。

自定义 schema 值得单独说一句：它是唯一能“接管解析后处理”的入口。比如模型吐出的数组需要去重、时间字段需要归一化、金额需要乘 100 存整数，这些都能塞进 `validate_json()`。代价是你也要自己承担全部校验责任——SDK 不会在它外面再补一层。团队里常见的分工是：通用结构用 `AgentOutputSchema`，只有确实存在“模型输出的形状与业务对象不一致”时才写自定义 schema，并给它配单元测试。

## 20.3 strict 模式的四条硬限制

strict 不是“更严格的校验”，而是一组**会改变 schema 结构**的转换规则。`repo/src/agents/strict_schema.py` 做四件事：

1. **所有属性都进 `required`**。源码里 `json_schema["required"] = list(properties.keys())`——没有“可选字段”这回事。想表达可选，只能用 `Optional[T]`（schema 里变成 nullable），让模型显式给 `null`。
2. **`additionalProperties: false`**。对象不允许出现未声明字段；如果你给了允许任意键的 dict schema，会直接 `UserError`。
3. **根必须是不可为 null 的 object**。根用 `anyOf` 会被拒绝；`list` 之所以能用，是因为它被包进了 `response` 键。
4. **`oneOf` 会被改写成 `anyOf`**，因为结构化输出在嵌套上下文里不支持前者。

不满足这些条件的类型会在**构造 Agent 时**就抛 `UserError`，不是等模型返回才炸：

```text
Strict JSON schema is enabled, but the output type is not valid.
Either make the output type strict, or wrap your type with
AgentOutputSchema(YourType, strict_json_schema=False)
```

典型触发者是“带任意键的 dict”与“字段有非 None 默认值的 dataclass”。后者尤其隐蔽：`source: str = "manual"` 这种写法在 strict 下会被要求显式提供，模型可能照做，但你的业务代码以为可以省略。

关掉 strict 的写法与代价：

```python
from agents import Agent, AgentOutputSchema

agent = Agent(
    name="Assistant",
    output_type=AgentOutputSchema(JokeBook, strict_json_schema=False),
)
# 代价：SDK 不再保证 JSON 合法，validate_json 可能抛 ModelBehaviorError
```

> 注意：strict 保证的是“JSON 结构合法”，不是“内容正确”。字段值编造、数字量级错误，strict 一概不管——那属于第 23 章评估与第 14 章护栏的职责。

## 20.4 final_output 已经是对象，final_output_as 只做类型窄化

这是新手最常绕的弯路：拿到 `result` 后先 `json.loads(result.final_output)`。不用。当 `output_type` 生效时，`final_output` 在运行循环里已经过 `validate_json()`，是**真正的 Python 对象**：

| 场景 | `final_output` 的类型 |
| --- | --- |
| 无 `output_type` | `str` |
| `output_type=Resume` | `Resume` 实例 |
| `output_type=list[Resume]` | `list[Resume]` |
| `output_type` 生效但运行被中断 | `None` |

`final_output_as(cls, raise_if_incorrect_type=False)` 的作用只是给静态类型检查器一个交代。默认情况下它**不校验**，只在 `raise_if_incorrect_type=True` 时做一次 `isinstance`：

```python
resume = result.final_output_as(Resume)  # 纯类型转换，不做检查
resume = result.final_output_as(Resume, raise_if_incorrect_type=True)  # 类型不符抛 TypeError
```

为什么要它？因为 `final_output` 的类型标注是 `Any`——handoff 可能让另一个 Agent 收尾，SDK 无法静态推断最终类型。它解决的是“编辑器不知道类型”，不是“运行时可能拿错类型”。

排障时也别只盯 `final_output`。结构化输出出问题时，真正有价值的是两处原始材料：`result.raw_responses[-1].output` 里模型实际吐出的文本，以及 `result.new_items` 里最后一条 `MessageOutputItem`。前者告诉你 JSON 长什么样，后者告诉你 SDK 把它归到了哪一轮。先看这两个，再决定是改 schema、改 prompt，还是加降级处理器。

## 20.5 嵌套与可选字段：怎么写才不踩 strict

```python
from pydantic import BaseModel, Field


class Project(BaseModel):
    name: str
    role: str
    highlights: list[str] = Field(default_factory=list)


class Resume(BaseModel):
    candidate_name: str
    years_of_experience: float
    skills: list[str]
    current_company: str | None = None
    projects: list[Project] = Field(default_factory=list)
    expected_salary: int | None = None
```

要点三条。第一，`Optional` 字段在 schema 里是 nullable，模型会明确输出 `null`，这比“字段可能缺失”可靠。第二，嵌套模型会被递归转成 strict，`properties` 里每个子 schema 都会走同一套规则。第三，`Field(default_factory=list)` 在 strict 下依然会进 `required`——模型必须给出这个字段，只是值可以是空列表。

如果你需要模型“尽量少给字段”，正确做法不是依赖 strict 的默认值，而是把提示词与字段设计对齐：要么给 `Optional`，要么让模型输出空集合。

## 20.6 与 tools 同时使用：两条输出通道

`output_type` 与 `tools` 完全可以同时开。运行循环的行为是：模型可以连续调用工具，每一轮的工具结果回到上下文；**只有最后一条 assistant 消息**会被 `validate_json()` 处理。这条消息通常出现在模型认为“信息够了”之后。

但有一条反直觉的边界：如果 `tool_use_behavior` 让工具输出直接成为最终结果（`stop_on_first_tool`，或 `ToolsToFinalOutputFunction` 返回 `is_final_output=True`），那么 `final_output` 就是工具返回值，**不会**再过 `output_type` 的 schema 校验。源码 `_maybe_finalize_from_tool_results()` 里只在纯文本场景做 `str()` 转换，没有 `validate_json` 调用。

> 提示：想保证“工具直出也符合结构”，让工具自己返回 Pydantic 对象，或在 `ToolsToFinalOutputFunction` 里先校验再返回。不要假设 `output_type` 会兜住它。

还有一个协作层面的细节：同时开工具与 `output_type` 时，instructions 里要明确“先取数据、再给结论”，否则模型很容易只输出一个空壳对象（字段全填默认值）就收工。结构化输出把“形状”约束住了，但“先做哪一步”仍然只能靠提示词和工具描述来编排。这也是第 7 章反复强调工具 docstring 要写清触发条件的原因。

## 20.7 模型拒答与校验失败：三个异常，三种处置

结构化输出会失败的场景只有三类，对应三个明确出口：

| 现象 | 异常 | 触发点 |
| --- | --- | --- |
| 模型拒绝回答（安全策略） | `ModelRefusalError` | 最后一条消息带 `refusal` 字段 |
| JSON 不合法或类型不符 | `ModelBehaviorError` | `AgentOutputSchema.validate_json()` |
| 拿不到任何文本 | 先走 `NextStepRunAgain` | 模型只回了工具调用或空内容 |

三者都可以用 `Runner.run(..., error_handlers=...)` 接管。`RunErrorHandlers` 只认三个键：`max_turns`、`model_refusal`、`invalid_final_output`。

```python
from agents import Agent, RunErrorHandlerInput, RunErrorHandlers, RunErrorHandlerResult, Runner


def on_invalid_output(input: RunErrorHandlerInput) -> RunErrorHandlerResult | None:
    # 降级：返回一个保守的默认对象，并让它不进历史
    return RunErrorHandlerResult(
        final_output=Resume(
            candidate_name="unknown",
            years_of_experience=0.0,
            skills=[],
        ),
        include_in_history=False,
    )


handlers: RunErrorHandlers = {"invalid_final_output": on_invalid_output}
result = await Runner.run(agent, resume_text, error_handlers=handlers)
```

`RunErrorHandlerInput` 里有 `error`、`context`、`run_data`（含 `new_items`、`raw_responses`、`last_agent`），足够你打日志或做局部重试。返回 `None` 表示“不处理”，SDK 会照原样抛出——这也是默认行为，别把降级写成默认。

## 20.8 完整例子：简历解析 → 结构化 JSON → 入库

这个例子要验证两件事：模型先调工具拿到岗位要求，再输出符合 `Resume` 的对象；入库动作发生在工具里，而不是在 `final_output` 之后。

```python
import asyncio
import json

from pydantic import BaseModel, Field

from agents import Agent, Runner
from agents.decorators import tool


class Project(BaseModel):
    name: str
    role: str
    highlights: list[str]


class Resume(BaseModel):
    candidate_name: str
    years_of_experience: float
    skills: list[str]
    current_company: str | None = None
    projects: list[Project] = Field(default_factory=list)


SAVED: list[Resume] = []


@tool
def save_resume(resume: Resume) -> str:
    """把解析后的简历写入人才库。"""
    SAVED.append(resume)
    return f"saved:{resume.candidate_name}:{len(SAVED)}"


@tool
def job_requirements(job_id: str) -> str:
    """返回岗位的硬性要求。"""
    return "backend: Python 3.10+, 5 年以上, 有高并发经验"


agent = Agent(
    name="Resume parser",
    instructions=(
        "你负责把简历文本解析成结构化数据。"
        "先调用 job_requirements 了解岗位，再调用 save_resume 入库，最后输出解析结果。"
    ),
    tools=[job_requirements, save_resume],
    output_type=Resume,
)


RESUME_TEXT = """
张伟，8 年后端经验，现任某支付公司高级工程师。
主导过日均 2 亿请求的网关重构，QPS 从 8k 提到 24k。
技能：Python、Go、Kafka、PostgreSQL。
"""


async def main() -> None:
    result = await Runner.run(agent, RESUME_TEXT)
    resume = result.final_output_as(Resume, raise_if_incorrect_type=True)
    print(json.dumps(resume.model_dump(), ensure_ascii=False, indent=2))
    print("已入库条数：", len(SAVED))


if __name__ == "__main__":
    asyncio.run(main())
```

预期输出（示意，模型措辞会浮动）：

```text
{
  "candidate_name": "张伟",
  "years_of_experience": 8.0,
  "skills": ["Python", "Go", "Kafka", "PostgreSQL"],
  "current_company": "某支付公司",
  "projects": [
    {"name": "支付网关重构", "role": "主导", "highlights": ["QPS 8k 提升到 24k"]}
  ]
}
已入库条数： 1
```

四个关键行：

- `output_type=Resume` 让每轮请求都带上 strict schema，模型从一开始就知道“最终要交这个形状”。
- `save_resume(resume: Resume)` 的参数类型就是 schema 的来源；工具参数与 `output_type` 共用同一套 Pydantic 校验，不要手工 `json.loads`。
- 工具在中间轮执行，`final_output` 是最后一轮的消息对象——两条通道互不干扰。
- `final_output_as(..., raise_if_incorrect_type=True)` 是一道廉价保险，尤其在 handoff 存在时。

为什么把入库放在工具里，而不是拿到 `final_output` 之后再写数据库？因为工具调用发生在运行循环内部，失败会被 SDK 转成模型可见的错误并进入下一轮；而 `final_output` 之后写库失败，只能由你的应用代码自己重试，且此时会话状态已经推进。副作用越靠近循环内部，重试语义越清晰——这也是第 7 章“工具要幂等”的实际原因。

## 常见坑与排查

1. **症状**：`Agent(...)` 构造时报 `UserError: Strict JSON schema is enabled, but the output type is not valid`。
   **原因**：类型里有 `dict[str, Any]`、非 None 默认值、根级 `anyOf`，或额外的 `additionalProperties`。
   **修法**：优先改类型（换 `Optional`、换显式模型）；确实改不动才用 `AgentOutputSchema(T, strict_json_schema=False)`，并接受“可能拿到坏 JSON”。

2. **症状**：`final_output` 是字符串，`final_output_as(Resume)` 拿到的是 `str`。
   **原因**：要么漏了 `output_type`，要么运行在 `stop_on_first_tool` 下由工具直出，要么 handoff 给了另一个没有 `output_type` 的 Agent。
   **修法**：检查 `result.last_agent.output_type`；需要强约束时给收尾 Agent 也设 `output_type`，或用 `raise_if_incorrect_type=True` 尽早暴露。

3. **症状**：偶尔抛 `ModelBehaviorError`，内容里带原始 JSON。
   **原因**：非 strict 模式下模型给了不合 schema 的 JSON，或字段类型不符（例如把 `"8"` 当数字）。
   **修法**：先用 strict；仍不稳定就加 `invalid_final_output` 处理器做一次“带错误信息重试”，而不是无限循环。

4. **症状**：`ModelRefusalError` 突然出现，业务代码当成解析失败处理。
   **原因**：这是**内容政策层面的拒绝**，不是 schema 问题；重试同一 prompt 通常无效。
   **修法**：用 `model_refusal` 处理器返回兜底输出并记录 `error.refusal`，同时把命中样本喂回评估集。

5. **症状**：`output_type=list[Resume]` 时模型总在 JSON 外面多包一层。
   **原因**：这是设计行为——非 BaseModel 类型会被包成 `{"response": [...]}`。
   **修法**：不要自己再包一层；`validate_json()` 已经拆过了。写 prompt 时也别让模型“输出数组”，要按 schema 说话。

## 动手练习

1. **观察包装**：用 `AgentOutputSchema(list[Resume])` 打印 `json_schema()`，再用 `AgentOutputSchema(Resume)` 打印一次，对比顶层 `properties` 的键名差异。
2. **制造失败**：把 `Resume.years_of_experience` 改成 `int`，喂一段含“8.5 年”的文本，看默认抛出什么异常；再加 `invalid_final_output` 处理器，观察返回结果与 `run_data.raw_responses`。
3. **改造示例**：打开 `repo/examples/basic/non_strict_output_type.py`，把其中的 `CustomOutputSchema` 换成一个“只保留前 3 条 joke”的自定义 schema，体会 `validate_json()` 里做后处理的自由度。

## 本章小结

- `output_type` 接受任何 Pydantic `TypeAdapter` 可包装的类型；非 BaseModel 会被包成 `{"response": ...}`。
- `AgentOutputSchema` 的契约是五个方法：`is_plain_text`、`name`、`json_schema`、`is_strict_json_schema`、`validate_json`。
- strict 会把所有属性设为 required、关闭 `additionalProperties`、要求根为 object、把 `oneOf` 改成 `anyOf`。
- `final_output` 已是对象；`final_output_as()` 只做类型窄化，`raise_if_incorrect_type=True` 才真正检查。
- 工具直出的 `final_output` 不走 `output_type` 校验，这是最隐蔽的边界。
- 失败出口三个：`ModelRefusalError`（拒答）、`ModelBehaviorError`（校验失败）、空输出重跑一轮。
- `error_handlers` 的三个键：`max_turns`、`model_refusal`、`invalid_final_output`。

## 延伸阅读

- 输出类型与提示模板：`repo/docs/agents.md`
- 结果与 final_output：`repo/docs/results.md`
- strict schema 源码：`repo/src/agents/strict_schema.py`、`repo/src/agents/agent_output.py`
- 示例：`repo/examples/basic/non_strict_output_type.py`、`repo/examples/agent_patterns/agents_as_tools_structured.py`
- 错误处理：`repo/src/agents/run_error_handlers.py`、`repo/docs/ref/run_error_handlers.md`
- 下一章：《第21章 流式输出与事件》——把最终对象变成用户眼前逐字出现的过程。
