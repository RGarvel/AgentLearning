# 第4章 Runner与运行循环

上一章我们把 `Agent` 拆成了字段，也说过它"几乎不做任何事，只负责声明"。那么谁让声明动起来？答案是 `Runner`。本章要回答的问题是：**当你写下 `await Runner.run(agent, "……")` 的那一毫秒之后，到 `final_output` 出现之前，到底发生了什么。** 把这段搞明白，你就能解释大多数"它为什么又调了一次""它怎么突然结束了"。

---

## 学习目标

- 能默写 `Runner.run` / `run_sync` / `run_streamed` 的签名差异，特别是哪些参数是 keyword-only。
- 能描述一次 turn 内部的六个步骤，并说出每一步在 `run_internal/` 的哪个环节。
- 能解释"最终输出"的唯一判定规则，并用它预测循环会在第几轮停止。
- 能说清 `max_turns` 的计数语义、默认值，以及 `MaxTurnsExceeded` 的处理方式。
- 能说明 handoff 如何改变后续 turn 的执行者，以及它为什么不会改变入口 Agent 的身份。
- 能把 `RunConfig` 当作"整轮运行的全局覆盖层"使用，并知道 `RunState` 是恢复入口。

---

## 一、三个入口与完整签名

三个方法的签名（`repo/src/agents/run.py`）：

```python
class Runner:
    @classmethod
    async def run(
        cls,
        starting_agent: Agent[TContext],
        input: str | list[TResponseInputItem] | RunState[TContext],
        *,
        context: TContext | None = None,
        max_turns: int | None = DEFAULT_MAX_TURNS,      # 默认 10
        hooks: RunHooks[TContext] | None = None,
        run_config: RunConfig | dict[str, Any] | None = None,
        error_handlers: RunErrorHandlers[TContext] | None = None,
        previous_response_id: str | None = None,
        auto_previous_response_id: bool = False,
        conversation_id: str | None = None,
        session: Session | None = None,
    ) -> RunResult: ...
```

`run_sync` 的参数与 `run` 完全一致，只是把 `async` 换成同步返回。它的 docstring 明确了一句很重要的话：**它只是 `run` 的包装，如果当前已经有事件循环（在 async 函数里、Jupyter 里、FastAPI 请求里），它不能工作**——那种场合请直接用 `run`。

`run_streamed` 有两个必须记住的差异：

```python
    @classmethod
    def run_streamed(
        cls,
        starting_agent: Agent[TContext],
        input: str | list[TResponseInputItem] | RunState[TContext],
        context: TContext | None = None,        # 注意：不是 keyword-only
        max_turns: int | None = DEFAULT_MAX_TURNS,
        hooks: RunHooks[TContext] | None = None,
        run_config: RunConfig | dict[str, Any] | None = None,
        previous_response_id: str | None = None,
        auto_previous_response_id: bool = False,
        conversation_id: str | None = None,
        session: Session | None = None,
        *,
        error_handlers: RunErrorHandlers[TContext] | None = None,   # 只有这个在 * 之后
    ) -> RunResultStreaming: ...
```

1. 它**不是 `async def`**：调用后立即返回一个 `RunResultStreaming`，真正的执行在后台任务里跑。
2. 除 `error_handlers` 外，其余参数都是位置或关键字皆可。这一点和 `run` 不同，写代码时建议一律用关键字，避免日后签名变化带来的静默错位。

> 提示：`run_streamed` 返回的对象在你开始迭代 `stream_events()` 之前并不"完成"。`final_output` 在流结束前一直是 `None`（第 21 章）。

---

## 二、input 的三种形态

| 形态 | 含义 | 典型场景 |
| --- | --- | --- |
| `str` | 一条用户消息 | 单轮提问、聊天入口 |
| `list[TResponseInputItem]` | 完整的 Responses 输入项列表 | `result.to_input_list()` 续聊、手工拼历史 |
| `RunState` | 一个可恢复的运行快照 | 审批中断后恢复、`cancel(after_turn)` 后继续 |

三种形态通向同一个循环，区别只在"模型输入从哪来"。第三种形态很重要：它意味着**同一个入口既能开新 run，也能续旧 run**，你不需要学两套 API（第八节）。

输入不只由 `input` 决定，四个与"状态归属"有关的参数同样在参与：

| 参数 | 谁托管历史 | 下一次该传什么 |
| --- | --- | --- |
| `session=...` | 你的存储（SDK 负责读写） | 同一个 session 实例 + 只传新用户消息 |
| `conversation_id=...` | OpenAI Conversations API | 同一个 id + 只传新用户消息 |
| `previous_response_id=...` | OpenAI Responses API | `result.last_response_id` + 只传新用户消息 |
| `auto_previous_response_id=True` | 同上，但第一轮就自动开启链式 | 与 `previous_response_id` 配合使用 |

这四者与 `input` 的关系是"互斥优先"而不是"叠加"：选了服务端托管，就只传增量；自己拼 `to_input_list()`，就别再传 id。混用会得到重复的历史（第 18 章有完整决策表）。

---

## 三、一次 turn 内部发生了什么

官方 docstring 把循环浓缩成四句，我把它展开成六步，并标注源码位置：

```text
turn 开始
 ├─ [0] 前置：输入护栏并行启动；把会话历史/上次响应并入模型输入
 │       （run_internal/run_loop.py，admit_pending_input、prepare 阶段）
 ├─ [1] current_turn += 1，检查是否超过 max_turns
 │       （run_loop.py：current_turn += 1 → current_turn > max_turns 就抛）
 ├─ [2] 调用模型（一次 LLM 调用）
 ├─ [3] 处理模型输出：
 │       ├─ 有工具调用 → 逐个执行 → 结果作为新消息回填 → 回到 [1]
 │       ├─ 有 handoff 调用 → 切换当前 Agent → 回到 [1]
 │       └─ 既无工具调用又无可交接项 → 判定为最终输出
 ├─ [4] 输出护栏（若有）
 ├─ [5] on_agent_end / 写会话 / 发事件
 └─ turn 结束 → 返回 RunResult
```

几个容易忽略的细节，全部能在源码里对上：

- **turn 的计数发生在模型调用之前**，而且"一次 turn"包含这次模型调用**以及它引发的所有工具调用**。所以"调了 3 次模型"通常等于"3 个 turn"，但如果某轮里模型一次发了 5 个工具调用，那仍是 1 个 turn。
- **工具在同一个 turn 里是并发执行的**（默认不限制并发度），顺序不保证；想限制用 `RunConfig(tool_execution=ToolExecutionConfig(max_function_tool_concurrency=2))`。
- **一个响应里出现多个 handoff 时，只有第一个生效**，其余会被写成一条 `ToolCallOutputItem`，内容是 `"Multiple handoffs detected, ignoring this one."`（`run_internal/turn_resolution.py`）。
- **工具失败不一定会中断 run**。默认 `failure_error_function` 会把异常替换成一句固定文案回填给模型，于是模型有机会"换个办法"——这也是"轮次被烧掉"的常见原因。
- **钩子的触发顺序是固定的**：`on_agent_start` → `on_llm_start` → `on_llm_end` → `on_tool_start`/`on_tool_end`（每个工具一次）→ `on_agent_end`；发生交接时多一次 `on_handoff`。`RunHooks` 观察整条 run，`AgentHooks` 只观察绑定它的那个 Agent，两者可以同时使用。

---

## 四、什么时候停：唯一判定规则

官方把规则写在 `repo/docs/running_agents.md`，一句话：

> 模型产出**期望类型的文本**，且**没有工具调用**，才算最终输出。

拆开看有三个条件：

| 条件 | 含义 | 违反时 |
| --- | --- | --- |
| 是"文本"型输出 | 一条 message，而不是工具调用/推理项 | 继续循环 |
| 类型符合 `output_type` | 没设 `output_type` 时就是 `str`；设了就是结构化对象 | 校验失败按 `ModelBehaviorError` 处理，可用 `error_handlers["invalid_final_output"]` 兜底 |
| 没有工具调用 | 这一轮不包含任何待执行的工具/交接 | 执行工具后继续 |

所以"它为什么又调了一次"的答案通常是：这一轮里还有工具调用没处理完，或者模型只发了推理项没发文本。

还有两条"提前结束"的旁路，不属于正常判定：

- `tool_use_behavior` 把某个工具的输出直接当最终答案（第 3 章）；
- 触发 tripwire（护栏）或抛出异常，run 以异常结束。

---

## 五、max_turns 与 MaxTurnsExceeded

`max_turns` 默认值是 `DEFAULT_MAX_TURNS = 10`（`repo/src/agents/run_config.py`），判断条件是 `current_turn > max_turns`：

```python
import asyncio

from agents import Agent, MaxTurnsExceeded, Runner


agent = Agent(name="资料整理员", instructions="分步整理资料。")


async def main() -> None:
    try:
        result = await Runner.run(agent, "把这份 200 页的文档整理成提纲", max_turns=3)
        print(result.final_output)
    except MaxTurnsExceeded as exc:
        print(f"没跑完：{exc}")   # 预期输出：没跑完：Max turns (3) exceeded


asyncio.run(main())
```

这段要验证的是：**轮次上限是硬约束，超了就是异常，不是"返回半成品"**。

- 设 `max_turns=None` 可以彻底关闭上限——只在你能确定循环一定收敛时使用。
- 异常信息里只有 `Max turns (N) exceeded`，**不包含任何输入输出**。想知道停在哪一步，去看 `result`？没有 result；要看 trace（第 22 章）。
- 如果不想抛异常，用 `error_handlers={"max_turns": ...}` 返回一个受控的兜底输出：

```python
from agents import Agent, RunErrorHandlerInput, RunErrorHandlerResult, Runner


def on_max_turns(_data: RunErrorHandlerInput[None]) -> RunErrorHandlerResult:
    return RunErrorHandlerResult(
        final_output="超出轮次上限，请把需求拆小一点。",
        include_in_history=False,   # 不把兜底文案写进历史
    )


result = Runner.run_sync(
    agent,
    "把这份 200 页的文档整理成提纲",
    max_turns=3,
    error_handlers={"max_turns": on_max_turns},
)
print(result.final_output)
```

`error_handlers` 支持三个键：`"max_turns"`、`"model_refusal"`、`"invalid_final_output"`。三者的共同点是"把异常变成一次可交付的输出"，区别在触发条件。注意 `include_in_history` 默认是 `True`——兜底文案默认会被写进历史并持久化到 session，多数场景你希望它是 `False`。

---

## 六、handoff 如何改变"当前 Agent"

交接不是"调用一个子 Agent 再回来"，而是**控制权转移**。源码里它的落地方式是切换循环里的当前 Agent，然后回到 turn 开头：

```text
[2] 模型输出 handoff 调用（transfer_to_refund_agent）
        │
        ▼
[3] 执行交接：new_agent = handoff.on_invoke_handoff(...)
        │  ├─ 追加 HandoffOutputItem(agent=原 Agent, source_agent=原, target_agent=新)
        │  ├─ 触发 on_handoff 钩子（RunHooks 与 AgentHooks 都会收到）
        │  └─ 按 handoff_input_filter / nest_handoff_history 重写模型输入
        ▼
[1] 回到循环开头，但 current_agent 已变成 new_agent
```

要点：

- **变的是 `current_agent`，不是 `starting_agent`**。`RunResult.last_agent` 记录的是最后实际执行的那个 Agent；而 `to_state()` 里保存的 `starting_agent` 仍是"根图"，用于恢复时重建 Agent 图（`repo/src/agents/result.py` 的 `_starting_agent_for_state`）。
- **新 Agent 继承的是"输入"，不是"记忆"**。它看到的是经过过滤器重写后的历史；默认是原样转发，开启 `nest_handoff_history=True` 才会压缩成摘要段。
- **交接后的 Agent 只跑自己的 `output_guardrails`**，输入护栏不会重跑（第 3 章）。
- **交接也是"一次工具调用"**：模型必须在响应里发出对应函数调用，所以它同样占轮次、同样受 `max_turns` 约束。

---

## 七、RunConfig：整轮运行的全局覆盖层

`RunConfig` 是"这一次 run 的全局设置"，优先级高于 Agent 上的同名字段。两个关键解析规则（`run_internal/turn_preparation.py`）：

- **模型**：`run_config.model` 是 `Model` 实例就直接用；是字符串就用 `model_provider` 解析；都没设才用 `agent.model`。
- **模型参数**：`agent.model_settings.resolve(prepared_overrides).resolve(run_config.model_settings)`——**RunConfig 是最后一层覆盖**，非 `None` 的字段逐个盖上去。

```python
from agents import ModelSettings, RunConfig, Runner


result = await Runner.run(
    agent,
    "把这份 200 页的文档整理成提纲",
    run_config=RunConfig(
        model="gpt-5-nano",                       # 全局换模型，不改 Agent
        model_settings=ModelSettings(temperature=0.0),
        workflow_name="资料整理",                  # trace 里的工作流名
        trace_include_sensitive_data=False,        # 不把输入输出写进 trace
    ),
)
```

按用途把常用字段分四组（全部来自 `repo/src/agents/run_config.py`）：

| 组 | 字段 | 用途 |
| --- | --- | --- |
| 模型与状态 | `model`、`model_provider`、`model_settings`、`session_settings`、`session_input_callback` | 换模型、统一温度、控制历史检索 |
| 输入整形 | `handoff_input_filter`、`nest_handoff_history`、`handoff_history_mapper`、`call_model_input_filter`、`reasoning_item_id_policy` | 交接裁剪、调用前裁历史/注入提示 |
| 安全 | `input_guardrails`、`output_guardrails`、`output_guardrail_blocked_message` | 给所有 run 统一加护栏 |
| 观测与工具 | `tracing_disabled`、`trace_include_sensitive_data`、`workflow_name`、`group_id`、`trace_metadata`、`tool_execution`、`tool_not_found_behavior`、`tool_name_collision_policy`、`tool_error_formatter` | 追踪归属、工具并发与错误文案 |

`RunConfig` 的真正价值，是让**同一批 Agent 服务多种运行**：按租户换模型、按灰度换参数、按环境关掉追踪、测试时把 `model` 换成 `agents.testing.ScriptedModel`（它是 `Model` 的子类，因此可以直接塞进 `run_config.model`，第 23 章）。如果这些差异写在 Agent 上，你就得为每种组合各造一个 Agent；写在 `RunConfig` 上，Agent 保持一份干净的声明。

> 注意：`session` 与 `conversation_id` / `previous_response_id` / `auto_previous_response_id` **不能在同一次 run 里混用**。前者是客户端托管历史，后者是服务端托管，混用会造成历史重复（第 17、18 章）。

---

## 八、以 RunState 为输入的恢复入口

当一次 run 因为"需要人工审批"而暂停时，`result.interruptions` 会非空，此时 `final_output` 可能是 `None`。恢复流程只有三步：

```python
from agents import Agent, Runner

agent = Agent(name="运维助手", instructions="按需执行命令。")

result = await Runner.run(agent, "清理临时文件")

if result.interruptions:
    state = result.to_state()
    for item in result.interruptions:
        state.approve(item)          # 或 state.reject(item, rejection_message="...")
    result = await Runner.run(agent, state)   # 注意第二个参数是 state
```

要点只有一句：**恢复时传 `RunState` 而不是原始输入**，`starting_agent` 仍然要传（它是用来重建 Agent 图的）。`RunState` 还支持 `add_input("补充一句")` 在恢复前追加用户输入、`to_json()` / `from_string()` 做持久化。

这一段故意只讲"入口"。审批语义、嵌套审批、会话写失败的恢复、`RunState` 的不可恢复标记等边界，全部留给第 16 章——那是本课程里最容易写出事故的一章，不要跳。

---

## 常见坑与排查

1. **症状**：在 FastAPI 或 Jupyter 里调用 `Runner.run_sync`，报"event loop is already running"。
   **原因**：`run_sync` 只是 `run` 的包装，内部要新建事件循环。
   **修法**：在异步上下文里一律用 `await Runner.run(...)`。

2. **症状**：设了 `max_turns=5`，`raw_responses` 恰好 5 条，却报"Max turns (5) exceeded"，看起来像多跑了一轮。
   **原因**：循环是"先自增、再比较"，第 6 轮在**调用模型之前**就被拦下。异常里的数字是"被拒绝的那一轮"，不是实际调用次数。
   **修法**：把 `max_turns` 理解为"最多允许几次模型调用"，并用 `len(result.raw_responses)` 交叉验证。

3. **症状**：以为 handoff 之后 `result.last_agent` 还是入口 Agent。
   **原因**：`last_agent` 是"最后实际执行者"，交接后会变。
   **修法**：要判断是否发生过交接，遍历 `result.new_items` 找 `HandoffOutputItem`（第 5 章）。

4. **症状**：同一次 run 里同时传了 `session=...` 和 `previous_response_id=...`，历史出现重复。
   **原因**：客户端托管与服务端托管两套历史被同时启用。
   **修法**：一次 run 只选一种记忆策略，见第 18 章的决策表。

5. **症状**：`run_streamed` 之后立刻读 `result.final_output`，得到 `None`。
   **原因**：流还没被消费完，run 尚未终结。
   **修法**：先 `async for` 消费完 `stream_events()`，再读结果字段。

6. **症状**：模型一直重复调同一个工具，直到 `MaxTurnsExceeded`。
   **原因**：设了 `tool_choice` 强制调用且没让 SDK 复位，或工具总是失败返回同一句错误。
   **修法**：确认 `reset_tool_choice=True`（默认），并检查工具失败原因（第 7 章）。

---

## 动手练习

1. **数轮次**：给一个 Agent 配两个工具，问一个必须连续用两次工具的问题，运行后打印 `len(result.raw_responses)`，与 `max_turns` 对比。你能解释这个数字吗？
2. **制造超限**：把 `max_turns` 设成 1，观察 `MaxTurnsExceeded` 的消息内容；再用 `error_handlers` 把它变成受控输出，确认 `include_in_history` 两种取值的差别（用 `result.new_items` 验证）。
3. **改仓库示例**：打开 `repo/examples/agent_patterns/routing.py`，给它加 `max_turns=2` 与 `RunConfig(workflow_name="分诊实验")`，跑一遍并解释：为什么在只有一次交接的场景里，2 已经接近下限？

---

## 本章小结

- 三个入口：`run`（async）、`run_sync`（同步包装，不能在已有事件循环里用）、`run_streamed`（立即返回流对象，仅 `error_handlers` 是 keyword-only）。
- `input` 三形态：字符串、输入项列表、`RunState`。
- 一个 turn = 一次模型调用 + 它引发的所有工具执行；turn 计数在模型调用前自增。
- 停止规则唯一：期望类型的文本 + 无工具调用；其余情况继续循环。
- `max_turns` 默认 10，超过即抛 `MaxTurnsExceeded`；用 `error_handlers` 可转成受控输出。
- handoff 改变的是 `current_agent`，不是 `starting_agent`；多 handoff 只取第一个。
- `RunConfig` 是全局覆盖层：模型优先于 Agent，model_settings 最后叠加。
- 恢复入口是 `Runner.run(agent, state)`；细节见第 16 章。

---

## 延伸阅读

- 官方循环与 `RunConfig` 全量说明：`repo/docs/running_agents.md`
- 源码：`repo/src/agents/run.py`（三个入口的 docstring）、`repo/src/agents/run_internal/run_loop.py`（`current_turn` 与 `max_turns` 判定）、`repo/src/agents/run_internal/turn_resolution.py`（交接与最终输出）
- 默认轮次常量：`repo/src/agents/run_config.py`（`DEFAULT_MAX_TURNS = 10`）
- 示例：`repo/examples/agent_patterns/routing.py`、`repo/examples/basic/stream_text.py`
- 下一章讲这台机器的产物：`RunResult` 与 `RunItem`。
