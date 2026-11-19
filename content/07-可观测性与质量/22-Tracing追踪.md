# 第22章 Tracing追踪

第 21 章把运行过程变成了可观察的事件流，但那是给人看的、一次性的。凌晨三点线上那次失败，你手里只剩一张工单截图和一句“Agent 胡说八道”。这时你需要的是另一种东西：**可回溯的结构化证据**。0.25.0 的 tracing 就是干这个的——它默认开启，你什么都不写也在记录。

这一章既讲怎么读这棵 trace 树，也讲怎么把它接到你自己的系统里，最后讲最常遇到的“trace 没了”。

## 学习目标

- 能画出 trace 与 span 的层级，并说出 task、turn、agent、generation、function、handoff、guardrail 各记什么。
- 能通过三种方式开关 tracing，并说清 `trace_include_sensitive_data` 影响哪些字段。
- 能用 `trace_id`、`group_id`、`workflow_name`、`metadata` 组织一次会话级的追踪。
- 能用 `trace()` 与 `custom_span()` 给业务代码加上可检索的节点。
- 能实现一个 `TracingProcessor`，并知道 `add_trace_processor` 与 `set_trace_processors` 的区别。
- 能排查“trace 缺失 / trace 太长 / trace 泄露敏感数据”三类问题。

## 22.1 两个对象：Trace 与 Span

`Trace` 表示一次端到端的工作流，`Span` 表示其中一段有起止时间的操作。两者的字段设计得极其克制：

| 对象 | 关键字段 | 说明 |
| --- | --- | --- |
| `Trace` | `name`、`trace_id`；`group_id` 与 `metadata` 在 `export()` 的载荷里 | `trace_id` 形如 `trace_<32位字母数字>`，可用 `gen_trace_id()` 生成 |
| `Span` | `trace_id`、`span_id`、`parent_id`、`started_at`、`ended_at`、`span_data`、`error` | 时间是 ISO 字符串；`span_data` 是类型化的载荷对象 |

层级不是靠“嵌套对象”表达的，而是靠 `parent_id` 串起来的。当前 trace 与当前 span 存在 Python 的 `contextvar` 里，所以**并发任务会自动各归各的**——这也是为什么 SDK 敢在 async 环境里默认开启 tracing。

## 22.2 默认 span 树：你什么都没写，但已经记了七种

一次 `Runner.run()` 默认会产生下面这棵树：

```text
trace("Agent workflow")
└── task_span          每次 Runner 调用一个
    └── turn_span      每个模型轮次一个
        └── agent_span 每次 Agent 执行为一个
            ├── generation_span  每次模型调用
            ├── function_span    每次函数工具调用
            ├── handoff_span     每次交接
            └── guardrail_span   每个护栏
```

对应的 `SpanData` 类型与记录内容：

| span | 数据类 | 记录什么 |
| --- | --- | --- |
| 任务 | `TaskSpanData` | name |
| 轮次 | `TurnSpanData` | turn 序号、agent 名 |
| Agent | `AgentSpanData` | name、handoffs、tools、output_type |
| 模型调用 | `GenerationSpanData` | input、output、model、model_config、usage、tools |
| 工具调用 | `FunctionSpanData` | name、input、output |
| 交接 | `HandoffSpanData` | from_agent、to_agent |
| 护栏 | `GuardrailSpanData` | name、triggered |

此外还有 `response_span`（只存 Responses API 的响应对象）、`mcp_tools_span`（MCP 工具清单）、以及语音场景的 `transcription_span`、`speech_span`、`speech_group_span`。它们的存在说明一件事：**span 类型是按“可观测的边界”划分的，不是按模块**。

trace 的默认名字是字面量 `Agent workflow`。想改成业务名，用 `RunConfig(workflow_name="Customer support")`；或者用 `trace()` 把多次 `run()` 包进同一个 trace：

```python
from agents import Agent, Runner, trace


async def run_two_steps(agent: Agent) -> None:
    with trace("Pricing review"):
        draft = await Runner.run(agent, "列出涨价的三条风险")
        critique = await Runner.run(agent, f"反驳这段：{draft.final_output}")
    print(critique.final_output)
```

两个 `run()` 落在同一个 trace 下，是因为 `trace()` 会把当前 trace 压进 contextvar。离开 `with` 块即恢复。

如果觉得默认层级太啰嗦（长跑任务里 task 与 turn 会撑出几百个节点），可以只关这两层：

```python
from agents import RunConfig

run_config = RunConfig(tracing={"include_task_and_turn_spans": False})
```

agent、generation、function、handoff、guardrail 都还在，只是少了两层包裹。

## 22.3 开关与敏感数据

tracing 默认开启，关闭方式有三种，粒度不同：

| 方式 | 生效范围 | 写法 |
| --- | --- | --- |
| 环境变量 | 进程级 | `OPENAI_AGENTS_DISABLE_TRACING=1` |
| 全局函数 | 进程级 | `set_tracing_disabled(True)` |
| 单次运行 | 单次 `run` | `RunConfig(tracing_disabled=True)` |

环境变量的读取是**一次性的**：源码在第一次判断时缓存 `OPENAI_AGENTS_DISABLE_TRACING`，之后再改环境变量、只要没调用 `set_tracing_disabled()`，不会生效。而 `set_tracing_disabled()` 一旦调用，就压过环境变量。这个优先级顺序在写测试夹具时要记住。

还有一条硬限制：**使用 OpenAI API 的零数据保留（ZDR）组织无法使用 tracing**。这不是配置问题，是合规约束，只能改接第三方处理器。

敏感数据由 `trace_include_sensitive_data` 控制，默认 `True`：

| 设置 | 受影响的内容 |
| --- | --- |
| `True`（默认） | `generation_span` 的 input/output、`function_span` 的 input/output、音频 base64 |
| `False` | 上述字段被剔除；span 仍然存在，只是没有载荷 |

不改代码的等价写法是环境变量 `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=0`。生产环境我建议默认设成 `0`，需要排查时再对单次运行打开——否则一次误传的用户身份证号会永久留在追踪后端里。

当它被关掉时，Responses 的模型 span 会省略请求与响应，但（对官方端点）仍保留 `response_id` 作为关联线索；自定义端点则会把这个 ID 也去掉。这条差异在跨系统对账时很关键。

> 注意：`flush_traces()` 在 disabled 之后**仍然会导出已缓冲数据**。也就是说“我刚关掉 tracing”不等于“之前的数据不会上传”。真要清理，必须在关闭前就换掉处理器。

## 22.4 trace_id、group_id、workflow_name 与 metadata

四个字段各有分工，混用会让追踪查询变得很难写：

| 字段 | 粒度 | 典型用途 |
| --- | --- | --- |
| `workflow_name` | 业务类型 | “客服分诊”“财报抽取”，用于聚合看板 |
| `trace_id` | 一次运行 | 与日志、工单号对齐，用于精确定位 |
| `group_id` | 一段会话 | 聊天线程 ID，把多轮 trace 串起来 |
| `metadata` | 任意键值 | 租户 ID、模型档位、灰度分组等自定义维度 |

`RunConfig` 上四个都能设；`trace()` 也接受同名参数：

```python
from agents import RunConfig, gen_trace_id, trace

run_config = RunConfig(
    workflow_name="Customer support triage",
    trace_id=gen_trace_id(),
    group_id="chat_thread_8821",
    trace_metadata={"tenant": "acme", "plan": "pro"},
)

with trace("Refund investigation", group_id="chat_thread_8821", metadata={"ticket": "T-4417"}):
    pass
```

两个实践建议。第一，`trace_id` 只在需要与外部系统对齐时才手动指定；否则让 SDK 生成，避免撞 ID。第二，`group_id` 用**业务主键**（会话 ID、工单 ID），不要用随机值——它存在的唯一意义就是让你能按会话查。

## 22.5 自定义 span：把业务节点接进树里

默认 span 只覆盖 SDK 自己的边界。你的库存校验、风控打分、向量检索都在这些边界之外，需要自己加节点：

```python
from agents import custom_span, trace


async def answer_with_retrieval(agent, question: str) -> str:
    with trace("RAG answer"):
        with custom_span("retrieve", data={"index": "docs_v3", "top_k": 5}) as span:
            chunks = await vector_store.search(question, top_k=5)
            span.span_data.data["hit_count"] = len(chunks)
        with custom_span("rerank") as rerank_span:
            try:
                chunks = await reranker.rerank(question, chunks)
            except Exception as exc:
                rerank_span.set_error({"message": str(exc), "data": {"stage": "rerank"}})
                raise
        return await agent_run(agent, question, chunks)
```
四个关键点：`with custom_span(...)` 会自动 start 与 finish；`span.span_data.data` 是可写的字典，适合在操作结束后补结果；`span.set_error({...})` 接受的正是 `SpanError` 结构（`message` 加 `data`），不调用它异常也会被记录，但错误分类会缺失；`custom_span` 只在 trace 内有效，没有当前 trace 时它就是个空操作，不会报错。

如果你只想让某个节点在调试期出现，`custom_span(..., disabled=True)` 会让它照常返回对象但不写入后端——压测时避免把压测流量灌进追踪库很有用。同理，`trace(..., disabled=True)` 返回的是一个 no-op trace：代码结构不变，记录为零。

## 22.6 TracingProcessor：把数据接到别处

tracing 的高层结构是：全局 `TraceProvider` 创建 trace 与 span，交给一串 `TracingProcessor`，默认的那个是 `BatchTraceProcessor`，它把数据成批塞给 `BackendSpanExporter`（默认发往 OpenAI 的 traces ingest 端点）。

`TracingProcessor` 是五个方法的抽象类：`on_trace_start`、`on_trace_end`、`on_span_start`、`on_span_end`、`shutdown`，外加 `force_flush`。约束写在基类注释里：方法要线程安全、要快、要自己吞掉异常——因为处理器的失败不该毁掉 Agent 运行。

两个注册函数语义完全不同，这是最常被搞错的地方：

| 函数 | 效果 |
| --- | --- |
| `add_trace_processor(p)` | **追加**，默认的 OpenAI 导出器仍在 |
| `set_trace_processors([p])` | **替换**，不包含默认导出器就不再上报 OpenAI |

下面这个处理器只做一件事：按 trace 汇总 span 类型，在一次运行结束时打印。

```python
from collections import Counter
from typing import Any

from agents import Span, Trace, add_trace_processor
from agents.tracing import TracingProcessor


class SpanCounter(TracingProcessor):
    def __init__(self) -> None:
        self._counts: dict[str, Counter[str]] = {}

    def on_trace_start(self, trace: Trace) -> None:
        self._counts[trace.trace_id] = Counter()

    def on_trace_end(self, trace: Trace) -> None:
        counts = self._counts.pop(trace.trace_id, Counter())
        print(f"[trace {trace.trace_id}] {dict(counts)}")

    def on_span_start(self, span: Span[Any]) -> None:
        counts = self._counts.get(span.trace_id)
        if counts is not None:
            counts[span.span_data.type] += 1

    def on_span_end(self, span: Span[Any]) -> None:
        return None

    def shutdown(self) -> None:
        self._counts.clear()

    def force_flush(self) -> None:
        return None


add_trace_processor(SpanCounter())
```

预期输出形如 `[trace trace_9f2...] {'task': 1, 'turn': 3, 'agent': 3, 'generation': 3, 'function': 2}`。

如果你要自己写导出器，实现的不是 `TracingProcessor` 而是 `TracingExporter.export(items)`；然后包一层批量处理器：

```python
from typing import Any

from agents import Span, Trace, set_trace_processors
from agents.tracing.processor_interface import TracingExporter
from agents.tracing.processors import BatchTraceProcessor


class JsonlExporter(TracingExporter):
    def __init__(self, path: str) -> None:
        self._path = path

    def export(self, items: list[Trace | Span[Any]]) -> None:
        with open(self._path, "a", encoding="utf-8") as fh:
            for item in items:
                payload = item.export()
                if payload is not None:
                    fh.write(str(payload) + "\n")


processor = BatchTraceProcessor(JsonlExporter("traces.jsonl"))
set_trace_processors([processor])
```

`BatchTraceProcessor` 有四个可调参数，理解它们才能调好延迟与内存的平衡：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `max_queue_size` | 8192 | 队列上限，满了会**丢弃**新数据并打 warning |
| `max_batch_size` | 128 | 单批导出条数 |
| `schedule_delay` | 5.0 | 后台线程检查间隔（秒） |
| `export_trigger_ratio` | 0.7 | 队列占用超过该比例就立刻导出一批 |

后台线程只在第一次有数据入队时启动。进程退出时会做一次最终 flush；但在 Celery、RQ、FastAPI 后台任务里，你可能希望“任务结束就立刻可见”，这时显式调用 `flush_traces()`，并且把它放在 `trace()` 块之外——放在里面会把半成品刷出去。

> 提示：替换处理器要用 `set_trace_processors()`，不是 `add_trace_processor()`。用后者时默认的 OpenAI 导出器还在，你以为“只发到自己的系统”，实际上还发了一份到 OpenAI。

## 22.7 接到第三方系统

生态集成的做法有两种，取决于对方提供什么：

1. **对方提供 TracingProcessor**（Logfire、AgentOps、Braintrust、Weights & Biases、Langfuse、LangSmith 等）：按它们的文档注册，通常一行 `set_trace_processors([...])` 或它们自己的 instrument 函数。
2. **对方只接受 OTel/自定义格式**：自己写 `TracingExporter`，把 `item.export()` 得到的字典转换后发出去。这是最可控的路径，也是唯一能保证脱敏与投递在同一处的路径。

文档的“Redaction before export”一节把这件事说得很重：**处理器是独立观察者**，一个处理器做脱敏、另一个导出，并不能保证导出方拿到的是脱敏后的数据。要做脱敏，必须让脱敏与投递在**同一个 exporter 内**完成，并用 `set_trace_processors()` 替掉默认链路。`repo/examples/basic/trace_redaction.py` 正是这个模式的完整实现：它只保留 `object`、`id`、`trace_id`、`parent_id` 四个字段，本地打印，不发任何网络请求。

## 22.8 排障：trace 没了、太长、太脏

**trace 完全没出现。** 按这个顺序查：一是是否设了 `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA` 之外的开关导致 disabled；二是 `RunConfig(tracing_disabled=True)` 是否在某处写死；三是组织是否处于 ZDR；四是不是根本没有 OpenAI key——默认导出器要往 OpenAI 传，没 key 会 401。接非 OpenAI 模型时，最常见的组合是“关掉 tracing”或“用 `set_tracing_export_api_key()` 单独给追踪配一个 OpenAI key”。

**trace 太长或太大。** 三层收缩：关掉 task/turn span（`RunConfig(tracing={"include_task_and_turn_spans": False})`）；关掉敏感数据（字段载荷是体积大头）；在自建导出器里截断长文本。默认后端对单字段有 100000 字节上限，超出会截断并加后缀——这意味着**超长工具输出在追踪里不是原文**，别拿它当证据做精确比对。

**trace 里出现不该出现的敏感数据。** 先确认 `trace_include_sensitive_data` 的实际取值（环境变量与代码两处都可能设）；再确认有没有别的处理器在旁路导出；最后检查 `metadata`——很多人把自己塞进 metadata 的用户信息忘了，而 metadata 不受该开关保护。

**trace 延迟很久才出现。** 这是 `BatchTraceProcessor` 的正常行为（默认 5 秒一批）。要即时可见就在业务单元结束时调 `flush_traces()`。

**trace 与日志对不上。** 把 `trace.trace_id` 打进自己的日志（`trace()` 返回的对象上有 `trace_id`，`RunResult.trace` 也有），用同一个 ID 关联两侧。这比按时间戳猜准确得多。

## 常见坑与排查

1. **症状**：导入了 `custom_span` 却发现追踪系统里完全没有这个节点。
   **原因**：没有当前 trace（既没 `with trace(...)`，这次 run 也不是在 trace 内），此时 span 是空操作；或 `trace_include_sensitive_data=False` 后又去找 `data` 内容。
   **修法**：用一个 `with trace("业务名")` 包住；排查时先确认 trace 是否存在。

2. **症状**：换了 `set_trace_processors([my_processor])` 之后仍然在 OpenAI 后台看到 trace。
   **原因**：多半用的是 `add_trace_processor()`；也有可能是替换发生得太晚，旧的处理器已经缓冲了数据。
   **修法**：在创建任何 trace 之前完成替换；替换不会清空已缓冲数据。

3. **症状**：并发多个 run 时，span 挂到了别人的 trace 上。
   **原因**：手动 `start()`/`finish()` 却没有正确传 `mark_as_current` 与 `reset_current`，破坏了 contextvar 的栈。
   **修法**：优先用 `with trace(...)` 与 `with custom_span(...)`；确需手动控制时严格成对传参。

4. **症状**：span 数量爆炸，追踪后端额度一天用完。
   **原因**：每个 turn 都有 task/turn/agent 三层，加上每次工具调用的 function span；长跑任务会把层级放大。
   **修法**：关掉 task/turn span；对非关键的 `custom_span` 用 `disabled=True`；批处理场景用 `tracing_disabled=True` 单次关闭。

5. **症状**：`trace_id` 对不上，工单里给的 ID 在后台查不到。
   **原因**：`trace_id` 格式必须是 `trace_` 加 32 位字母数字，手写容易不合法；或者手写了一个但那次运行没进 trace。
   **修法**：用 `gen_trace_id()` 生成；把 trace ID 与业务主键一起落库。

## 动手练习

1. **数一遍 span**：写一个带一个工具、一个 handoff 的最小 workflow，用 22.6 的 `SpanCounter` 打印 span 计数，对照 22.2 的树检查每一项是否都能解释。
2. **做一次脱敏导出**：仿照 `repo/examples/basic/trace_redaction.py`，写一个只保留 `object`/`id`/`trace_id`/`parent_id` 的 exporter，并用 `set_trace_processors()` 替换默认链路，确认不再有网络上报。
3. **改造示例**：打开 `repo/examples/basic/agent_lifecycle_example.py`，在 `on_tool_start` 与 `on_tool_end` 之间插入一个 `custom_span("validate_input")`，把工具名与参数长度写进 `data`，观察它挂在哪个父 span 下。

## 本章小结

- tracing 默认开启，三种关闭方式粒度不同；环境变量只读一次，`set_tracing_disabled()` 优先级最高。
- 默认 span 树是 trace → task → turn → agent → generation/function/handoff/guardrail。
- `trace_include_sensitive_data=False` 会剔除 generation 与 function 的载荷，但 span 结构仍在。
- `workflow_name` 做聚合、`trace_id` 做精确定位、`group_id` 做会话串联、`metadata` 放自定义维度。
- `custom_span(name, data)` 是业务节点的入口；`span.set_error()` 补错误分类。
- `add_trace_processor` 追加、`set_trace_processors` 替换；脱敏与投递必须同处一个 exporter。
- `BatchTraceProcessor` 默认 5 秒一批、队列满会丢数据；`flush_traces()` 用于即时可见。
- 排障先分三类：没出现（开关/key/ZDR）、太长（层级与载荷）、太脏（敏感数据与 metadata）。

## 延伸阅读

- 追踪总览：`repo/docs/tracing.md`
- 全局默认：`repo/docs/config.md`
- 源码：`repo/src/agents/tracing/create.py`、`repo/src/agents/tracing/provider.py`、`repo/src/agents/tracing/processors.py`、`repo/src/agents/tracing/processor_interface.py`
- 示例：`repo/examples/basic/trace_redaction.py`、`repo/examples/basic/agent_lifecycle_example.py`
- 参考文档：`repo/docs/ref/tracing/create.md`、`repo/docs/ref/tracing/processors.md`
- 下一章：《第23章 测试与Evals评估》——把线上证据变成上线前的闸门。
