# 第17章 Session：会话记忆

上一章用 `RunState` 解决了"一次运行被暂停后怎么接着跑"，但它用完即弃。

日常产品里更常见的需求是另一件事：用户今天问了三个问题，明天回来接着问第四个，Agent 得记得前三个。

如果每轮都自己维护列表、手动拼 `result.to_input_list()`，代码很快会变成一团历史管理逻辑。

这一章看 SDK 给出的答案：会话（session）。它是一套只有四个方法的接口，外面围着一整条实现光谱。

**本章只有一条主线**：用 `SQLiteSession` 的文件库跑通一段三轮对话，让第二轮、第三轮都记得第一轮。Redis、SQLAlchemy、MongoDB、服务端会话、压缩全部放在主线之后当"可选微调"，先别碰。

按这章走完，你会得到三样东西：一个能直接运行的文件库会话脚本、一张"漏配就报错"的配置对照表，以及一把判断该换哪种存储的尺子。

---

## 学习目标

- 写出符合 `Session` 协议的自定义存储，并说清四个方法各自何时被运行器调用。
- 区分 `SQLiteSession` 的内存模式与文件模式，并说出各自的适用边界。
- 配齐 `SessionSettings.limit`、`RunConfig.session_settings`、`session_input_callback`，控制"读多少、怎么合并"。
- 为多用户场景设计 `session_id`，并判断什么时候该换 Redis / SQLAlchemy / MongoDB。
- 用 `OpenAIConversationsSession` 与 `OpenAIResponsesCompactionSession` 处理服务端存储与长对话压缩。
- 独立跑通一个三轮对话脚本，能从 `to_input_list()` 的长度变化确认历史真的被读回。

---

## 四个方法：Session 的全部契约

`Session` 的契约只有两件事：一个 `session_id` 属性，加四个异步方法，不需要继承任何基类。

`Session` 在源码里是一个协议（Protocol），只要求这两样。下面这个实现按工单维度存历史，没有继承 SDK 的任何基类。

先验证"自定义存储能被运行器直接接受"这件事。把它存成 `ticket_session_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio
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


async def main() -> None:
    session = TicketSession("ticket_456")
    await session.add_items([{"role": "user", "content": "订单 A-1024 到哪了？"}])
    await session.add_items([{"role": "assistant", "content": "已发货。"}])
    print("全量:", await session.get_items())
    print("最近 1 条:", await session.get_items(limit=1))
    print("弹出:", await session.pop_item())
    print("剩余:", await session.get_items())
    await session.clear_session()
    print("清空后:", await session.get_items())


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python ticket_session_demo.py
```

预期结果：先打印两条历史，再打印最近 1 条（助手那句），`pop_item()` 返回被移除的助手消息，清空后得到 `[]`。这说明四个方法都能独立调用，不需要注册。

四个方法的分工见下表。

| 方法 | 谁调用、什么时候 | 语义要点 |
| --- | --- | --- |
| `get_items(limit)` | 每轮开始前，运行器读取历史 | `limit` 为 `None` 取全量；为正数取**最近 N 条**且保持时间顺序；`<=0` 应返回空列表 |
| `add_items(items)` | 每轮结束后（以及若干中间点），写入新产生的 item | 只写"本轮新增"，不要重写整段历史 |
| `pop_item()` | 应用主动调用（撤销最后一轮） | 返回被移除的 item，空会话返回 `None` |
| `clear_session()` | 应用主动调用（重置会话） | 清空该 `session_id` 的全部历史 |

注意，不需要继承 `SessionABC`。那是给内置实现和需要抽象基类的库作者用的，第三方只要结构上满足协议即可。

这也是为什么，你可以把一个已有的业务仓储类改造成 Session，而不引入 SDK 的继承层级。

还有一个容易被忽略的进阶能力：如果四个方法都声明了关键字参数 `wrapper: RunContextWrapper[Any] | None = None`，SDK 会在调用时把当前运行上下文传进来。

这里有两个条件。四个方法必须全部声明，`**kwargs` 不算；漏掉一个，整套就退回旧签名。用它来做多租户路由、按用户分库非常自然。

> 注意：别在 Session 里做"业务逻辑"。它的职责是存取历史 item，不是判断用户权限。授权应该发生在进入运行器之前。

---

## SQLiteSession：一行代码就能跑起来

主线就是本节的三轮对话脚本：用 `SQLiteSession` 的文件库跑到底，其余后端先不碰。

本地存储的内置实现只有一个：`SQLiteSession`，它足够应付开发与中小规模生产。

`agents.memory` 里另外两个内置实现走别的路子。`OpenAIConversationsSession` 面向服务端会话，`OpenAIResponsesCompactionSession` 是压缩包装，所以"只有一个"说的是本地存储。

先把跑通所需的配置项一次列全。**表里每一项都要在首次模型调用之前就位**，否则不是报错就是静默失败。

| 配置项 | 决定什么 | 主线怎么设 | 漏了会报什么错 |
| --- | --- | --- | --- |
| `session_id` | 选出哪段历史 | `SQLiteSession("user_123", "conversations.db")` 的第一个位置参数 | `TypeError: missing 1 required positional argument: 'session_id'` |
| `db_path`（连接串） | 库文件放在哪 | 第二个参数 `"conversations.db"`；不传默认 `":memory:"` | 不报错，但内存库随进程消失，第二轮开始"失忆" |
| 模型 key | 模型调用凭据 | 环境变量 `OPENAI_API_KEY`，首次调用前设好 | 报 `AuthenticationError`，或只看到 `OPENAI_API_KEY is not set, skipping trace export` 警告 |
| 模型名 | 调哪个模型 | 官方场景沿用默认 `gpt-5.6-luna`，不必设 | 走网关时沿用默认会报 `model not found` |
| 依赖：SQLiteSession | 标准库 `sqlite3` | 默认安装已带，无需额外装 | 不会缺；但 Python 3.9 会在 import 阶段报语法错（`requires-python = ">=3.10"`） |
| 依赖：扩展后端 | 第三方驱动 | 走到后面的"可选微调"再装，如 `uv pip install -e ".[redis]"` | `ImportError`，信息里直接告诉你该装哪个 extra |
| 异步驱动：`aiosqlite` | `sqlite+aiosqlite:///` 连接串的实现 | 只有用 `SQLAlchemySession` 连 SQLite 时才装 | `ModuleNotFoundError: No module named 'aiosqlite'`，它不在 `sqlalchemy` extra 里 |
| `SessionSettings.limit` | 从存储读多少条 | 主线先不设；长对话再设 50–100 | 不报错，但全量读取，第 30 轮 token 暴涨甚至被模型拒绝 |
| `ttl` | 令牌（token）级存活时间 | 主线用不到；`RedisSession` / `DaprSession` / `EncryptedSession` 才设 | 不报错，旧数据永不过期，容量持续涨 |
| `SESSION_ENCRYPTION_KEY` | 加密密钥 | 只在 `EncryptedSession` 微调时设 | `KeyError: 'SESSION_ENCRYPTION_KEY'` |

下面这段是**本章主线的完整脚本**：同一个文件库跑三轮，打印每轮 `to_input_list()` 的长度。把它存成 `sqlite_three_turns.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

from agents import Agent, Runner, SQLiteSession


async def main() -> None:
    dev_session = SQLiteSession("user_123")                      # 内存库，进程结束即丢
    prod_session = SQLiteSession("user_123", "conversations.db") # 文件库，可跨进程

    agent = Agent(name="助手", instructions="回答简洁。")
    questions = ["我叫小林。", "我叫什么？", "用一句话复述我们的对话。"]
    for question in questions:
        result = await Runner.run(agent, question, session=prod_session)
        print(question, "->", result.final_output)
        print("history length:", len(result.to_input_list()))


if __name__ == "__main__":
    asyncio.run(main())
```

运行它，确认 key 已经设好：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python sqlite_three_turns.py
```

预期输出形如下面这样。回答内容每次不同，但每轮问句与 `history length` 一定会递增：

```text
我叫小林。 -> 好的，小林。
history length: 2
我叫什么？ -> 你叫小林。
history length: 4
用一句话复述我们的对话。 -> 你告诉我你叫小林，又问我叫什么，我回答了你。
history length: 6
```

看到第二轮能答出"你叫小林"，就说明文件库写入与读回同时通了。这是整章的验收点，没跑通先去下面的"常见坑与排查"对照。

构造签名是 `SQLiteSession(session_id, db_path=":memory:", sessions_table="agent_sessions", messages_table="agent_messages", session_settings=None)`。两种模式的差别不只是"持久化"：

| 维度 | `db_path=":memory:"`（默认） | 文件路径 |
| --- | --- | --- |
| 生命周期 | 随进程消亡 | 跨进程、跨重启 |
| 连接策略 | 单条共享连接（避免线程隔离丢数据） | 每线程独立连接 |
| 并发控制 | 一把可重入锁（RLock） | 按数据库文件路径共享的进程内 RLock |
| 适用 | 单元测试、单次演示、临时会话 | 单机服务、桌面应用、原型 |

文件模式的锁是**进程内**的：按解析后的绝对路径共用一把可重入锁。它保证同一进程里多个 Session 实例写同一个文件不会互相踩。

但它**不提供跨进程互斥**。多进程或多 worker 部署时，要么让每个 `session_id` 落在不同文件，要么换 Redis / SQLAlchemy / MongoDB 这类真正的共享存储。

还有一条安全边界要写进架构文档：`SQLiteSession` **信任**它读到的数据库。

它不校验行是否被外部篡改、删除、重排或重放。`session_id` 只用于"选出哪段历史"，不承担"认证用户"的职责。

所以数据库文件、所在目录、备份的访问权限，以及"谁能用哪个 session_id"，都必须由你的应用控制。需要防篡改或加密，用后面提到的 `EncryptedSession` 或自建实现。

其他后端都是可选微调，主线跑通后再按"扩展实现清单"和"服务端会话"两节试。

---

## 合并语义：历史和新输入怎么拼

运行器每轮的合并顺序是固定的四步，理解它才能判断"裁历史会不会影响写回"。

1. 取 `session.get_items(limit)` 得到历史；
2. 拼上本轮的新输入；
3. （可选）交给 `RunConfig.session_input_callback` 做最后加工；
4. （可选）再交给 `RunConfig.call_model_input_filter` 做模型调用前加工。

`session_input_callback` 的签名是 `(history, new_input) -> list`，两个参数都是**副本**，可以放心改。返回什么，模型就看到什么。

关键是：**这一步只影响本轮模型输入，不影响写回**。SDK 依然只持久化"属于本轮新增"的 item。所以你裁剪、重排旧历史，不会把旧 item 当成新输入再存一遍。

下面这段同时设两道闸门：从存储读 50 条，送模型只留最近 10 条。存成 `merge_gates.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

from agents import Agent, RunConfig, Runner, SessionSettings, SQLiteSession


def keep_recent(history, new_input):
    return history[-10:] + new_input


async def main() -> None:
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
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python merge_gates.py
```

预期结果：模型看到的是最近 10 条历史加本轮输入；存储侧不因此重写旧 item，下次读到的仍是限制窗口内的原始记录。

`SessionSettings(limit=N)` 和 `session_input_callback` 是两道不同的闸门。前者限制**从存储里读多少**，省 IO、省反序列化；后者决定**送给模型多少**，省 token。

两者都要设的时候，先 `limit` 再 callback，逻辑最清晰。`RunConfig.session_settings` 会按"非 `None` 字段覆盖"的规则叠加到 Session 自己的 `session_settings` 上，所以你可以给会话设一个默认上限，再在特定请求上临时收紧。

这里补一条 0.25 的硬约束：**同一个运行里，session 不能与 `conversation_id`、`previous_response_id`、`auto_previous_response_id` 同时使用**。

前者是客户端托管历史，后者是服务端托管历史。混用会导致上下文重复。

---

## 并发与多用户：先把 session_id 设计对

`session_id` 不是技术细节，它是你的产品模型，先设计对它能省掉后面一半的并发问题。

常见形态有三种：

| 形态 | 示例 | 适合 |
| --- | --- | --- |
| 用户维度 | `user_12345` | 个人助理、单线程客服 |
| 线程维度 | `thread_abc123` | 多会话并列的聊天产品（每个标签页一个） |
| 业务维度 | `support_ticket_456` | 工单/案件系统，一个工单一段历史 |

围绕命名，有三条工程建议。

| 建议 | 理由 |
| --- | --- |
| **不要用自增主键裸值** | 加前缀（`user_` / `ticket_` 等）能避免不同业务线的 ID 撞车，也让日志可读 |
| **一个 session 只服务一个逻辑对话** | 让两个用户共享一个 `session_id` 是数据泄露，不是"节省存储" |
| **多 Agent 可共享同一个 session** | 分诊 Agent 和退款 Agent 用同一个 `session`，就能看到同一段历史，这正是交接（handoff）场景想要的效果 |

并发方面，同一个 `session_id` 上同时跑两个 `Runner.run` 会造成历史交错。

简单做法是在应用层对 `session_id` 加锁，分布式场景用 Redis 锁。SDK 内部为 `OpenAIResponsesCompactionSession` 这类包装器提供了串行化保证，但普通 Session 不承诺这一点。

---

## 服务端会话：OpenAIConversationsSession

这是可选微调：主线跑通后，若不想自己管存储，可以把历史放到 OpenAI 的 Conversations API。

下面这段验证"不传 `conversation_id` 也能新建会话并跑一轮"。存成 `conversations_session_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

from agents import Agent, OpenAIConversationsSession, Runner


async def main() -> None:
    session = OpenAIConversationsSession()                       # 新建会话
    # session = OpenAIConversationsSession(conversation_id="conv_123")  # 续用已有会话

    agent = Agent(name="助手", instructions="简洁回答。")
    result = await Runner.run(agent, "金门大桥在哪个城市？", session=session)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python conversations_session_demo.py
```

预期结果：两种写法都能跑通；注释掉的那行复用 `conv_123`，历史接着那段会话往下走。

两个实现细节值得知道：

- 构造签名是**全关键字**的：`OpenAIConversationsSession(*, conversation_id=None, openai_client=None, session_settings=None)`。传位置参数会报错。
- 会话是**惰性创建**的：不传 `conversation_id` 时，第一次真正访问远端（如 `get_items()` 或非空 `add_items()`）才会创建会话。在那之前读 `session.session_id` 会抛 `ValueError`。

它适合多语言、多服务共享同一段历史的场景。代价是每次读写都要一次网络往返，且历史内容离开你的边界。

---

## 长对话压缩：OpenAIResponsesCompactionSession

压缩（compaction）会话是一个装饰器：包住任意 Session，在历史增长到阈值时调用 Responses API 的 `responses.compact`，把前缀折叠掉。

对话越长，每轮重发的历史越多，成本和延迟线性上涨，这就是它的用武之地。

下面这段验证"压缩装饰器能包住普通 SQLite 会话并跑一轮"。存成 `compaction_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

from agents import Agent, Runner, SQLiteSession
from agents.memory import OpenAIResponsesCompactionSession


async def main() -> None:
    underlying = SQLiteSession("user_123", "conversations.db")
    session = OpenAIResponsesCompactionSession(
        session_id="user_123",
        underlying_session=underlying,
    )

    agent = Agent(name="助手")
    result = await Runner.run(agent, "继续我们上次的话题", session=session)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python compaction_demo.py
```

预期结果：历史涨到阈值后，旧前缀被折叠成压缩项，后续轮次读到的 item 数量下降。

构造签名：`OpenAIResponsesCompactionSession(session_id, underlying_session, *, client=None, model="gpt-6-luna", compaction_mode="auto", should_trigger_compaction=None, max_rollback_items=None)`。

几个必须记住的点：

- **默认阈值是 10**：`should_trigger_compaction` 的默认实现是"候选 item 数 ≥ 10 就压缩"（`DEFAULT_COMPACTION_THRESHOLD`）。候选 item 会排除用户消息和已有的压缩项。
- **不能包装 `OpenAIConversationsSession`**，构造时直接 `ValueError`。两者都在管历史，职责冲突。
- **`compaction_mode`** 有 `"auto"` / `"input"` / `"previous_response_id"` 三种。`"auto"` 在"上一条响应没被存储"或"没有 response_id"时回落到 `input` 模式，所以配合 `ModelSettings(store=False)` 也能工作。
- **自动压缩会阻塞流式输出**：压缩要清空并重写历史，SDK 会等它完成才认为本轮结束。对延迟敏感的产品，关掉自动触发，改用空闲时手动 `await session.run_compaction({"force": True})`。

---

## 扩展实现清单

这些生产级后端全是可选微调，不是主线；没装依赖时导入会明确告诉你该装哪个 extra。

生产级后端都在 `agents.extensions.memory` 下，且都是**懒加载**的。

没装对应依赖时导入，会给出"安装哪个 extra"的明确错误。

| 类 | 导入 | 关键参数 | 适用 |
| --- | --- | --- | --- |
| `AsyncSQLiteSession` | `agents.extensions.memory` | `db_path` | 需要 `aiosqlite` 异步驱动的 SQLite |
| `RedisSession` | 同上 | `from_url(session_id, url=...)`、`ttl` | 多 worker 共享、低延迟 |
| `SQLAlchemySession` | 同上 | `from_url(..., create_tables=True)` 或 `engine=` | 已有 Postgres/MySQL 等 |
| `MongoDBSession` | 同上 | `from_uri(..., uri=..., database=...)`、`ping()` | 文档型存储、水平扩展 |
| `DaprSession` | 同上 | `from_address(..., state_store_name=..., dapr_address=...)`、`consistency`、`ttl` | 云原生 sidecar 架构 |
| `AdvancedSQLiteSession` | 同上 | `create_tables=True`、`store_run_usage()`、`create_branch_from_turn()` | 需要对话分支与用量分析 |
| `EncryptedSession` | 同上 | `encryption_key`、`ttl=600` | 在任意 Session 外包一层加密与过期 |

`EncryptedSession` 的典型用法，是"包住一个已经有持久化的后端"。

下面这段验证"加密层提前备好密钥、设好 TTL 就能工作"。存成 `encrypted_session_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio
import os

from agents.extensions.memory import EncryptedSession, SQLAlchemySession


async def main() -> None:
    underlying = SQLAlchemySession.from_url(
        "user_123", url="sqlite+aiosqlite:///conversations.db", create_tables=True
    )
    session = EncryptedSession(
        session_id="user_123",
        underlying_session=underlying,
        encryption_key=os.environ["SESSION_ENCRYPTION_KEY"],
        ttl=600,
    )
    print("加密会话已就绪:", session.session_id)


if __name__ == "__main__":
    asyncio.run(main())
```

先装两个 extra，再设密钥并运行：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
uv pip install -e ".[sqlalchemy]" -e ".[encrypt]" aiosqlite
export SESSION_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef"
python encrypted_session_demo.py
```

预期结果：打印 `加密会话已就绪: user_123`；读写都经过加密层，令牌超过 `ttl` 后不再可用。

忘设 `SESSION_ENCRYPTION_KEY` 会在构造时抛 `KeyError: 'SESSION_ENCRYPTION_KEY'`；忘装 `.[sqlalchemy]` 或 `.[encrypt]` 会先抛 `ImportError`。连接串用了 `sqlite+aiosqlite:///` 就必须额外装 `aiosqlite`，它不在 `sqlalchemy` extra 里，漏了会报 `ModuleNotFoundError: No module named 'aiosqlite'`。

先说 `ttl`：它是**令牌级**的存活时间，默认 600 秒，不是整段会话的 TTL。它也不校验历史的完整性与顺序，防篡改仍需存储层手段。

再说所有权。支持注入客户端的那几个实现（Redis、Dapr、MongoDB）有统一语义：`from_url` / `from_address` / `from_uri` 创建的客户端由 Session 拥有，`close()` 后会话进入终态，后续操作抛 `RuntimeError`；你注入自己的客户端时，`close()` 是空操作，会话依然可用。

---

## 第三方 Session 适配器：0.25 开放的三个工具函数

这三个函数专门给"自己实现 `Session`"的人用，把 SDK 内部已有的正确做法公开出来。

它们不是新能力。不写也能跑，但会在并发取消、limit 解析、dict 配置这三处踩同样的坑。

| 函数 | 解决什么 | 什么时候用 |
| --- | --- | --- |
| `await_session_mutation(awaitable)` | 调用方被取消时先等写入落盘，再抛第一个取消，避免"取消 = 回滚"的误判 | 你的 `add_items` / `pop_item` 里有不可回滚的写操作 |
| `coerce_session_settings(value)` | 把 `SessionSettings` 或 dict 规范成 `SessionSettings`，未知字段报 `TypeError` | 构造器接受 `session_settings: SessionSettings \| dict \| None` |
| `resolve_session_limit(explicit_limit, settings)` | 显式 limit 优先，否则回落到 settings；两者都空返回 `None`（不限） | 你的 `get_items` 要决定一次取多少条 |

下面这段验证"三个函数拼出的自定义 Session 能正确解析 limit 并完成写入"。这里补上最小可用的 `_write` / `_read` 让它能直接跑，存成 `custom_session_adapter.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

from agents.memory import (
    await_session_mutation,
    coerce_session_settings,
    resolve_session_limit,
)


class MySession:
    def __init__(self, session_settings=None) -> None:
        self.settings = coerce_session_settings(session_settings or {})
        self._items: list = []

    async def _write(self, items) -> None:
        self._items.extend(items)

    async def _read(self, limit) -> list:
        return list(self._items) if limit is None else list(self._items[-limit:])

    async def add_items(self, items) -> None:
        await await_session_mutation(self._write(items))

    async def get_items(self, limit: int | None = None) -> list:
        return await self._read(resolve_session_limit(limit, self.settings))


async def main() -> None:
    session = MySession({"limit": 3})
    await session.add_items([{"role": "user", "content": str(i)} for i in range(5)])
    print("limit=3 读到:", await session.get_items())


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python custom_session_adapter.py
```

预期结果：`self.settings` 一定是 `SessionSettings` 实例；`add_items` 遇到取消时，会先把写入走完再抛异常；屏幕上打印 `limit=3 读到:` 加最后 3 条 item。

三个边界必须知道：

- `await_session_mutation` 只保证"不因调用方取消而中途放弃"，**不提供**超时、事务、重试或互斥；
- `resolve_session_limit` 只做选择，不切片、不取历史；`0` 与负数会原样保留（约定是"返回空列表"）；
- `coerce_session_settings` 对已有实例（含子类）原样返回，只有 dict 才走校验。

> 注意：这三个函数面向"实现 `Session` 协议的人"，业务代码用不到。业务侧仍然只用 `SQLiteSession`、扩展后端或 `OpenAIConversationsSession`。

---

## 清理、容量与性能

会话是会长大的。不做治理，迟早会遇到"历史太长被模型拒绝"，或者"一次读取慢到拖垮首字延迟"。

**清理手段**：

- `pop_item()`：撤销最后一轮。适合"用户想改问题"的交互（弹两次：先撤助手回复，再撤用户提问）。
- `clear_session()`：整个会话重置。适合"新话题"按钮。
- `SessionSettings(limit=N)`：不改存储，只限制读取窗口。
- TTL：`RedisSession(ttl=...)`、`DaprSession(ttl=...)`、`EncryptedSession(ttl=...)` 让旧数据自动过期。
- 压缩：`OpenAIResponsesCompactionSession`，或自己写"摘要 + 截断"策略。

**性能建议**：

1. 生产环境默认设 `limit`，比如 50–100 条。绝大多数客服场景不需要 500 轮前的原话。
2. 别在每次请求里 `get_items()` 全量再自己截断。把限制下推到存储层。
3. SQLite 单文件不适合几十个 worker 共用。到达这个量级就上 Redis 或 Postgres。
4. 写路径要幂等（idempotent）：网络重试可能导致同一批 item 被写两次，Session 实现里最好带去重或幂等键。
5. 观测：把每轮 `result.context_wrapper.usage` 的 `input_tokens` 记下来，比"感觉历史有点长"可靠得多。

---

## 常见坑与排查

按症状查，每条都给出"症状 → 原因 → 修法"。

1. **症状：第二轮开始 Agent 就"失忆"。**
   原因：每轮都新建了 `SQLiteSession("...", ":memory:")`，内存库随对象/进程消失。
   修法：复用同一个实例，或改用文件路径。

2. **症状：两个用户看到彼此的对话。**
   原因：`session_id` 复用了，或按"当前登录用户"取了错的变量。
   修法：把 `session_id` 与业务实体绑定，并在入口处强校验。

3. **症状：`session.session_id` 抛 `ValueError: Session ID not yet available`。**
   原因：`OpenAIConversationsSession` 惰性创建，还没发生任何远端访问。
   修法：先 `await session.get_items()`，或显式传 `conversation_id`。

4. **症状：同时传了 `session` 和 `conversation_id`，报错或上下文重复。**
   原因：客户端托管与服务端托管互斥。
   修法：一次运行只选一种，别混。

5. **症状：开启自动压缩后，流式响应末尾卡住几秒。**
   原因：压缩要重写历史，SDK 会等它完成。
   修法：设 `should_trigger_compaction=lambda _: False`，改在空闲时手动 `run_compaction`。

6. **症状：多进程部署后偶发历史错乱。**
   原因：SQLite 文件模式的锁只在进程内。
   修法：换共享后端，或按 session 分文件并确保单写者。

---

## 动手练习

工作目录：SDK 根目录 `openai-agents-python/`。若你的仓库 clone 在别处，按自己的目录替换，后面不再重复。

1. **基础：三轮对话，内存库与文件库各跑一遍。**
   本练习直接复用主线脚本 `sqlite_three_turns.py`，把它复制成 `sqlite_memory_demo.py`，只把 `prod_session` 那行改成 `SQLiteSession("user_123")`，再运行 `python sqlite_memory_demo.py`。预期输出：三个 `history length` 仍是 2/4/6，但把脚本关掉重开后，内存库版本从 2 重新开始，文件库版本接着 6 往下走。

2. **进阶：实现带 `wrapper` 的多租户路由 Session。**
   把本节 `TicketSession` 的四个方法都加上 `wrapper: RunContextWrapper[Any] | None = None`，从 `wrapper.context["tenant_id"]` 决定路由到哪个底层 Session。下面这段验证"同一个 Session 能按租户路由到不同后端"，把它存成 `user_scoped_session.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio
from typing import Any

from agents import Agent, RunConfig, Runner, RunContextWrapper, SessionSettings, SQLiteSession


class UserScopedSession:
    session_settings = None

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._backends: dict[str, SQLiteSession] = {}

    def _route(self, wrapper: RunContextWrapper[Any] | None) -> SQLiteSession:
        tenant = wrapper.context["tenant_id"] if wrapper else "default"
        if tenant not in self._backends:
            self._backends[tenant] = SQLiteSession(f"{tenant}_{self.session_id}")
        return self._backends[tenant]

    async def get_items(self, limit=None, wrapper: RunContextWrapper[Any] | None = None):
        return await self._route(wrapper).get_items(limit)

    async def add_items(self, items, wrapper: RunContextWrapper[Any] | None = None):
        await self._route(wrapper).add_items(items)

    async def pop_item(self, wrapper: RunContextWrapper[Any] | None = None):
        return await self._route(wrapper).pop_item()

    async def clear_session(self, wrapper: RunContextWrapper[Any] | None = None):
        await self._route(wrapper).clear_session()


async def main() -> None:
    session = UserScopedSession("thread_1")
    agent = Agent(name="助手", instructions="回答简洁。")
    run_config = RunConfig(session_settings=SessionSettings(limit=20))
    result = await Runner.run(
        agent, "你好", session=session, run_config=run_config,
        context={"tenant_id": "acme"},
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

   运行 `python user_scoped_session.py`。预期结果：打印助手回复；把 `context` 里的 `tenant_id` 换成 `globex` 再跑，会在同一个 `conversations.db` 里落到另一个 `session_id`，`limit=20` 只影响读取窗口，不改存储窗口。

3. **改仓库：给示例加加密与过期层。**
   打开 `examples/memory/sqlite_session_example.py`，把 `sqlite:///` 换成 `SQLAlchemySession.from_url(...)`，再加上 `EncryptedSession` 包装与 `ttl=120`。观察超过 TTL 后历史读取的行为，并在 README 里补一行"为什么生产环境要加这一层"。可运行骨架就是"扩展实现清单"里的 `encrypted_session_demo.py`，把 `ttl=600` 改成 `ttl=120` 即可。

---

## 本章小结

- `Session` 协议只要 `session_id` 加 `get_items` / `add_items` / `pop_item` / `clear_session`，不必继承 `SessionABC`。
- `SQLiteSession(session_id, db_path=":memory:")` 默认内存；文件模式的锁是进程内的，不替代跨进程互斥。
- 运行器每轮先读历史再拼新输入，`session_input_callback` 只改模型输入，不改变写回范围。
- `SessionSettings.limit` 限制读取条数，`RunConfig.session_settings` 按非空字段覆盖。
- session 不能与 `conversation_id` / `previous_response_id` / `auto_previous_response_id` 同轮混用。
- 实现选型：服务端用 `OpenAIConversationsSession`（全关键字构造、惰性初始化），压缩用 `OpenAIResponsesCompactionSession`（默认 10 条候选触发、自动压缩阻塞流式收尾），规模上 `RedisSession` / `SQLAlchemySession` / `MongoDBSession` / `DaprSession`，安全需求加 `EncryptedSession`。

---

## 延伸阅读

- `repo/docs/sessions/index.md`：快速开始、合并语义、全部内置实现
- `repo/docs/sessions/advanced_sqlite_session.md`、`sqlalchemy_session.md`、`encrypted_session.md`
- `repo/src/agents/memory/session.py`、`sqlite_session.py`、`openai_conversations_session.py`、`openai_responses_compaction_session.py`
- `repo/src/agents/extensions/memory/`
- `repo/examples/memory/`（`sqlite_session_example.py`、`redis_session_example.py`、`compaction_session_example.py`、`custom_session.py`）

Session 解决了"记住"，但没解决"记什么、记多少、什么时候该忘"。下一章我们把四种跨轮状态策略放在一张决策表里，谈上下文工程。
