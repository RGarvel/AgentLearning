# 第17章 Session：会话记忆

上一章的 `RunState` 解决的是"一次运行被暂停后怎么接着跑"，它用完即弃。但日常产品里更常见的需求是另一件事：用户今天问了三个问题，明天回来接着问第四个，Agent 得记得前三个。如果每轮都自己维护列表、手动拼 `result.to_input_list()`，代码很快就会变成一团历史管理逻辑。这一章我们看 SDK 给出的答案——会话（Session）：一套只有四个方法的接口，和围绕它的一整条实现光谱。

## 学习目标

- 能写出符合 `Session` 协议的自定义存储，并说清四个方法各自何时被运行器调用
- 能区分 `SQLiteSession` 的内存模式与文件模式，并说明各自的适用边界
- 能配置 `SessionSettings.limit`、`RunConfig.session_settings`、`session_input_callback`，控制"读多少、怎么合并"
- 能为多用户场景设计 `session_id`，并判断什么时候该换 Redis / SQLAlchemy / MongoDB
- 能用 `OpenAIConversationsSession` 与 `OpenAIResponsesCompactionSession` 处理服务端存储与长对话压缩

## 四个方法：Session 的全部契约

`Session` 在源码里是一个 `Protocol`，只要求两件事：一个 `session_id` 属性，和四个异步方法。

```python
from typing import Any

from agents import RunContextWrapper
from agents.items import TResponseInputItem


class TicketSession:
    """按工单维度保存对话历史。"""

    session_settings = None

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._items: list[TResponseInputItem] = []

    async def get_items(self, limit: int | None = None) -> list[TResponseInputItem]:
        if limit is None:
            return list(self._items)
        if limit <= 0:
            return []
        return list(self._items[-limit:])

    async def add_items(self, items: list[TResponseInputItem]) -> None:
        self._items.extend(items)

    async def pop_item(self) -> TResponseInputItem | None:
        return self._items.pop() if self._items else None

    async def clear_session(self) -> None:
        self._items.clear()
```

四个方法的分工：

| 方法 | 谁调用、什么时候 | 语义要点 |
| --- | --- | --- |
| `get_items(limit)` | 每轮开始前，运行器读取历史 | `limit` 为 `None` 取全量；为正数取**最近 N 条**且保持时间顺序；`<=0` 应返回空列表 |
| `add_items(items)` | 每轮结束后（以及若干中间点），写入新产生的 item | 只写"本轮新增"，不要重写整段历史 |
| `pop_item()` | 应用主动调用（撤销最后一轮） | 返回被移除的 item，空会话返回 `None` |
| `clear_session()` | 应用主动调用（重置会话） | 清空该 `session_id` 的全部历史 |

不需要继承 `SessionABC`——那是给内置实现和需要抽象基类的库作者用的；第三方只要**结构上**满足协议即可。这也是为什么你可以把一个已有的业务仓储类改造成 Session，而不引入 SDK 的继承层级。

一个容易被忽略的进阶能力：如果四个方法都声明了关键字参数 `wrapper: RunContextWrapper[Any] | None = None`，SDK 会在调用时把当前运行上下文传进来。四个方法必须**全部**声明（`**kwargs` 不算），否则整套退回旧签名。用它来做多租户路由、按用户分库非常自然。

> 注意：别在 Session 里做"业务逻辑"。它的职责是存取历史 item，不是判断用户权限。授权应该发生在进入运行器之前。

## SQLiteSession：一行代码就能跑起来

`agents.memory` 里，本地存储的内置实现只有一个（另外两个分别面向服务端会话与压缩包装），但它足够应付开发与中小规模生产：

```python
from agents import SQLiteSession

dev_session = SQLiteSession("user_123")                      # 内存库，进程结束即丢
prod_session = SQLiteSession("user_123", "conversations.db") # 文件库，可跨进程
```

构造签名是 `SQLiteSession(session_id, db_path=":memory:", sessions_table="agent_sessions", messages_table="agent_messages", session_settings=None)`。两种模式的差别不只是"持久化"：

| 维度 | `db_path=":memory:"`（默认） | 文件路径 |
| --- | --- | --- |
| 生命周期 | 随进程消亡 | 跨进程、跨重启 |
| 连接策略 | 单条共享连接（避免线程隔离丢数据） | 每线程独立连接 |
| 并发控制 | 一把 `RLock` | 按数据库文件路径共享的进程内 `RLock` |
| 适用 | 单元测试、单次演示、临时会话 | 单机服务、桌面应用、原型 |

关于并发必须讲清楚：文件模式的锁是**进程内**的（按解析后的绝对路径共用一把可重入锁），它保证同一进程里多个 Session 实例写同一个文件不会互相踩，但**不提供跨进程互斥**。多进程/多 worker 部署时，要么让每个 `session_id` 落在不同文件，要么换 Redis / SQLAlchemy / MongoDB 这类真正的共享存储。

还有一条安全边界要写进架构文档：`SQLiteSession` **信任**它读到的数据库。它不校验行是否被外部篡改、删除、重排或重放；`session_id` 只用于"选出哪段历史"，不承担"认证用户"的职责。所以数据库文件、所在目录、备份的访问权限，以及"谁能用哪个 session_id"，都必须由你的应用控制。需要防篡改或加密，用后面提到的 `EncryptedSession` 或自建实现。

## 合并语义：历史和新输入怎么拼

运行器每轮的模型输入是这样构成的：

1. 取 `session.get_items(limit)` 得到历史；
2. 拼上本轮的新输入；
3. （可选）交给 `RunConfig.session_input_callback` 做最后加工；
4. （可选）再交给 `RunConfig.call_model_input_filter` 做模型调用前加工。

`session_input_callback` 的签名是 `(history, new_input) -> list`，两个参数都是**副本**，可以放心改；返回什么，模型就看到什么。关键是：**这一步只影响本轮模型输入，不影响写回**。SDK 依然只持久化"属于本轮新增"的 item，所以你裁剪、重排旧历史，不会把旧 item 当成新输入再存一遍。

```python
from agents import Agent, RunConfig, Runner, SessionSettings, SQLiteSession


def keep_recent(history, new_input):
    return history[-10:] + new_input


session = SQLiteSession("user_123", "conversations.db")
agent = Agent(name="客服", instructions="简洁回答。")

result = await Runner.run(
    agent,
    "只根据最近的上下文继续。",
    session=session,
    run_config=RunConfig(
        session_input_callback=keep_recent,
        session_settings=SessionSettings(limit=50),
    ),
)
```

`SessionSettings(limit=N)` 和 `session_input_callback` 是两道不同的闸门：前者限制**从存储里读多少**（省 IO、省反序列化），后者决定**送给模型多少**（省 token）。两者都要设的时候，先 `limit` 再 callback，逻辑最清晰。`RunConfig.session_settings` 会按"非 `None` 字段覆盖"的规则叠加到 Session 自己的 `session_settings` 上，所以你可以给会话设一个默认上限，再在特定请求上临时收紧。

这里补一条 0.25 的硬约束：**同一个运行里，session 不能与 `conversation_id`、`previous_response_id`、`auto_previous_response_id` 同时使用**。前者是客户端托管历史，后者是服务端托管历史，混用会导致上下文重复。

## 并发与多用户：先把 session_id 设计对

`session_id` 不是技术细节，它是你的产品模型。三种常见形态：

| 形态 | 示例 | 适合 |
| --- | --- | --- |
| 用户维度 | `user_12345` | 个人助理、单线程客服 |
| 线程维度 | `thread_abc123` | 多会话并列的聊天产品（每个标签页一个） |
| 业务维度 | `support_ticket_456` | 工单/案件系统，一个工单一段历史 |

三条工程建议：

1. **不要用自增主键裸值**。加前缀（`user_` / `ticket_`）能避免不同业务线的 ID 撞车，也让日志可读。
2. **一个 session 只服务一个逻辑对话**。让两个用户共享一个 `session_id` 是数据泄露，不是"节省存储"。
3. **多 Agent 可共享同一个 session**。分诊 Agent 和退款 Agent 用同一个 `session`，就能看到同一段历史——这正是交接场景想要的效果。

并发方面，同一个 `session_id` 上同时跑两个 `Runner.run` 会造成历史交错。简单做法是在应用层对 `session_id` 加锁（分布式场景用 Redis 锁）。SDK 内部为 `OpenAIResponsesCompactionSession` 这类包装器提供了串行化保证，但普通 Session 不承诺这一点。

## 服务端会话：OpenAIConversationsSession

如果不想自己管存储，可以把历史放到 OpenAI 的 Conversations API：

```python
from agents import Agent, OpenAIConversationsSession, Runner

session = OpenAIConversationsSession()                       # 新建会话
# session = OpenAIConversationsSession(conversation_id="conv_123")  # 续用已有会话

agent = Agent(name="助手", instructions="简洁回答。")
result = await Runner.run(agent, "金门大桥在哪个城市？", session=session)
```

两个实现细节值得知道：

- 构造签名是**全关键字**的：`OpenAIConversationsSession(*, conversation_id=None, openai_client=None, session_settings=None)`。传位置参数会报错。
- 会话是**惰性创建**的：不传 `conversation_id` 时，第一次真正访问远端（如 `get_items()` 或非空 `add_items()`）才会创建会话。在那之前读 `session.session_id` 会抛 `ValueError`。

它适合"多语言、多服务共享同一段历史"的场景，代价是每次读写都要一次网络往返，且历史内容离开你的边界。

## 长对话压缩：OpenAIResponsesCompactionSession

对话越长，每轮重发的历史越多，成本和延迟线性上涨。压缩会话是一个**装饰器**：包住任意 Session，在历史增长到阈值时调用 Responses API 的 `responses.compact` 把前缀折叠掉。

```python
from agents import Agent, Runner, SQLiteSession
from agents.memory import OpenAIResponsesCompactionSession

underlying = SQLiteSession("user_123", "conversations.db")
session = OpenAIResponsesCompactionSession(
    session_id="user_123",
    underlying_session=underlying,
)

agent = Agent(name="助手")
result = await Runner.run(agent, "继续我们上次的话题", session=session)
```

构造签名：`OpenAIResponsesCompactionSession(session_id, underlying_session, *, client=None, model="gpt-6-luna", compaction_mode="auto", should_trigger_compaction=None, max_rollback_items=None)`。

几个必须记住的点：

- **默认阈值是 10**：`should_trigger_compaction` 的默认实现是"候选 item 数 ≥ 10 就压缩"（`DEFAULT_COMPACTION_THRESHOLD`）。候选 item 会排除用户消息和已有的压缩项。
- **不能包装 `OpenAIConversationsSession`**，构造时直接 `ValueError`——两者都在管历史，职责冲突。
- **`compaction_mode`** 有 `"auto"` / `"input"` / `"previous_response_id"` 三种。`"auto"` 在"上一条响应没被存储"或"没有 response_id"时回落到 `input` 模式，所以配合 `ModelSettings(store=False)` 也能工作。
- **自动压缩会阻塞流式输出**：压缩要清空并重写历史，SDK 会等它完成才认为本轮结束。对延迟敏感的产品，关掉自动触发，改用空闲时手动 `await session.run_compaction({"force": True})`。

## 扩展实现清单

生产级后端都在 `agents.extensions.memory` 下，且都是**懒加载**的：没装对应依赖时导入会给出"安装哪个 extra"的明确错误。

| 类 | 导入 | 关键参数 | 适用 |
| --- | --- | --- | --- |
| `AsyncSQLiteSession` | `agents.extensions.memory` | `db_path` | 需要 `aiosqlite` 异步驱动的 SQLite |
| `RedisSession` | 同上 | `from_url(session_id, url=...)`、`ttl` | 多 worker 共享、低延迟 |
| `SQLAlchemySession` | 同上 | `from_url(..., create_tables=True)` 或 `engine=` | 已有 Postgres/MySQL 等 |
| `MongoDBSession` | 同上 | `from_uri(..., uri=..., database=...)`、`ping()` | 文档型存储、水平扩展 |
| `DaprSession` | 同上 | `from_address(..., state_store_name=..., dapr_address=...)`、`consistency`、`ttl` | 云原生 sidecar 架构 |
| `AdvancedSQLiteSession` | 同上 | `create_tables=True`、`store_run_usage()`、`create_branch_from_turn()` | 需要对话分支与用量分析 |
| `EncryptedSession` | 同上 | `encryption_key`、`ttl=600` | 在任意 Session 外包一层加密与过期 |

`EncryptedSession` 的典型用法是"包住一个已经有持久化的后端"：

```python
import os

from agents.extensions.memory import EncryptedSession, SQLAlchemySession

underlying = SQLAlchemySession.from_url(
    "user_123", url="sqlite+aiosqlite:///conversations.db", create_tables=True
)
session = EncryptedSession(
    session_id="user_123",
    underlying_session=underlying,
    encryption_key=os.environ["SESSION_ENCRYPTION_KEY"],
    ttl=600,
)
```

两点提醒：`ttl` 是**令牌级**的存活时间（默认 600 秒），不是整段会话的 TTL；它也不校验历史的完整性与顺序，防篡改仍需存储层手段。另外支持注入客户端的那几个实现（Redis、Dapr、MongoDB）有统一的"所有权"语义：`from_url` / `from_address` / `from_uri` 创建的客户端由 Session 拥有，`close()` 后会话进入终态（后续操作抛 `RuntimeError`）；你注入自己的客户端时，`close()` 是空操作，会话依然可用。

## 第三方 Session 适配器：0.25 开放的三个工具函数

`agents.memory` 在 0.25 额外导出了三个函数，专门给"自己实现 `Session`"的人用。它们不是新能力，而是把 SDK 内部已有的正确做法公开出来——不写它们也能跑，但会在并发取消、limit 解析、dict 配置这三处踩同样的坑。

| 函数 | 解决什么 | 什么时候用 |
| --- | --- | --- |
| `await_session_mutation(awaitable)` | 调用方被取消时先等写入落盘，再抛第一个取消，避免"取消 = 回滚"的误判 | 你的 `add_items` / `pop_item` 里有不可回滚的写操作 |
| `coerce_session_settings(value)` | 把 `SessionSettings` 或 dict 规范成 `SessionSettings`，未知字段报 `TypeError` | 构造器接受 `session_settings: SessionSettings \| dict \| None` |
| `resolve_session_limit(explicit_limit, settings)` | 显式 limit 优先，否则回落到 settings；两者都空返回 `None`（不限） | 你的 `get_items` 要决定一次取多少条 |

```python
from agents.memory import (
    await_session_mutation,
    coerce_session_settings,
    resolve_session_limit,
)


class MySession:
    def __init__(self, session_settings=None) -> None:
        self.settings = coerce_session_settings(session_settings or {})

    async def add_items(self, items) -> None:
        await await_session_mutation(self._write(items))

    async def get_items(self, limit: int | None = None) -> list:
        return await self._read(resolve_session_limit(limit, self.settings))
```

三个边界必须知道：

- `await_session_mutation` 只保证"不因调用方取消而中途放弃"，**不提供**超时、事务、重试或互斥；
- `resolve_session_limit` 只做选择，不切片、不取历史；`0` 与负数会原样保留（约定是"返回空列表"）；
- `coerce_session_settings` 对已有实例（含子类）原样返回，只有 dict 才走校验。

> 注意：这三个函数面向"实现 `Session` 协议的人"，业务代码用不到。业务侧仍然只用 `SQLiteSession`、扩展后端或 `OpenAIConversationsSession`。

## 清理、容量与性能

会话是会长大的。不做治理，迟早会遇到"历史太长被模型拒绝"或"一次读取慢到拖垮首字延迟"。

**清理手段**：

- `pop_item()`：撤销最后一轮。适合"用户想改问题"的交互（弹两次：先撤助手回复，再撤用户提问）。
- `clear_session()`：整个会话重置。适合"新话题"按钮。
- `SessionSettings(limit=N)`：不改存储，只限制读取窗口。
- TTL：`RedisSession(ttl=...)`、`DaprSession(ttl=...)`、`EncryptedSession(ttl=...)` 让旧数据自动过期。
- 压缩：`OpenAIResponsesCompactionSession`，或自己写"摘要 + 截断"策略。

**性能建议**：

1. 生产环境默认设 `limit`，比如 50–100 条。绝大多数客服场景不需要 500 轮前的原话。
2. 别在每次请求里 `get_items()` 全量再自己截断——把限制下推到存储层。
3. SQLite 单文件不适合几十个 worker 共用；到达这个量级就上 Redis 或 Postgres。
4. 写路径要幂等：网络重试可能导致同一批 item 被写两次，Session 实现里最好带去重或幂等键。
5. 观测：把每轮 `result.context_wrapper.usage` 的 `input_tokens` 记下来，比"感觉历史有点长"可靠得多。

## 常见坑与排查

**症状：第二轮开始 Agent 就"失忆"。**
原因：每轮都新建了 `SQLiteSession("...", ":memory:")`，内存库随对象/进程消失。修法：复用同一个实例，或改用文件路径。

**症状：两个用户看到彼此的对话。**
原因：`session_id` 复用了，或按"当前登录用户"取了错的变量。修法：把 `session_id` 与业务实体绑定并在入口处强校验。

**症状：`session.session_id` 抛 `ValueError: Session ID not yet available`。**
原因：`OpenAIConversationsSession` 惰性创建，还没发生任何远端访问。修法：先 `await session.get_items()`，或显式传 `conversation_id`。

**症状：同时传了 `session` 和 `conversation_id`，报错或上下文重复。**
原因：客户端托管与服务端托管互斥。修法：一次运行只选一种，别混。

**症状：开启自动压缩后，流式响应末尾卡住几秒。**
原因：压缩要重写历史，SDK 会等它完成。修法：设 `should_trigger_compaction=lambda _: False`，改在空闲时手动 `run_compaction`。

**症状：多进程部署后偶发历史错乱。**
原因：SQLite 文件模式的锁只在进程内。修法：换共享后端，或按 session 分文件并确保单写者。

## 动手练习

1. **基础**：用 `SQLiteSession` 写一个三轮对话脚本，分别用内存库与文件库运行，重启脚本验证第二次能否"记得"第一轮，并打印每轮的 `result.to_input_list()` 长度变化。
2. **进阶**：实现一个 `UserScopedSession`，四个方法都带 `wrapper` 参数，从 `wrapper.context["tenant_id"]` 决定路由到哪个底层 Session，并用 `RunConfig.session_settings=SessionSettings(limit=20)` 验证读取窗口。
3. **改仓库**：打开 `examples/memory/sqlite_session_example.py`，把 `sqlite:///` 换成 `SQLAlchemySession.from_url(...)`，再加上 `EncryptedSession` 包装与 `ttl=120`，观察超过 TTL 后历史读取的行为，并在 README 里补一行"为什么生产环境要加这一层"。

## 本章小结

- `Session` 协议只要 `session_id` + `get_items` / `add_items` / `pop_item` / `clear_session`，不必继承 `SessionABC`。
- `SQLiteSession(session_id, db_path=":memory:")` 默认内存；文件模式的锁是进程内的，不替代跨进程互斥。
- 运行器每轮先读历史再拼新输入，`session_input_callback` 只改模型输入，不改变写回范围。
- `SessionSettings.limit` 限制读取条数，`RunConfig.session_settings` 按非空字段覆盖。
- session 不能与 `conversation_id` / `previous_response_id` / `auto_previous_response_id` 同轮混用。
- `OpenAIConversationsSession` 是全关键字构造、惰性初始化的服务端存储。
- `OpenAIResponsesCompactionSession` 包装任意非 Conversations 会话，默认 10 条候选即压缩，自动压缩会阻塞流式收尾。
- 生产选型：`RedisSession` / `SQLAlchemySession` / `MongoDBSession` / `DaprSession`，安全需求加 `EncryptedSession`。

## 延伸阅读

- `repo/docs/sessions/index.md` —— 快速开始、合并语义、全部内置实现
- `repo/docs/sessions/advanced_sqlite_session.md`、`sqlalchemy_session.md`、`encrypted_session.md`
- `repo/src/agents/memory/session.py`、`sqlite_session.py`、`openai_conversations_session.py`、`openai_responses_compaction_session.py`
- `repo/src/agents/extensions/memory/`
- `repo/examples/memory/`（`sqlite_session_example.py`、`redis_session_example.py`、`compaction_session_example.py`、`custom_session.py`）

Session 解决了"记住"，但没解决"记什么、记多少、什么时候该忘"。下一章我们把四种跨轮状态策略放在一张决策表里，谈上下文工程。