# B站直播开放平台客户端（M4）— 2026-10-19

状态：离线实现与测试已完成；**没有向 bilibili.com / biliapi.com 发出过任何请求**，也没有运行过探针。用户还没有开放平台凭据，下面「需要用户完成」一节的每一项都还没验证。

对应计划：`docs/plans/2026-10-19-ai-vtuber-stage1.md` 的 M4。只用官方开放平台，不碰网页端非公开接口和 SESSDATA（《开放平台管理规范（细则）》8.4.1）。

## 新增文件

全部零依赖，只用 Node 24 自带的 `crypto`、`zlib`、`fetch`、全局 `WebSocket` 和 `fs`。

| 文件 | 作用 |
| --- | --- |
| `server/bilibili/sign.mjs` | 请求签名：x-bili-* 头按键名排序拼成 `key:value`，用 `\n` 连接，HMAC-SHA256 小写 hex 作为 Authorization。时间戳按**秒**。 |
| `server/bilibili/packet.mjs` | 16 字节大端包头编解码；version 0 JSON、2 zlib、3 brotli，递归拆多包；不会抛异常，坏数据只返回错误码。解压上限 4 MiB、嵌套最多 2 层。 |
| `server/bilibili/open-live.mjs` | `/v2/app/start`、`/v2/app/heartbeat`（每 20 秒）、`/v2/app/end`；重试策略；game_id 持久化到 `.data/live/bilibili-session.json`（文件 0600，目录 0700）。 |
| `server/bilibili/ws-client.mjs` | 长连接：首包 op7 原样发送 auth_body，之后每 20 秒发空 op2；断线轮换 wss_link 并指数退避；多次失败后通知上层重新开启场次。 |
| `server/bilibili/events.mjs` | 11 种 cmd 规范化为普通对象，按 cmd + msg_id 用 LRU（默认 2048 条）去重；未知 cmd 返回 `{type:'unknown'}`。 |
| `server/bilibili/source.mjs` | `createBilibiliSource()`：读取四个环境变量，串起以上模块，自动恢复，`stop()` 必定结束场次并清掉所有定时器；`status()` 不含任何密钥。 |
| `server/bilibili/redact.mjs` | 日志脱敏（密钥、身份码、auth_body）、昵称打码（`张三` → `张**`）、事件的中文单行描述。 |
| `server/bilibili/testing.mjs` | 测试用的假时钟、假 fetch、假 WebSocket（不是 `*.test.mjs`，不会被测试 glob 当成测试）。 |
| `server/bilibili/fixtures/*.json` | 每个 cmd 一份 fixture，文件名就是 cmd。**是按文档字段手写的合成数据，不是抓包。** |
| `scripts/bili-probe.mjs` | 探针。 |

## 行为细节（实现时做的决定）

- **重试**（`/v2/app/start`）：7001 冷却等 10 秒重试；7002 先结束已知的残留场次再等 10 秒重试；4009、5000–5002、网络错误、响应不是 JSON 时按 2、4、8、16、32 秒指数退避；最多 6 次。其他错误码（如 4002 签名错、7007 身份码错）直接抛出带 `code` 的 `OpenLiveError`，不重试。
- **start 请求本身不可中断**：如果在请求途中调用 `stop()`，会等这个请求返回，拿到 game_id 后立即 end，避免留下拿不到 id 的场次。重试之间的等待可以被 `stop()` 立即取消。
- **残留场次**：每次 start 前读取持久化文件，有 game_id 就先 end。平台回复 7xxx 场次类错误码（说明场次已不存在）也算结束并删除记录；网络不通或签名、权限类错误则保留记录，下次再试。
- **项目心跳**：每 20 秒一次。收到 7003 或 7000，或连续 3 次失败，就认为场次已失效，由 source 结束旧场次并重新 start。
- **长连接**：1、2、4… 秒退避（上限 30 秒），每次失败换下一个 wss_link，复用同一个 auth_body；连续 3 次失败或鉴权被拒（op8 的 code 非 0）就重新 start 换新 auth_body。连接保持 60 秒以上、或收到心跳回复/业务消息，失败计数归零。连接 15 秒内没有建立算失败。
- **静默检测**：收到过至少一次 op3 心跳回复的连接，70 秒没有任何数据就主动断开重连。从没收到过 op3 的连接不做这项判断，免得平台不回 op3 时在安静的直播间里反复重连。
- **约 7 天静默**：source 记录最后一条业务消息的时间，`status().lastEventAgeMs` 给出距今多久，告警阈值由调用方（M5 控制台）决定。
- **重新开启失败**：可重试的错误按 30 秒起、上限 5 分钟退避继续尝试；不可重试的错误进入 `error` 状态并停止，需要重新 `start()`。
- **INTERACTION_END**：game_id 与当前场次相同（或消息里没有 game_id）才重新 start，旧场次的通知忽略。事件本身照常交给 `onEvent`。
- **game_id 为空**：参考 blivedm 的写法按「可能为空」处理：不发项目心跳、也不调用 end，长连接照常。是否真会出现待复核。
- **金额**：礼物 `paid ? r_price × gift_num / 1000 : 0`（缺 r_price 时退回 price）；SC 的 `rmb` 本身就是元；上舰按计划取 `price / 1000`。
- **事件结构**：所有事件都有 `type, cmd, msgId, ts(毫秒), roomId, user, text, emoji, amountCny`；`user` 为 `{openId, name, face, guardLevel, medalName, medalLevel, isAdmin}`，按 open_id 识别（uid 已废弃）。各类型另有 `mirror/replyTo`、`gift`、`superchat`、`messageIds`、`guard`、`likeCount`、`live`、`gameId`。默认不带 `raw`。
- **status()**：只有 `{state, roomId, hasGame, lastEventAgeMs, errorCode}`。state 取值：`unconfigured / idle / starting / connecting / connected / reconnecting / restarting / stopping / stopped / error`。
- **脱敏**：source 的所有日志都经过脱敏，四个环境变量的值和本次进程里发过的 auth_body 一律替换成 `[已隐藏]`。错误信息里本来就不放请求体和请求头。持久化文件里只有 game_id 和开启时间。
- **配置校验**：APP_ID 必须是纯数字；另外三个必须是不含空格的可打印 ASCII。带隐藏空白的值不会被悄悄 trim，直接报「格式不正确」，提示里只写变量名，不回显值。

## 离线已验证

命令（pnpm 不在 PATH 上，直接用 node）：

```bash
node --test server/bilibili/*.test.mjs
```

结果：**82 个测试全部通过**，连跑 6 次结果一致。原有测试 `node --test server/*.test.mjs src/*.test.mjs shared/*.test.mjs scripts/*.test.mjs`：565 个，564 通过、1 跳过（worktree 里没装 Live2D 样例资源，原本就跳过）、0 失败。递归 glob `node --test 'server/**/*.test.mjs'` 得到 178 个（96 + 82），`testing.mjs` 没有被当作测试。没有改动 src，所以没有重跑 vue-tsc（tsconfig 只包含 src）。

覆盖：

- **签名向量**：两组期望值由 macOS 自带的 `md5` 和 `openssl dgst -sha256 -hmac` 独立算出，不是用被测代码生成的；另测排序、无尾换行、秒级时间戳、nonce 唯一。
- **解包**：头部逐字节；Buffer/ArrayBuffer/带偏移的视图往返；多包拼接；zlib 和 brotli 各自解出 3 个包再接一个明文包；截断、长度非法、坏压缩数据、字符串帧都不抛异常并保留出错前的包；4 MiB 解压上限、3 层嵌套被拒绝。
- **生命周期**：签名 POST 到固定域名、`redirect:'error'`；HTTP 心跳严格 20 秒；7001 在第 10 秒重试；7002 两种情况（先结束残留再重开 / 无残留时等冷却）；4009 按 2/4/8 秒退避后放弃；7007 立即失败；缺 auth_body 的响应会把已开的场次 end 掉；残留场次先 end；平台说场次不存在时删除记录，网络不通或签名错误时保留；损坏或超大的记录文件被忽略；心跳 7003 和连续失败触发重开；中止等待、中止期间刚开的场次也会被 end；end 对暂时性错误短暂重试且不抛异常；持久化文件权限 0600。
- **长连接**（假 WebSocket + 假时钟）：首包 op7 原文；第 20、40、60 秒发空 op2；zlib 多包消息送达并更新 lastEventAt；消费者回调抛错不影响连接；断线后 1/2/4 秒退避并轮换到第 2、3 个地址再回到第 1 个；连续 3 次失败后不再自己重连而是请求重开；鉴权被拒立即请求重开；连接超时、半开连接（收过 op3 后 70 秒无数据）都按失败处理；从没收到 op3 时不判静默；稳定 60 秒后计数归零；旧连接迟到的 close 事件被忽略；auth_body 从不出现在日志里。
- **事件**：11 个 fixture 逐字段比对；表情弹幕、回复、房管；免费礼物为 0 元；盲盒按 r_price；SC_DEL 的 id 与 SC 的 `superchat.id` 同为字符串可直接匹配；乱类型输入被安全转换；未知 cmd 和垃圾输入不抛异常；去重 LRU（命中刷新、超限淘汰最久未用、无 msg_id 不去重、同 id 不同 cmd 不算重复）。
- **source**：未配置时不发任何请求并只列变量名；完整流程 start → op7 → 两路 20 秒心跳 → zlib/brotli 事件（重复的弹幕被丢弃）→ stop 调用 end、删除记录、**假时钟里没有任何残留定时器**；崩溃留下的场次在下次 start 前被结束；长连接 3 次失败后 end 旧场次、用新 auth_body 和新地址重连；7003 和 INTERACTION_END 触发重开，其他 game_id 的通知被忽略；重开失败的两种处理；冷却等待中 stop 不会误调 end；start 请求途中 stop 仍会 end 掉刚开的场次；stop 后可以再次 start；回调抛错不影响；**密钥、身份码、auth_body 不出现在任何日志和 status() 里**（包括平台错误消息和消费者异常里故意夹带这些值的情况）。
- **探针**：缺变量时只列变量名、退出码 1、不回显已填的值（子进程实测）；用假 source 验证输出打码、SIGINT 先 stop 再以 0 退出、第二次信号立即以 130 退出、启动失败时也会 stop 并以 1 退出。
- **变异检查**：把时间戳改成毫秒、去掉排序、stop 不调 end、不清重开定时器、去掉心跳调度、start 前不清残留、7002 不清残留、不轮换地址、首包发错、免费礼物算钱、LRU 不淘汰、关掉脱敏、关掉嵌套上限、文件权限改 0644、去掉「收到过 op3 才判静默」、INTERACTION_END 不比对 game_id，每一项都至少让一个测试失败。

## 需要用户完成（都还没做）

1. **开发者入驻与审核**：用主播本人账号在 open-live.bilibili.com/open-manage 申请个人开发者，审核通过后 access_key_id / access_key_secret 会发到邮箱。建项目时尽量选「直播工具/插件」，记下项目 ID（app_id），在「版本管理」里创建开发版本。
2. **身份码**：在 play-live.bilibili.com 右侧或直播中心「开始直播」处获取。
3. **填配置**：自己把下面四项写进 `.env.local`，不要贴到对话里：
   `BILIBILI_OPEN_ACCESS_KEY_ID`、`BILIBILI_OPEN_ACCESS_KEY_SECRET`、`BILIBILI_OPEN_APP_ID`、`BILIBILI_OPEN_CODE`。
4. **跑探针**（会真正调用开放平台，需要你自己执行）：

   ```bash
   node --env-file-if-exists=.env.local scripts/bili-probe.mjs
   ```

   加 `--json` 会输出打码后的完整事件。按 Ctrl-C 会先调用 `/v2/app/end` 再退出；连按两次会立即退出，残留场次在下次启动时自动结束。
5. **调试页模拟推送**：在开发版本的调试页面推送弹幕、礼物、SC、SC 撤回、上舰，看探针是否逐条打印、金额是否正确。
6. **在自己的直播间实测**：开播后让朋友发普通弹幕和表情弹幕、点赞、进房。
7. **回报这些结果**（可以只回报结论，不要贴密钥和完整昵称）：
   - [ ] 第一次 start 是否成功；失败时的错误码。若是 4002/4003，先怀疑时间戳单位（这里用秒，2022 年官方 JS demo 用毫秒）。
   - [ ] 开发者账号与直播间账号不同时是否被拒（5004/5011），即是否必须是同一个账号。
   - [ ] 实际收到了哪些 cmd：DM、DM_MIRROR、SEND_GIFT、SUPER_CHAT、SUPER_CHAT_DEL、GUARD、**LIKE、LIVE_ROOM_ENTER**、LIVE_START、LIVE_END、INTERACTION_END；LIKE / ENTER 是否需要另外向运营申请。
   - [ ] 后台能否选「直播工具/插件」；心跳超时是 60 秒还是 180 秒。
   - [ ] 有没有遇到 4009，频率大概多少。
   - [ ] 上舰 `guard_num > 1` 时 `price` 是单价还是总价；盲盒的 `price` 与 `r_price` 哪个是实付。
   - [ ] 长连接是否回 op3 心跳回复、op8 鉴权回复是否是 `{"code":0}`。

## 待复核

- `open-live.mjs` 里的错误码中文提示：4009、5004、7001、7002、7003、7010 来自计划的调研；4000–4004、7000、7007 是按记忆中的公开错误码表写的，只用作提示，不影响逻辑（只有 7001/7002/7003/7000/4009/5000–5002 参与判断）。
- fixtures 是按文档字段手写的，DM_MIRROR 的字段尤其没有把握；拿到真实消息后应替换或补充 fixture（替换前先打码昵称和头像）。
- 礼物金额用 `r_price`、上舰用 `price/1000`，都按计划实现，要用调试页核对。
- `game_id` 可能为空、op3 是否存在、op8 的格式，都要用探针确认。

## 给 M5 的接入说明

- `createBilibiliSource({ onEvent, onStatus })`，`start()` / `stop()` / `status()`。进程收到 SIGINT/SIGTERM 时要 `await source.stop()`，它会结束场次。
- 默认持久化路径是仓库根目录下的 `.data/live/bilibili-session.json`（已在 .gitignore 的 `.data/` 下），可用 `storagePath` 改，传 `null` 关闭。
- `/api/health` 只应暴露 `status()` 的内容。
- 这次没有改 `package.json`：测试 glob 改成递归要等 M1；在那之前用 `node --test server/bilibili/*.test.mjs` 单独跑。
