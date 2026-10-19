# AI VTuber 第一阶段计划：能上 B 站直播的最小闭环

日期：2026-10-19。基线：main @ 8dd7ac6。

决策前提：B 站直播（OBS）；继续演进 airi-lite，Project AIRI 只作参考；第一阶段先跑通最小开播闭环；付费 API 少量可接受（DeepSeek + 云端 TTS，每月几十到约 200 元，设每日上限）。

来源：多 agent 调研（B 站开放平台、OBS 浏览器源、平台规则与审核、代码复用）→ 两套方案（最快首播 / 长期地基）→ 评审合成。评审结果：mvp 8/10；foundation 7/10，以 mvp 为骨架。研究结论有时效性，见文末「待复核」。

## 概要

以 MVP 为骨架：服务端整段生成回复，OBS 舞台只做哑终端；先用人工转述模式首播，开放平台客户端从第 0 天并行开发。

从 foundation 嫁接五点：
(1) 舞台不直调 /api/speech，改为调用 POST /api/live/stage/speech。服务端用与舞台 speak() 完全相同的 replySentenceStream(text,delivery,cues)（src/speech-sentences.ts:128，Node 可直接 import）算出本回合已审核的句子集合，只给 primary 租约放行，每句只合成一次。这样不需要 beginSentences 或 seq 改造，就获得了服务端执行的租约、一次性购音和 production 可用性。
(2) 引入 AIRI 风格的事件信封和进程内 hub，审计日志作为订阅者。
(3) 测试 glob 改为递归，代码按 server/live、server/bilibili、src/stage、src/console 分目录。
(4) 真实开播用构建产物（npm run live），不用 dev 模式。
(5) 加入开播预检、game_id 持久化与残留场次清理、persona 拆分。

另外修补我在仓库里发现的三处问题：production 下 .html 被 immutable 缓存；TTS 账本 lock 残留会让云端语音永久 fail-closed；Vite 8 改用 rolldownOptions。

7 个里程碑，前两个不需要任何凭据、也不产生费用；M3 做首次真实测试直播。

## 架构

一、进程（全部在推流用的 Mac 上）
- Node 24 单进程 server/index.mjs。设 AIRI_LIVE=1 才启用 live 子系统，且 HOST 必须是回环地址。开发用 dev 模式；开播用 npm run live（先 build，再以 production + AIRI_LIVE=1 启动，需要随机生成 ≥16 位的 AIRI_DEMO_ACCESS_CODE）。
- 注意：线上服务器同样监听 127.0.0.1（前面是反向代理），只检查 HOST 区分不了推流机和线上。真正的保护是线上 .env 不设 AIRI_LIVE，并且逐请求拒绝带代理头的请求。
- OBS 浏览器源加载 /airi/stage.html。有 window.obsstudio 时默认 role=obs，否则默认 preview。
- 普通 Chrome 打开 /airi/console.html（主播控制台，不被采集）。
- index.html（App.vue）不改，继续当调试聊天页。
- 外连：DeepSeek、MiniMax cn、B站开放平台（M4 起）、cubism.live2d.com。
- 出口：粉丝 ≥5000 用 OBS 直推；否则用 OBS 虚拟摄像机或窗口采集，交给直播姬 Mac 开播。

二、一个回合（整段模式）
1. 来源发 LiveEvent 信封 {id,type,source,ts,parentId?,data} 进 hub。来源包括：控制台注入、fixture 回放、B站。data 为 {msgId,user{openId,name,guardLevel,medalLevel,isAdmin},text,amountCny,gift?}。
2. 输入闸门（M5）处理后进入 queue。queue 默认手动审批，优先级 SC > 主播插话 > 弹幕，带 TTL、上限和去重。
3. brain 只在以下条件同时满足时开口：control=running、primary 已 ready、obs.active 不为 false、没有进行中的回合、回复额度未用完。
4. brain 发布 activity:thinking，然后调用 streamDeepSeek：
   - system 为 buildLiveSystemPrompt，字节保持不变以命中前缀缓存；
   - 历史保留最近 6 轮；
   - user 为 formatViewerBatch 生成的 <viewer_message>；
   - max_tokens=160。
5. 增量用 createDeliveryCueParser 收集正文和 cues。被截断时截到最后一个句末标点。
6. screenReply 整段审核。不通过就不出声，记一次 strike 并写审计；10 分钟内 3 次 strike 自动暂停。
7. 通过后 planUtterance 算出允许的句子多重集合，发布 say{turnId,text,cues,delivery,replyTo}，并启动看门狗。
8. 舞台调用 speak(text,delivery,DEFAULT_VOICE,cues,'cloud',{onEnded})。
9. 每句的 synthesizeCloud 发 POST /api/live/stage/speech {leaseId,turnId,text,delivery}。服务端校验 primary、当前回合和句子配额，然后调 speech.synthesise()，与 /api/speech 共用同一个 .data/tts-budget.json 和 4 并发。
10. 舞台用 decodeCloudSpeechResponse 解码。口型和节拍在浏览器里计算，因为 Node 没有 MP3 解码器。
11. 播完后舞台 POST report ended{turnId,outcome}。brain 只把被实际购音的句子记入历史，冷却 1.5 秒后进入下一回合。
12. 礼物、上舰致谢和危机关怀走服务端模板，不经过 LLM（M5）。

三、协议（零新依赖）
- SSE：GET /api/live/stage/events?role=obs|preview。首帧 retry:2000；每 15 秒发 ': ping'，定时器 unref 且只在有连接时运行。事件有 hello{leaseId,role,primary,mode}、standby、say、stop、activity、mode{live|brb}、reload。
- 舞台上报 POST /api/live/stage/report：ready、avatar、ended、problem、obs。
- 控制台：GET /api/live/state；POST /api/live/control {action:say|stop|pause|resume|panic|reload-stage|approve|reject|inject}。M2 起改用 /api/live/console/events 推送。
- 本机防护，所有 /api/live/* 都要通过：
  - socket 必须是回环地址，不用 clientIp（它信任 X-Real-IP，见 server/app.mjs:252-257）；
  - 不能带 x-real-ip / x-forwarded-for / forwarded；
  - Host 白名单；带 Origin 时必须同源；
  - 写请求要求 application/json 加 X-Airi-Live:1 头，强制 CORS 预检。
- 租约：最新连上的 obs 连接成为 primary，旧连接收到 standby；preview 永不出声，也不能购音。primary 变化时，当前回合按取消处理。

四、B站（M4、M5）
- server/bilibili/* 零依赖：用 crypto 做签名，用 zlib 的 inflate 和 brotli 解包，用全局 WebSocket 连接。
- 生命周期：start，之后每 20 秒发 HTTP 心跳和 WS op2；op7 鉴权；轮换 wss_link；指数退避；连续失败后重新 start；收到 SIGINT/SIGTERM 时调 end。
- game_id 存入 .data/live/bilibili-session.json，启动时先结束上一场残留。
- 只产出 input:* 事件。如果长期拿不到密钥，再写一个 blivechat 适配源，大脑不用改。

五、后续插口
- ASR、主动闲聊、游戏作为新的 input:* 来源；
- 长期记忆作为 buildTurnMessages 的 context 提供者；
- 字幕独立源、桌面伴侣作为新的 stage role；
- 逐句流水线（M7）复用现有句子配额和购音路由。

## 里程碑

### M1 OBS 舞台闭环：控制台直说 → 舞台出声（零凭据、零费用）（工作量 L，依赖：无）

**范围**

1. 预备重构：递归测试 glob；erasableSyntaxOnly；rolldownOptions 多入口；.html 改为 no-cache；抽出 speech.synthesise；createRequestHandler 支持注入 speech 和 live；抽出 decodeCloudSpeechResponse；speech.ts 加 onEnded 和 browserFallback；mountHiyori 加 autoInteract。
2. server/live 下的 local-request、sse、stage-bus、utterance、runtime，以及 index.mjs 的组装。
3. 舞台页、最小控制台、mock-live（用 say 作假 TTS）。

**验收**

离线：
- 原有 565 个测试加新增测试全部通过，vue-tsc 通过，vite build 产出三个 html。
- 运行 mock-live：在 Chrome 里控制台说一句，能听到声音、看到口型和字幕，控制台显示 played。
- 第二个 obs 标签页打开后，旧页收到 standby 并静音；preview 只显示字幕；停下返回 cancelled；紧急停止显示 brb；重复购音返回 409；不传 live 时行为与现在一致。
需用户（不花钱）：在 OBS 32.2.x 中逐项确认透明背景、自动出声、混音器里只有一路声音、口型同步、SRGB Off 后无黑边、切场景后角色不冻结、1080p30 不丢帧；同时确认推流出口。

### M2 服务端大脑 + 假弹幕源（离线全回合）（工作量 L，依赖：M1）

**范围**

1. 抽出 streamDeepSeek，拆分 persona。
2. 新增 live-prompt、hub、queue（手动审批）、moderation 的输出闸门、brain、audit-log、fixture 回放源。
3. 控制台加队列、审批、注入、额度和 strike 显示；「直接说」也要过输出闸门。
4. mock-live 内置假 DeepSeek，并提供 --adversarial 模式。

**验收**

离线：
- deepseek/brain/queue/moderation/live-prompt/hub/audit 的测试全部通过，覆盖：系统提示字节稳定；伪造 </viewer_message> 和 [[tone]] 被清洗；无 primary 或已暂停时不调用 DeepSeek；手动模式下未批准的条目永远进不了 LLM；闸门命中后不 say 并写日志，3 次 strike 自动暂停；stop 能中止上游；历史只保留 6 轮且只记已购音的句子；额度用完自动暂停。
- mock-live 回放 30 分钟彩排流，没有一句未审核的文本出现在 say 里。
不需要用户参与。

### M3 首次真实测试直播（人工转述模式）（工作量 S，依赖：M2）

**范围**

1. npm run live（build 后以 production 启动）。
2. 预检：DeepSeek 和 TTS 已配置；账本可写且没有残留 .lock；屏蔽词已加载；primary ready 且头像已加载；OBS 源处于 active。预检不全过时禁止 resume，除非主播手动确认跳过。
3. 开播手册 docs/live-runbook.md。
4. 用户逐次批准首次付费调用并试听。
5. 私下彩排 30 分钟后，与朋友做首播：主播把朋友的消息转述进控制台。

**验收**

离线：预检逻辑有单测。
需用户：
- 首次付费调用已逐次批准，并试听确认音色；
- 彩排中没有任何未审核的文本被说出或显示；
- 紧急停止后 1 秒内静音并显示 brb；
- 按审计日志的 usage 和账本算出的每小时成本，与估算偏差在 ±50% 以内；
- 简介和 AI 标识到位，首播完成。

### M4 B站开放平台零依赖客户端与探针（第 0 天并行）（工作量 M，依赖：无）

**范围**

1. 签名（时间戳用秒）。
2. 解包：版本 0/2/3，递归拆多包。
3. 生命周期：start/心跳/end，7001 等 10 秒、7002 先 end 再 start、7003 重开、4009 退避。
4. WS：op7 鉴权、op2 心跳、轮换 wss_link、退避重连。
5. 事件规范化：金额换算、按 msg_id 去重、标记表情弹幕和 MIRROR。
6. game_id 持久化与残留清理、探针、/api/health 只报状态。
7. 读取四个 BILIBILI_OPEN_* 变量。

**验收**

离线：
- 签名向量正确；编解码往返一致；zlib 和 brotli 多包能拆开；
- 用假 WebSocket 和假时钟验证首包 op7、每 20 秒心跳、断线轮换和退避、多次失败后重新 start、stop() 必定调用 end；
- 各 cmd 的 fixture 能正确规范化。
需用户：开发者审核通过；用调试页推送模拟消息；在自己的直播间运行探针；记录实际能收到哪些 cmd（含 LIKE/ENTER），并确认开发者账号与直播间账号是同一个。

### M5 真实弹幕接入：输入闸门、SC/礼物/上舰、危机分流（工作量 M，依赖：M3、M4）

**范围**

1. B站 source 接入 hub。
2. screenViewerEvent：规范化、长度限制、联系方式和网址整条丢弃、屏蔽词插字匹配、按 open_id 限流、TTL、去重；生成 speakName，原始昵称只进日志。
3. 危机词走固定模板（提示 12356）并在控制台告警。
4. 收到 SC_DEL 时，未念的移出队列，正在念的立即 stop。
5. 致谢模板，按窗口合并。
6. 表情弹幕和 MIRROR 不进 LLM。
7. 控制台显示原始事件和闸门结论，默认仍为手动审批。

**验收**

离线：用对抗样例表覆盖零宽和 bidi 字符、全角、插字、各种联系方式变体、危机词、限流、SC_DEL 两种时机；fixture 走完整流程时，原始 uname 从不出现在 prompt 和 say 里。
需用户：在自己的直播间用手动模式和朋友实测普通弹幕、表情弹幕和含联系方式的弹幕；SC 和礼物用调试页模拟。

### M6 自动模式与长播稳定性（可选阿里云输出审核）（工作量 M，依赖：M5）

**范围**

1. 自动挑选：SC 按金额和时间优先，每回合 1–3 条，间隔 ≥1.5 秒，随时可切回手动。
2. 门控：obs active=false 时不生成。
3. 遇到 429 或 TTS 连续失败时退避并自动暂停。
4. DeepSeek usage 写入每日台账，控制台显示估算金额。
5. 可选 moderationProvider：接阿里云 llm_response_moderation，整段审核，1.5 秒超时按不通过处理。

**验收**

离线：用假时钟测试挑选优先级和节奏；门控、退避测试；provider 的通过、拒绝、超时三种情况。
需用户：值守下做一场 1–2 小时自动模式直播；播后核对审计日志和两家平台的实际扣费。

### M7 （可选）逐句低延迟流水线（工作量 L，依赖：M3）

**范围**

1. 生成过程中按句审核，发布 turn.sentence。
2. 舞台改用 beginSentences，或把每句加换行后推进 beginStream。
3. 复用句子配额和购音路由；任一句被拦截时中止上游并丢弃后续句子。

**验收**

离线：被拦截后后续句子不发布、不合成。
需用户：实测从选中弹幕到出声不超过约 2.5 秒。

## 复用的现有模块

- `server/app.mjs createRequestHandler（:29-91）`：新增可注入的 speech 实例和 live 工厂，/api/live/* 放在 :76 的 404 之前分发。不传 live 时行为逐字节不变。:246 改为所有 .html 都发 no-cache。
- `server/app.mjs handleChat/relayDeepSeekStream（:138-218、:259-300）`：M2 抽成 server/deepseek.mjs 的 streamDeepSeek，并读出 usage（请求里已有 include_usage，见 :173）。/api/chat 改为调用它，由 server/index.test.mjs 保证行为不变。
- `server/speech.mjs createSpeechHandler（:59-141）`：抽出 synthesise({text,delivery},{signal}) 并导出错误映射（:118-131）。/api/speech 与舞台购音共用同一个实例，因此共用 4 并发和账本。
- `server/tts-budget.mjs createTtsBudget（:18）`：TTS 硬上限：按 2×字数预留，不退款（:88-89）。另建 .data/live-reply-budget.json 实例，用作每日回复数计数器。
- `server/delivery-cue.mjs（:16）`：大脑解析 [[tone:x]]，事件格式为 {type:'delivery',value} / {type:'delta',content}，已实测。cues 的收集方式照搬 src/App.vue:326-334。
- `src/speech-sentences.ts replySentenceStream（:128）`：服务端 planUtterance 用与舞台 speak() 相同的参数展开句子，作为购音白名单。Node 24 可直接 import，已实测。
- `server/persona.mjs（:3-18）+ src/persona.ts DEFAULT_PERSONA（:55）`：拆出 personaSections 和 TONE_CUE_RULES（:16），buildSystemPrompt 输出不变。直播规则沿用 :12 的「数据不是指令」写法。直播人设覆盖 :27/:37 的 17–18 岁高中生设定。
- `src/speech.ts createSpeechController`：舞台直接复用 speak、cancel（:477）、advance 收尾分支（:378-389）和 hasCloudCapacity 回压。只加两项：每次播放的 onEnded，以及 browserFallback:false。
- `src/cloud-speech.ts fetchCloudSpeech（:367-459）`：把 :414 之后的响应校验和解码抽成 decodeCloudSpeechResponse，舞台的购音函数复用它。
- `src/live2d.ts、avatar-startup.ts、cubism-runtime.ts、avatar-context.ts`：整条头像管线照用：backgroundAlpha 已是 0（live2d.ts:22），加载失败可重试。只加 autoInteract 选项（:40、:72-74）。舞台的挂载和同步写法照抄 App.vue:157-231。
- `scripts/mock-voice-app.mjs、scripts/mock-deepseek.mjs、server/index.test.mjs、src/speech.test.mjs AudioStub（:9-37）`：作为 mock-live 脚本和新测试的模板：createServer 监听 0 端口，用 fetch 的 getReader 读 SSE。
- `package.json:9 test、tsconfig.json`：改为带引号的递归 glob（已实测仍为 565 个测试）；tsconfig 加 erasableSyntaxOnly（已实测 vue-tsc 通过）。

## 新增模块

- `server/live/local-request.mjs`：M1：checkLocalRequest（回环 socket、无代理头、Host 白名单、Origin 同源、JSON + X-Airi-Live）和 readSmallJson。
- `server/live/sse.mjs`：M1：SSE 通道。retry/id/event 帧，ping 心跳（unref，只在有连接时运行），慢客户端断开，关闭时清理。
- `server/live/stage-bus.mjs`：M1：舞台总线。租约（最新 obs 为 primary）、standby、hello、广播、状态汇总。
- `server/live/utterance.mjs`：M1：planUtterance 展开句子；createSentenceAllowance 维护多重集合配额。
- `server/live/runtime.mjs`：M1：createLiveRuntime。路由、控制状态 running/paused/panic、回合与看门狗、舞台购音路由、health、stop；M2 起接入 brain。
- `scripts/mock-live.mjs`：M1：零费用彩排，用 macOS say 生成 32kHz WAV 当假 TTS；M2 加内置假 DeepSeek（含 --adversarial 模式）和 --replay。
- `stage.html、src/stage/main.ts、src/stage/stage-client.ts、src/stage/stage.css`：M1：OBS 舞台。透明背景，Hiyori，隐藏 audio，字幕，常驻 AI 标识，brb 画面，退避重连。
- `console.html、src/console/main.ts、src/console/ConsoleApp.vue、src/console/console-api.ts`：M1 提供说话和控制；M2 加队列审批和注入；M3 加预检；M5 加原始事件流和闸门结论。
- `server/deepseek.mjs`：M2：streamDeepSeek，/api/chat 与大脑共用。
- `server/live/hub.mjs`：M2：makeEvent 生成信封，按前缀 pub/sub，订阅者之间异常隔离。
- `server/live/live-prompt.mjs`：M2：resolveLivePersona、buildLiveSystemPrompt（字节稳定）、formatViewerBatch、模板话术。
- `server/live/queue.mjs`：M2：候选队列，处理审批、优先级、TTL、上限、去重；M5 加按 open_id 限流、礼物合并、SC_DEL。
- `server/live/moderation.mjs`：M2：normalizeText、loadRules、screenReply（输出闸门）；M5 加 screenViewerEvent、speakableName、危机分流；预留 moderationProvider 接口。
- `server/live/brain.mjs`：M2：回合状态机，负责门控、生成、审核、say、等待 ended、历史、额度、strike 自动暂停、stop/panic 时中止上游。
- `server/live/audit-log.mjs`：M2：订阅 hub，写 .data/live-logs/日期.jsonl（权限 0600），启动时删除 183 天前的日志。
- `server/live/sources/fixture.mjs、server/live/fixtures/rehearsal.jsonl`：M2：假弹幕/SC/礼物定时回放。
- `server/live/preflight.mjs、docs/live-runbook.md`：M3：开播预检和开播手册（OBS/直播姬清单、简介模板、紧急 curl）。
- `server/bilibili/sign.mjs、packet.mjs、open-live.mjs、ws-client.mjs、events.mjs、source.mjs、fixtures/`：M4：零依赖开放平台客户端，产出 input:* 事件。
- `scripts/bili-probe.mjs`：M4：探针，连自己的直播间，打印打码后的规范化事件，Ctrl-C 时调 end。
- `server/live/thanks.mjs`：M5：礼物/上舰/SC 致谢模板，按窗口合并、限频、换算金额。

## 风险与对策

- **粉丝不足 5000 时拿不到第三方推流码，OBS 无法直推。**
  对策：舞台页与推流工具无关：改用直播姬 Mac 采集 OBS 虚拟摄像机或窗口。M1 验收里就请用户确认走哪条路；不用非官方工具抓推流码。
- **开放平台审核慢或被拒，部分 cmd 需要另外申请。**
  对策：M4 与 M1–M3 并行，首播用人工转述。stage 1 只依赖 DM/SC/GIFT/GUARD 四类；长期拿不到密钥时再写 blivechat 适配源，不碰网页端接口和 SESSDATA。
- **AI 说出违规、涉政、索要礼物等内容，导致平台处罚，并触发 Live2D 许可终止条款（第 7.2、7.3 条）。**
  对策：多层防护：直播规则写进系统提示；观众文本只作为 <viewer_message> 数据，并先清洗；整段输出闸门；strike 累计自动暂停；头几场手动审批；紧急停止加主播全程值守；审计日志保留 6 个月；面向陌生观众之前开启阿里云输出审核。
- **提示注入或慢性投毒。**
  对策：删掉观众文本里的 < > [[ ]] 和换行；昵称只用 speakName；回声检测；不做观众长期记忆，只保留 6 轮上下文。
- **费用失控：循环出错、刷屏、双舞台同时购音。**
  对策：购音由服务端按句子配额放行，每句只买一次，只有 primary 能买；TTS 账本和每日回复数两道上限；只有存在 primary 且未暂停时才生成；两家都只预充少量余额。
- **OBS CEF 与 Chrome 行为不同：隐藏源时冻结、半透明边缘发黑、Cubism 远程加载失败、speechSynthesis 无声。**
  对策：舞台强制 cloud，并设 browserFallback:false；Cubism 加载失败按退避重试并上报；按清单设置 SRGB Off、关闭不可见时关闭源；M1 验收里由用户实测这些行为。
- **dev 模式下 Vite 在服务重启时整页刷新舞台；production 下 stage.html 被 immutable 缓存，重建后会引用已删除的资源（server/app.mjs:246）。**
  对策：M1 修复缓存头；开播一律用 npm run live 的构建产物；直播期间不改代码。
- **进程崩溃后残留 .data/*.lock，使 tts-budget 进入不可恢复的 fail-closed 状态，云端语音全部失败（tts-budget.mjs:38、:94）。**
  对策：预检检测 lock 残留并在控制台给出处理说明；由用户确认没有其他进程在用后，再删除并重启。
- **本机控制接口被其他网页或进程调用。**
  对策：所有 /api/live/* 先过 checkLocalRequest；AIRI_LIVE 必须显式开启；线上部署不设这个变量。
- **默认人设写了「不说作为 AI 之类套话」，与法规要求如实承认是 AI 有冲突。**
  对策：直播规则明确覆盖：不说套话，但被问到时如实承认自己是 AI 角色；live-prompt 测试断言这条规则存在。
- **开放平台长连超过 7 天静默不再推送；7001/7002 冷却；进程崩溃后残留场次。**
  对策：每场直播重新 start；game_id 持久化，启动时先 end 残留场次；控制台显示最后一条事件距今多久，超时告警。
- **mock 彩排的声音不能代表 MiniMax 真实链路，因为 validateMp3 被绕过。**
  对策：M3 必须做一次真实合成并试听；M1 只验证舞台、口型和租约。

## 需要用户提供或完成的事

- 第 0 天：用主播本人账号到 open-live.bilibili.com/open-manage 申请个人开发者；建项目（优先「直播工具/插件」）；记录 app_id；创建开发版本；获取身份码。把四个 BILIBILI_OPEN_* 变量自己写进 .env.local，不要贴到对话里。
- M1：在推流 Mac（macOS 13 及以上）安装 OBS 32.2.x，按清单添加浏览器源，并回报各项验收结果；确认是否有第三方推流权限，没有的话安装直播姬 Mac 测试采集路径。
- M3 前：DeepSeek 预充 30–50 元，填 DEEPSEEK_API_KEY。MiniMax cn 确认 speech-2.8-turbo 的单价、中文计费方式和系统音色能否商用，预充约 50 元，设 MINIMAX_TTS_ENABLED=1、MINIMAX_TTS_DAILY_CHAR_LIMIT=30000。生成随机 ≥16 位的 AIRI_DEMO_ACCESS_CODE。逐次批准首次付费调用并试听。
- 拍板直播人设（年龄、边界、承认是 AI 的口径）和 AI 标识措辞；撰写直播间简介：AI 声明、模型如实写 DeepSeek/MiniMax、告知弹幕会在本地记录、Live2D 三句长版英文声明。
- 维护 .data/moderation/blocklist.txt（drop/crisis/avoid 三类）；在 B站后台设置屏蔽词，并请一位房管。
- 完成实名认证并开通直播间；每场亲自值守，头几场用手动审批。
- 可选：是否开通阿里云内容安全；开放平台迟迟不批时是否接受 blivechat 的公共转发服务。

## 费用估算

口径：每月 12 场，每场 2 小时，晚间闲时开播；约 1,900 次回复，每次约 50 字，合计约 9.5 万字。

分项：
- DeepSeek deepseek-flash：每次约 2.7k 输入 token（系统提示前缀可命中缓存）加约 100 输出 token，约 0.001–0.004 元/次，每月 2–8 元。
- MiniMax speech-2.8-turbo：cn 站单价未核实。按百炼 2 元/万字符约 19 元；按国际站约 4.3 元/万字符约 41 元；如果中文按 2 字符计费，约 82 元。
- 可选阿里云整段审核：约 3 元。
- 开放平台、OBS、直播姬、say 彩排：0 元。

典型合计：约 25–95 元/月。

硬上限：
- TTS 账本 30000 字符/天，按 2 倍预留，每天实际最多约 1.5 万字，约 6.5–13 元/天；
- 回复数每天 250 次，DeepSeek 不到 1 元/天；
- 两家预充余额就是最终兜底。
- 12 个开播日全部打满约 90–170 元，低于 200 元；每天都播的话，把 TTS 日上限降到 20000。
- M1、M2 阶段为 0 元。

## 待用户拍板的决定（附建议）

- **推流出口：OBS 直推，还是交给直播姬 Mac 开播？**
  建议：先在直播中心确认账号是否有第三方推流码（≥5000 粉）。没有的话，用直播姬 Mac 采集 OBS 虚拟摄像机或窗口，声音走 OBS 监听输出。
  理由：2025-05-26 起第三方开播需要 5000 粉。舞台页对两条路线都适用，但音频接法不一样，要在 M1 里实测。
- **开放平台项目类型和账号**
  建议：用主播本人账号申请开发者，项目类型优先选「直播工具/插件」，自用不上架。
  理由：未上架的应用只能连接开发者自己的直播间（5004）。按研究资料，插件类心跳超时 180 秒，单房间可开 5 个连接，也不和其他互动玩法冲突，但这一点需要在后台确认能否选择。
- **直播人设的年龄和承认 AI 的口径**
  建议：去掉「17–18 岁女高中生」，改成年龄不设定的数字角色；规则写明「不说套话，但被问时如实承认自己是 AI 角色」。
  理由：接收礼物的直播里使用未成年角色设定，和网络主播行为规范第 20 项、拟人化办法第十四条有张力；默认人设里「不说作为 AI」的写法需要被覆盖。只改文字，不改 Hiyori 的形象设计。
- **首播的输入来源**
  建议：开放平台审核期间先用人工转述模式（M3）首播，朋友在场，全程手动审批。
  理由：能最快验证整条链路和成本，公开弹幕在输入闸门（M5）完成之前不会进入 LLM。
- **每日硬上限**
  建议：MINIMAX_TTS_DAILY_CHAR_LIMIT=30000，LIVE_DAILY_REPLY_LIMIT=250；DeepSeek 预充 30–50 元，MiniMax 预充约 50 元。
  理由：按 12 个开播日全部打满估算约 90–170 元，在 200 元预算内；预充余额作为最终兜底。
- **什么时候开启阿里云输出审核**
  建议：朋友场先不开；切换到自动模式（M6）或面向陌生观众之前开启，只审整段回复，超时按不通过处理。
  理由：DeepSeek 没有审核接口，协议也把审核责任放在开发者身上；按每次约 0.0015 元算，每月只要几元。
- **开放平台迟迟批不下来怎么办**
  建议：两周内继续等，期间用人工转述；超过两周再考虑本地 blivechat（走作者的公共转发），不用网页端接口和 SESSDATA。
  理由：2026 年 B站对非公开 API 发过律师函、做过举报，网页端协议也频繁变动；blivechat 依赖第三方服务器的可用性。
- **开播时的运行模式**
  建议：开播一律用 npm run live（构建产物 + production），dev 模式只用于开发。
  理由：dev 模式下服务一重启，Vite 就会刷新 OBS 舞台；production 需要一个随机生成的体验码，但舞台走的是自己的购音路由，不需要体验码。
- **MiniMax 模型和音色**
  建议：用 speech-2.8-turbo 加官方系统音色，不克隆任何真人声音。
  理由：turbo 成本约是 hd 的六成；克隆真人声音有声音人格权风险（2024 年北京互联网法院判赔 25 万）。

## 待复核（研究可能过时或置信度低）

- B站开放平台：以下几点都要在 M4 用调试页和探针实测，现有资料不能作为依据。(1) 后台能否选「直播工具/插件」；(2) 心跳超时是否按项目类型分 60 秒和 180 秒；(3) 默认能收到哪些 cmd，LIKE 和 ENTER 是否要另外申请；(4) 5004 限制是否意味着开发者账号必须和直播间账号是同一个；(5) 4009 的频率限制具体是多少。
- 「第三方开播需 ≥5000 粉」的规则，以及直播姬 Mac「第三方开播模式」的实际能力，都可能已经变化，开播前以直播中心的官方说明为准。
- OBS 33.0 目前还在 RC 阶段（CEF 150 加 Chrome Runtime）。如果在开播前正式发布，浏览器源的本地请求、刷新、存储，以及没有 SwiftShader 回退时 WebGL 能否创建，都要重新验证。本计划的结论都基于 32.2.2 / CEF 127。
- 以下 OBS 行为都还没在用户机器上测过：半透明边缘发黑（obs-browser #469 未关闭）；隐藏源时 document.hidden 的表现；speechSynthesis 的声音能否进入混音。
- MiniMax 有几件事没在 cn 站核实：speech-2.8-turbo 的单价、中文按几个字符计费、系统音色能否商用。另外 aigc_watermark 只对非流式合成生效。
- DeepSeek：deepseek-flash 的型号名、闲时和峰时价格可能会调整。「没有内容安全错误码」这个判断只来自错误码文档。
- 阿里云 llm_response_moderation 的价格（15 元/万次）、个人账号能否开通、实际延迟都没实测；智谱 1.2 元/万次没有核实。
- 法规适用都是保守解读，不是法律意见：拟人化互动办法是否适用于一对多直播和个人主播；生成式 AI 应用是否需要登记；B站直播目前没有找到 AI 主播的专门细则或 AI 声明开关。
- Live2D 条款以日文版为准，而且没有提到直播或 AI 驱动；1000 万日元门槛的解读来自英文版和 FAQ。
- blivechat 的公共转发、LAPLACE Event Bridge 的上游实现、tiny-bilibili-ws 所依赖的网页端协议，都可能随时失效，只适合当备选或调试用。
- 官方 JS demo 的 x-bili-timestamp 用的是毫秒，与鉴权文档要求的秒相矛盾。实现以文档为准，但第一次 start 失败时先查这里。
- 我新增的假设：mock 让 say 生成的 WAV 挂着 mp3 标签，依赖 Chromium 的 decodeAudioData 按内容嗅探。这一点要在 Chrome 和 OBS CEF 127 里各实测一次。另外 Vite 8.2.1 已改用 build.rolldownOptions，以后升级 Vite 时要再核对一次。

## M1 实施简报

M1 实施简报：OBS 舞台闭环（零凭据、零费用）

目标
打通这样一条链路：控制台输入一句话 → 服务端建立回合 → SSE 推给 OBS 舞台 → 舞台逐句向服务端取音（服务端只放行本回合已计划的句子，每句一次，且只给 primary）→ Live2D 口型、字幕、声音 → 舞台回报播放结果。
TTS 用 macOS 自带的 say 冒充，不需要 B站、DeepSeek 或 MiniMax 任何凭据。后续里程碑只替换「谁来产出要说的话」。

约束
- 不加 npm 依赖。
- App.vue 和 src/chat-turn-app.test.mjs 不动。
- /api/chat 和 /api/speech 的对外行为不变。
- 不传 live 时，/api/live/* 仍走现有的 404（server/app.mjs:76-77）。
- 测试一律注入 fetch 和时钟，不联网。
- pnpm 不在 PATH 上，统一用 node 和 ./node_modules/.bin。

0. 预备改动（行为不变）
0.1 package.json:9 的 test 改成：node --test 'server/**/*.test.mjs' 'src/**/*.test.mjs' 'shared/**/*.test.mjs' 'scripts/**/*.test.mjs'。已实测仍是 565 个测试。
0.2 tsconfig.json 加 "erasableSyntaxOnly": true。已实测 vue-tsc 通过，作用是防止服务端 import 的 .ts 被写出 Node 擦除不掉的语法。
0.3 vite.config.ts 加 build.rolldownOptions.input = { main: index.html, stage: stage.html, console: console.html }，路径用 fileURLToPath 转成绝对路径。注意 Vite 8.2.1 已把 rollupOptions 标为 deprecated。
0.4 server/app.mjs:246 改为：所有 .html 都发 Cache-Control: no-cache。现在只有 index.html 是 no-cache，stage.html 会被标成 immutable 缓存一年，重新构建后 OBS 会引用已删除的资源。server/index.test.mjs 补一个用例。
0.5 server/speech.mjs 从 handle() 抽出 synthesise({text, delivery}, {signal})，挂在返回对象上：
- 执行顺序：未配置抛 SpeechProviderError('TTS_NOT_CONFIGURED') → active>=4 抛 TTS_BUSY → normaliseSpeechRequest → 合并超时与调用方 signal → budget.reserve(estimateReservation) → provider.synthesise。
- handle() 保留限流、体验码校验、读 JSON 和 provider/region 一致性检查，之后调用同一段内部逻辑。
- 两条路径共用同一个 active 计数。
- :118-131 的状态码映射抽成导出函数 speechErrorResponse(error, {timedOut})，返回 {status, code}。
- 现有 server/speech.test.mjs 必须原样通过。另加用例：直接调用 synthesise 时预留 2×字数；未配置时不预留；超时映射到 504。
0.6 createRequestHandler 增加两个可选参数：
- speech：带 {health, handle, synthesise} 的实例。缺省时按 :40-45 自建。
- live：工厂函数 ({speech, config, env}) => {handle(request, response, pathname): Promise<boolean>, health(), stop()}。
- 在 :76 之前，如果 live 存在且 pathname 以 /api/live/ 开头，交给 live.handle 处理。只有传了 live 时，/api/health 才多出 live 字段。
- 加测试：不传 live 时，/api/live/state 返回 404，/api/health 里没有 live 键。
0.7 src/cloud-speech.ts：把 fetchCloudSpeech 从 :414 起的部分（aborted 检查、!response.ok 走 httpError、readBoundedJson、payload 校验、decodeAudio、validateDecodedAudio）抽成导出函数 decodeCloudSpeechResponse(response, {signal}, dependencies)，fetchCloudSpeech 改为调用它。:387 的解码能力检测导出为 canDecodeCloudSpeech(dependencies)。加契约测试：collectMinimaxStream 的输出包成 Response 后，经它解码（注入 decodeAudio）能得到 clip。
0.8 src/speech.ts（向后兼容）：
- 导出类型 SpeechRunOutcome = played | partial | failed | cancelled | empty。
- speak 增加可选的第 6 个参数 {onEnded}。
- dependencies 增加 browserFallback，默认 true。
- 实现：维护一个 pendingEnd {token, fire}，由 settle(token, outcome) 触发，同一 token 只触发一次。各触发点：
  - cancel()（:477）在 run++ 之前报 cancelled；
  - onError（:285）先报 failed，再调 cancel；
  - 空文本，以及 synthesizeInput 中 first.done（:703），报 empty；
  - advance 收尾分支（:378-389）装好整段回放源后，synthesisSucceeded 为真报 played，否则报 partial；
  - speak 的 catch 中，若 browserFallback===false，则 onPreparing(false)、onProblem('云端语音失败，本句已跳过。')，报 failed 后直接返回，不调用 browserSpeech；
  - 浏览器朗读结束报 played；
  - beginStream 同样遵守 browserFallback。
- 新测试复用 AudioStub（:9-37）和 :86 的 window 桩：
  - 两句播完只触发一次 played；
  - 播放中 cancel 报 cancelled；
  - 新的 speak 顶掉旧的，旧的报 cancelled；
  - 首句失败且关闭回退时报 failed，且 speechSynthesis.speak 调用 0 次；
  - 第二句失败报 partial；
  - 纯符号文本报 empty；
  - audio error 报 failed。
0.9 src/live2d.ts 的 mountHiyori 增加 autoInteract 选项（默认 true）。为 false 时，:40 的 autoInteract 设为 false，并且不注册 :72-74 的点击 Tap。

1. 服务端（server/live/）
1.1 local-request.mjs 提供 checkLocalRequest(request, {port}) 和 readSmallJson(request, 2048)：
- socket.remoteAddress 必须是 127.0.0.1、::1 或 ::ffff:127.0.0.1。不要用 clientIp，它信任回环连接上的 X-Real-IP。
- 不能带 x-real-ip、x-forwarded-for、forwarded 头。
- Host 只能是 127.0.0.1:PORT、localhost:PORT 或 [::1]:PORT。
- 带 Origin 时必须等于 http:// 加 Host。
- POST 还必须是 application/json，并带 X-Airi-Live: 1。
- GET（EventSource）不要求这个头。
1.2 sse.mjs 实现 createSseChannel({heartbeatMs:15000, maxBufferedBytes:262144, timers})：
- 响应头：text/event-stream; charset=utf-8、Cache-Control: no-cache, no-store、X-Accel-Buffering: no、nosniff；调用 flushHeaders。
- 首帧写 retry: 2000。之后每帧带 id（自增）、event、data（JSON）。
- writableLength 超过上限时直接断开该客户端。
- ': ping' 心跳只在有客户端时运行，并 unref，保持导入模块无副作用（app.mjs:27-28）。
1.3 stage-bus.mjs：
- role 只能是 obs 或 preview。
- obs 连接拿到新的 leaseId 并成为 primary，旧的 primary 收到 standby。
- preview 的 leaseId 为 null。
- 连接后发 hello {leaseId, role, primary, mode}。
- publish 广播给所有客户端（preview 也收 say，只显示字幕）。
- 提供 primary()、isPrimary()、onPrimaryChange()、updateStatus()。
1.4 utterance.mjs：
- planUtterance({text, delivery, cues}) 直接 import ../../src/speech-sentences.ts 的 replySentenceStream，参数与 src/speech.ts:827 完全一致（userText 为空字符串），收集得到的 {text, delivery} 列表。
- createSentenceAllowance(list) 以 delivery 加 text 作键，建多重集合计数；take() 命中则减一并返回 true。
1.5 runtime.mjs 实现 createLiveRuntime({env, config, speech, now, timers, newId})。
状态：control（running/paused/panic）、mode（live/brb）、turn（turnId、text、delivery、cues、allowance、看门狗）、lastOutcome。
路由（pathname 已去掉 /airi 前缀）：
- GET /api/live/stage/events?role=：primary 变化时，如果当前有回合，publish stop 并记为 cancelled。
- POST /api/live/stage/report {leaseId, type}：type 为 ready、avatar{status}、ended{turnId, outcome}、problem{message，最多 120 字}、obs{active, visible, streaming}。非 primary 返回 403；ended 匹配当前回合时清看门狗、记录结果、结束回合；正常返回 204。
- POST /api/live/stage/speech {leaseId, turnId, text, delivery}：非 primary 返回 403；回合不匹配或 take 失败返回 409 LIVE_SENTENCE_NOT_ALLOWED；否则调用 speech.synthesise（请求 close 时 abort），返回与 /api/speech 相同的 JSON。错误用 speechErrorResponse 映射，不回显文本。
- GET /api/live/state：返回 control、mode、primary 摘要和 preview 数量、当前回合、lastOutcome、speech.health()。
- POST /api/live/control：
  - say {text, delivery?}：前提是 control 为 running、有已 ready 的 primary、当前没有回合，否则返回 409，错误码分别为 LIVE_PAUSED、LIVE_NO_STAGE、LIVE_TURN_ACTIVE。去掉控制字符后长度需在 1–200 字；含 [[ 或 ]] 返回 400。delivery 只能是 neutral/soft/bright/curious。planUtterance 得到 0 句返回 400 LIVE_EMPTY。成功后 publish say {turnId, text, delivery, cues: [], replyTo: null}，看门狗时长为 min(90 秒, 15 秒 + 每字 350 毫秒)，超时则 publish stop 并记为 timeout。
  - stop、pause、resume（同时把 mode 恢复为 live）。
  - panic：执行 stop，control 置 panic，mode 置 brb。
  - reload-stage。
- health() 只报告启用状态、control、primary 是否在线、头像状态、最后一条事件距今多久。
- stop() 清理所有回合、SSE 和定时器。
1.6 server/index.mjs：
- AIRI_LIVE 等于 '1' 时，HOST 必须是回环地址，否则抛错。
- 用工厂函数创建 runtime。
- 收到 SIGINT/SIGTERM 时，先 await runtime.stop()，再 server.close()。
- 日志只打印 Live mode: enabled，不打印任何变量值。

2. scripts/mock-live.mjs（零费用彩排）
- 写法仿照 mock-voice-app.mjs：Vite middleware（envDir:false，不读 .env.local），监听 127.0.0.1:4176，使用真实的 createRequestHandler 和 createLiveRuntime。
- 注入假 speech：health() 返回 configured:true、provider minimax、model mock-say、region cn。
- synthesise 的做法：把文本写进临时文件，用 execFile 调 /usr/bin/say（不经过 shell），参数为 -v 声线、-f 文本文件、-o 输出 wav、--file-format=WAVE、--data-format=LEI16@32000。读回 WAV 后返回 {audio: base64, format: 'mp3', sampleRate: 32000, words: []}。
- 为什么这样做：本机没有 MP3 编码器（afconvert 编 MPG3 报 fmt?，也没有 ffmpeg 或 lame），而 server/minimax.mjs:315-352 的 validateMp3 只接受 32kHz 单声道 MPEG-1 Layer III。假 speech 绕过了这层校验，浏览器的 decodeAudioData 会按内容嗅探解出 WAV。脚本头部要注释写明：format 标签是故意写错的，仅限 mock。已实测 say 能产出 32kHz、Int16、单声道 WAV。
- 声线：默认取 say -v '?' 里第一个 zh_CN 声线（本机有 Eddy、Flo、Grandma），MOCK_SAY_VOICE 可覆盖。say 失败时退回 JS 生成的 1 秒调幅正弦 WAV，振幅要高于静音门限。
- 只打印字数，不打印文本。

3. 前端
3.1 stage.html（放在仓库根目录）：
- 结构：#stage 里包含 #avatar、#caption、#ai-badge（文案「AI 生成内容 · 回复可能出错」）、#brb（「稍后回来」，默认 hidden），外加一个隐藏的 audio#voice。
- script 指向 /src/stage/main.ts。
- 不引入 src/style.css，因为它的 :root 带 #eee8e3 背景。
3.2 src/stage/stage.css：
- html、body、#stage 背景 transparent !important，margin 0，100vw × 100vh，overflow hidden。
- 字幕：底部居中，PingFang SC 44px 白字，用 paint-order: stroke 加 -webkit-text-stroke 描深色边，最多两行。
- AI 角标常驻左上角。
- 禁止任何 filter、blur、backdrop-filter。
- URL 参数 captions=0 可关闭字幕。
3.3 src/stage/stage-client.ts（不依赖 DOM，可在 Node 里测）：
- 构造：createStageClient({role, openEvents, post, speech, view, timers})。
- 维护状态：leaseId、primary、currentTurn。
- hello：primary 时上报 ready。
- standby：调用 speech.cancel() 并清空字幕。
- say：先显示字幕。非 primary 到此为止。primary 时调用 speak(text, delivery, DEFAULT_VOICE, cues, 'cloud', {onEnded})，onEnded 里上报 ended，played 后 1.2 秒清掉字幕。
- stop：只处理 turnId 匹配的回合。
- mode=brb：cancel 后显示 #brb。
- reload：交给 view 处理。
- 断线：EventSource 关闭后按 1/2/4…30 秒退避重连，靠新的 hello 重新领租约。
- 提供 synthesizeCloud(sentence, signal)：没有当前回合或不是 primary 时抛 SpeechApiError；否则 POST 到 BASE_URL 下的 api/live/stage/speech，选项为 same-origin、redirect error、no-store，头带 Content-Type 和 X-Airi-Live，body 为 {leaseId, turnId, text, delivery}，返回 decodeCloudSpeechResponse 的结果。
3.4 src/stage/main.ts：
- role 由 URL 指定；未指定时，存在 window.obsstudio 则为 obs，否则为 preview。
- createSpeechController(audio, callbacks, {synthesizeCloud, browserFallback: false})。
- callbacks 的写法照抄 App.vue:157-187 和 :221-231：onMouth 驱动 setMouth；onPlaying 切换 speaking/idle；onDelivery 经 createAvatarContext 调 setDelivery；onProblem 非空时上报 problem，用来发现自动播放被拦截。
- 头像：loadAvatarModule 后 mountHiyori(#avatar, {autoInteract: false, renderProfile: 'auto'})。失败按 2/4/8/16/32/60 秒退避重试，每次结果都上报 avatar。
- 如果有 window.obsstudio，监听 obsSourceActiveChanged、obsSourceVisibleChanged、obsStreamingStarted/Stopped，上报 obs。M1 只记录，不做门控。
3.5 console.html、src/console/main.ts、ConsoleApp.vue、console-api.ts：
- 每秒 GET 一次 state，显示舞台租约、ready、头像、OBS 状态，以及当前回合和上一次结果。
- 一个文本框、一个语气下拉，按钮：说、停下、暂停、继续、紧急停止、刷新舞台。
- 所有 POST 都带 X-Airi-Live: 1。

4. 测试（node:test + assert/strict）
- local-request：干净的回环请求放行；以下情况返回 403：带 X-Real-IP、Host 是 evil.test、外域 Origin、缺自定义头、text/plain；超过 2KB 返回 400。
- sse：首帧是 retry；id 自增；只在有客户端时有心跳且已 unref；慢客户端被断开。
- stage-bus：新的 obs 连接接管 primary，旧连接收到 standby；preview 的 leaseId 为 null；旧租约上报返回 403。
- utterance：与 replySentenceStream 的输出逐项相同（覆盖多语气 cues 和纯符号）；重复的句子能按次数购买，超出次数或未计划的句子被拒。
- runtime：用 createServer(createRequestHandler({env, fetchImpl: unexpectedFetch, speech: fake, live: deps => createLiveRuntime(...)})) 监听 0 端口，用 fetch 的 getReader 解析 SSE（Node 没有 EventSource）。覆盖：没有舞台时 say 返回 409；舞台 ready 后能收到 say；按句购音时 synthesise 调用次数等于句数，重复购买返回 409 且不再调用；preview 和旧租约返回 403；ended 后状态变为 played；看门狗超时发 stop；panic 之后 say 返回 409。
- 0.4–0.9 各项的新增用例。
- stage-client：使用假的 EventSource、post 和 speech。覆盖：primary 调 speak 时 engine 为 cloud；onEnded 带回 turnId；preview 不调用 speak；standby 触发 cancel；购音请求带上 leaseId 和 turnId；断线后退避重连。

5. 验收
离线：
- npm test（新的 glob）全部通过，且测试数不少于 565 个原有测试加新增测试；vue-tsc 通过；vite build 产出三个 html。
- 运行 node scripts/mock-live.mjs，在 Chrome 打开 /airi/stage.html?role=obs（先点一下页面，或用 --autoplay-policy=no-user-gesture-required 启动 Chrome）和 /airi/console.html。说一句话后应能听到声音、看到口型和字幕，控制台显示 played。
- 再开一个 obs 标签页，旧页变为 standby；preview 只显示字幕；长句中途停下返回 cancelled；紧急停止后显示 brb。
需用户（约 30 分钟，不花钱）：
- 在 OBS 32.2.x 添加浏览器源 http://127.0.0.1:4176/airi/stage.html?role=obs，1920×1080；勾选「通过 OBS 控制音频」；关闭「不可见时关闭源」和「场景激活时刷新」；监听设为「监听并输出」。
- 逐项回报：背景是否透明；角色是否渲染（空白时用 --remote-debugging-port=9222 配合 chrome://inspect 查看）；不点击能否出声；混音器里是否只有一路声音；口型是否同步；改为 SRGB Off 后有没有黑边；切走场景再切回后角色是否冻结；1080p30 是否丢帧。
- 同时确认推流出口：OBS 直推，还是交给直播姬 Mac 开播。

不在 M1 范围：LLM、弹幕、审核、审计、B站接入、构图预设、逐句流式。

## 附：调研要点

### bilibili：自托管 Node 24 程序如何接收 B站直播间弹幕/礼物/SC/上舰/点赞/进房事件（2026 年末现状：官方开放平台 vs 网页端非官方长连 vs 开源库）

**建议**：第一阶段正式接入走官方开放平台，在 airi-lite 的 Node 24 服务端自己写一个零依赖客户端，不引第三方库。具体如下：
(1) 新增模块：
- server/bilibili/sign.mjs：纯函数，输入 body、key 和 secret，生成签名 header。按鉴权文档的示例向量写单测，时间戳用秒。
- server/bilibili/packet.mjs：encode/decode 16 字节大端包头，按 version 0/1/2/3 处理（zlib.inflateSync / brotliDecompressSync），要能递归拆多包。用 node:test 覆盖。
- server/bilibili/open-live.mjs：生命周期，start → 每 20s 项目心跳 → end，收到 SIGINT/SIGTERM 时必须调 end；处理 7001（等 10s 重试）、7002（等 60s 或先 end）、7003 和 INTERACTION_END（重新 start）。
- server/bilibili/ws-client.mjs：用全局 WebSocket 连 wss_link[0]，失败轮换下一个；先发 op7 auth_body，每 20s 发 op2；断线指数退避重连，重连时复用 auth_body；超过 1-2 次失败就重新 start 换新的 game_id。
- server/bilibili/events.mjs：把 LIVE_OPEN_PLATFORM_* 统一成内部事件 {kind: danmaku|gift|superchat|superchat_del|guard|like|enter|live_start|live_end, user:{openId, name, guardLevel, medalName, medalLevel, isAdmin}, text, amountCny, msgId, ts}，按 msg_id 去重。金额换算：礼物 r_price/1000×gift_num，SC 的 rmb 本身就是元，上舰 price/1000。
(2) 配置写进 .env.local（只放服务端）：BILIBILI_OPEN_ACCESS_KEY_ID、BILIBILI_OPEN_ACCESS_KEY_SECRET、BILIBILI_OPEN_APP_ID、BILIBILI_OPEN_IDCODE。/api/health 只报连接状态，不回显密钥。
(3) 进“大脑”之前：SC 和上舰优先；收到 SUPER_CHAT_DEL 时，把未念的那条 SC 从队列删除，已念的不再重复；dm_type=1 的表情包弹幕和 MIRROR 跨房弹幕不进 LLM；礼物按 combo/用户做 3-5 秒窗口合并后再感谢；进房和点赞只做低频汇总，不逐条回应。
(4) 开发联调用开放平台“版本管理 > 调试页面”模拟推送，再加录制的 JSON fixture 做单测。
(5) 项目类型优先建“直播工具/插件”而不是“互动玩法”：心跳超时 180s，单房间可开 5 个连接，不会和其他互动玩法冲突。这一点需要用户在后台确认是否可选。

备选方案 A（等待开发者审核期间或密钥申请被拒时）：在 macOS 上从源码本地运行 blivechat，不配置开放平台密钥，填入身份码。它会经作者的公共服务器走官方通道。airi-lite 用 WebSocket 连 ws://localhost:12450/api/chat，发 JOIN_ROOM，roomKey 为 {type:2, value:身份码}，然后消费 ADD_TEXT、ADD_GIFT、ADD_MEMBER、ADD_SUPER_CHAT、DEL_SUPER_CHAT。代价是依赖第三方服务器的可用性。

备选方案 B（只用于开发调试，不用于正式直播）：用 tiny-bilibili-ws@1.1.1 匿名连接网页端，用户名打码可以接受。不要把主播主号的 SESSDATA 交给程序。考虑到 2026 年 B站对非公开 API 的律师函、举报，以及 -352 风控和 protobuf 改版，网页端只能作临时管道测试。

另外，第一阶段规划要先确认账号是否有 OBS 第三方推流权限（≥5000 粉）。没有的话，改成用直播姬 Mac 版采集 OBS 画面（虚拟摄像头或窗口捕获），弹幕接入方案不受影响。

- [high] 官方开放平台文档（开放平台-直播&互玩接入文档）的目录接口显示最后修改时间为 2026-10-13，说明文档仍在维护。SPA 页面抓不到正文，但 member.bilibili.com/arcopen/user/open-doc/view?id=13 会返回每篇文章的 md_url。（来源：https://member.bilibili.com/arcopen/user/open-doc/view?id=13）
- [high] 个人和企业开发者都可以入驻。入驻入口是 open-live.bilibili.com/open-manage，审核通过后 access_key_id 和 access_key_secret 会通过邮件发放，官方写需要 3-5 个工作日。开放平台与“直播创作者服务中心”的鉴权已解耦，需要单独申请开发者权限。（来源：https://open-live.bilibili.com/document/849b924b-b421-8586-3e5e-765a72ec3840 ; https://open-live.bilibili.com/document/bdb1a8e5-a675-5bfe-41a9-7a7163f75dbf）
- [high] app_id 就是项目 ID（int64，13 位，JS 的 Number 能安全表示），在“服务中心 > 创建项目”里获得。项目上架审核需要 1-3 或 3-5 个工作日（两处文档说法不一），但自用不必上架：未上架的应用只能连接开发者自己的直播间（错误码 5004/5011）。所以开发者账号最好就是主播本人的账号。（来源：https://open-live.bilibili.com/document/74eec767-e594-7ddd-6aba-257e8317c05d ; https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e）
- [high] 身份码(code)是主播授权令牌，有两种获取方式：一是在 play-live.bilibili.com 右侧“身份码”处获取，前提是至少获取过一次任意玩法/插件/工具；二是粉丝数 ≥50 时在直播中心“开始直播”处获取。主播可随时刷新身份码，每分钟最多刷新一次。（来源：https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e）
- [high] 签名规则：所有接口都 POST JSON 到 https://live-open.biliapi.com（测试域名不可用，会报 4001）。必须带的 header 有 Accept/Content-Type=application/json、x-bili-accesskeyid、x-bili-content-md5（请求体字符串的 MD5 hex）、x-bili-signature-method=HMAC-SHA256、x-bili-signature-nonce（建议 UUID，重复会报 4004）、x-bili-signature-version=1.0、x-bili-timestamp（单位秒，与服务器时间相差超过 10 分钟会被丢弃）。待签名串是把 x-bili-* 按字典序写成 key:value，用 \n 拼接，首尾都没有换行；用 secret 做 HMAC-SHA256，得到小写 hex 放进 Authorization（不加前缀）。HTTP 状态码恒为 200，成败要看 body.code。（来源：https://open-live.bilibili.com/document/74eec767-e594-7ddd-6aba-257e8317c05d ; https://raw.githubusercontent.com/xfgryujk/blivedm/dev/blivedm/clients/open_live.py）
- [high] 项目生命周期（v2）：POST /v2/app/start，body 为 {code, app_id}，返回 data.game_info.game_id、data.websocket_info.auth_body（原样使用）、wss_link[]（多集群，失败时切换下一个）和 anchor_info{room_id, uname, uface, uid, open_id, union_id}。之后每 20s 调一次 /v2/app/heartbeat {game_id}；超过 60s（互动玩法）或 180s（插件/工具）没有心跳，场次会自动关闭并停止推送。结束时调 /v2/app/end {app_id, game_id}。另有 /v2/app/batchHeartbeat {game_ids}，单次少于 200 个。旧的 v1 互动玩法 API 已逐步停止支持。（来源：https://open-live.bilibili.com/document/eba8e2e1-847d-e908-2e5c-7a1ec7d9266f）
- [high] 已公开的限制：同一直播间同时只能开一个“互动玩法”，没有正常 end 的话要隔 1 分钟以上才能再开（7002 房间重复游戏、7001 冷却期，建议 10s 后重试）。同一插件/工具在单个直播间最多 5 个连接（7010）。进房事件按服务负载限流，但不低于 10 QPS。长链连接超过 7 天会静默不再推送。另有 4009“接口访问限制/频率”，文档没有给出具体配额数字。（来源：https://open-live.bilibili.com/document/eba8e2e1-847d-e908-2e5c-7a1ec7d9266f ; https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e ; https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8）
- [high] 长链协议：连接 wss_link 后，第一个包是 OP_AUTH(7)，body 为 auth_body 原文。包头 16 字节、大端：[uint32 packetLength 含头][uint16 headerLength=16][uint16 version][uint32 operation][uint32 sequence，可忽略/填 1]。version=0 表示 body 是 JSON；version=2 表示 zlib 压缩，解压后可能是多个完整包，需要递归拆包。blivedm 同时兼容 version=3（brotli）。operation 取值：2 心跳、3 心跳回复、5 业务消息、7 鉴权、8 鉴权回复。要维持两种心跳：WS 心跳（body 为空）和 HTTP 项目心跳。文档正文写 20s，表格写 30s，服务端 30s 内收不到心跳就断开，所以建议两种心跳都按 20s 发。（来源：https://open-live.bilibili.com/document/657d8e34-f926-a133-16c0-300c1afc6e6b ; https://raw.githubusercontent.com/xfgryujk/blivedm/dev/blivedm/clients/ws_base.py）
- [high] 开放平台的 cmd 及关键字段如下。LIVE_OPEN_PLATFORM_DM：uname、uface、open_id、msg、msg_id、guard_level、fans_medal_*、dm_type（1=表情包）、emoji_img_url、is_admin、reply_open_id/reply_uname、glory_level；uid 已废弃，固定为 0。_DM_MIRROR：跨房弹幕，不含发送人信息。_SEND_GIFT：price/r_price 中 1000=1元，另有 paid、gift_num、combo_info、blind_gift。_SUPER_CHAT：rmb（单位元）、message、message_id、start_time/end_time。_SUPER_CHAT_DEL：message_ids，表示风控撤回。_GUARD：guard_level 1总督/2提督/3舰长，guard_num，guard_unit，price 单位金瓜子。_LIKE：仅开播中触发，对单个用户按 2 秒聚合 like_count。另外还有 _LIVE_ROOM_ENTER、_LIVE_START、_LIVE_END，以及 _INTERACTION_END（game_id 已失效）。开放平台没有关注/分享事件，也没有在线人数。（来源：https://open-live.bilibili.com/document/f9ce25be-312e-1f4a-85fd-fef21f1637f8）
- [high] 开放平台下发的用户名是明文，不会打码，用户以 open_id 标识（取代 uid）。open_id 由 uid、开发者和应用共同生成：同一应用下跨房间不变，换应用就会变。union_id 默认为空，需要单独申请开通；该字段是 2026 年新增的，blivedm 在 2026-08-11 跟进。（来源：https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e ; https://github.com/xfgryujk/blivedm/commits/dev）
- [medium] 快速开始文档写着：“第三方通过长连接收到的消息类型，需要提前与B站运营申请”，开发者默认是 client 模式（一房一连）。社区实践（blivedm、blivechat）中，默认账号能收到弹幕和礼物；点赞/进房是否需要另行开通，没有找到明确说法。（来源：https://open-live.bilibili.com/document/849b924b-b421-8586-3e5e-765a72ec3840 ; https://github.com/xfgryujk/blivedm/issues/53）
- [medium] 官方提供调试手段：在应用“版本管理”里创建开发版本后，可以进入调试页面模拟推送长链消息；也有“测试直播姬”。直播姬拉起应用时会以 start.exe code=XXX 的形式传入身份码。（来源：https://open-live.bilibili.com/document/5dffc297-6fd2-41ff-bd45-6e8b89e2a68e）
- [medium] 官方 JS demo（2022 年的 zip）把 Date.now() 毫秒值当作 x-bili-timestamp，与鉴权文档要求的“秒”不一致。实现时以鉴权文档为准，Python 版 blivedm 用的也是秒。（来源：https://open-live.bilibili.com/document/a7bd5377-ad7d-a273-25ae-28caf37a7a85）
- [high] 《开放平台管理规范（细则）》8.4.1 规定平台项目“不得使用非公开的API的程序”。因此，同一个项目不要再混用网页端非公开接口。（来源：https://open-live.bilibili.com/document/f6017467-1182-fd2b-7a96-793b9afb911a）
- [high] 网页端非官方长连的流程：(1) 获取 buvid3，可以 GET https://www.bilibili.com/，或从 api.bilibili.com/x/frontend/finger/spi 取 data.b_3；(2) GET api.bilibili.com/x/web-interface/nav，取 wbi_img 的 img/sub key（登录时还能拿到 mid）；(3) 用 room/v1/Room/get_info 或 mobileRoomInit 把短号换成长号；(4) GET api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=<room>&type=0，并加 wbi 的 wts/w_rid（blivedm 在 2025-07 加入），拿到 token 和 host_list；(5) 连接 wss://host:port/sub；(6) 鉴权 JSON 为 {uid, roomid, protover:3, platform:'web', type:2, buvid, key:token}；(7) 每 30s 发 op2 心跳，body 为 '{}'，op3 回复中是 4 字节人气值；version=3 的消息是 brotli 压缩。（来源：https://raw.githubusercontent.com/xfgryujk/blivedm/dev/blivedm/clients/web.py ; https://unpkg.com/tiny-bilibili-ws@1.1.1/dist/index.mjs）
- [high] 匿名打码：约从 2023-06-30 起，未登录的网页端连接收到的用户名变成 ****，uid 和勋章信息为 0。服务端会推送 LOG_IN_NOTICE，内容为“为保护用户隐私，未登录无法查看他人昵称”。要看到完整昵称，必须提供已登录账号的 SESSDATA cookie。（来源：https://github.com/simon300000/bilibili-live-ws/issues/396 ; https://raw.githubusercontent.com/xfgryujk/blivedm/dev/sample.py ; https://github.com/xfgryujk/blivedm/issues/80）
- [high] 2025-2026 年网页端接口频繁变动：-352 风控出现在 2025-08、2025-09 和 2026-04，响应头带 X-Bili-Gaia-Vvoucher，十几小时后恢复，或更新 UA 后恢复；2026-03-14 疑似改了 wbi 签名，后来又回滚；2025-09 INTERACT_WORD 换成 protobuf 的 INTERACT_WORD_V2；2025-12 有人报告抓不到入场消息；2026-07 起灰度 SEND_GIFT_V2，data.pb 为 base64 编码的 protobuf，旧解析器会丢失礼物。（来源：https://github.com/xfgryujk/blivedm/issues/76 ; https://github.com/xfgryujk/blivedm/issues/81 ; https://github.com/xfgryujk/blivedm/issues/84 ; https://github.com/xfgryujk/blivedm/issues/85 ; https://github.com/xfgryujk/blivedm/commits/dev）
- [high] 法律/条款风险在上升。2026-01-28，B站委托律所向 bilibili-API-collect（约 2 万星）发律师函，理由是系统性收集、传播非公开 API，指控侵权和不正当竞争，该仓库随即永久关停。2026-08-03，lovelyyoshino/Bilibili-Live-API 称“被B站举报”并清空内容。2026-08-12，bilibili-live-ws 在 GitHub 发布的 v7 删除了网页端和 TCP 接入，只接受开放平台参数。（来源：https://www.ithome.com/0/917/481.htm ; https://github.com/SocialSisterYi/bilibili-API-collect ; https://github.com/lovelyyoshino/Bilibili-Live-API ; https://github.com/simon300000/bilibili-live-ws）
- [medium] SESSDATA 等同于账号登录凭证，Open-LLM-VTuber 文档也提醒不要泄露。用主播主号的 cookie 长期跑非官方接口，有触发风控或封号的风险。（来源：https://docs.llmvtuber.com/en/docs/user-guide/live/bilibili）
- [high] blivedm（Python，约 1.4k 星）仍然活跃：dev 分支 2026-08-15 发布 v1.1.7，同时支持 web 和 open_live，已适配 SEND_GIFT_V2、union_id 和跨房弹幕。注意不要用 PyPI 上的版本（README 说那是错误版本）。（来源：https://github.com/xfgryujk/blivedm ; https://github.com/xfgryujk/blivedm/commits/dev）
- [high] tiny-bilibili-ws（Node/TS，约 60 星）在 2026-10-14 发布了 1.1.1，是目前最新的 Node 网页端客户端。依赖只有 ws、pako 和 eventemitter3，要求 Node>=18。它内置 wbi 签名、buvid、getDanmuInfo 缓存和 -352 处理，能解码 SEND_GIFT_V2 的 protobuf，默认 protover=3、30s 心跳。它也接受 authBody/url 选项，可以接开放平台，但 authBody 会被原样 rawSend，需要自己先序列化成 op7 包。（来源：https://unpkg.com/tiny-bilibili-ws@1.1.1/dist/index.mjs ; https://registry.npmjs.org/tiny-bilibili-ws ; https://github.com/starknt/tiny-bilibili-ws）
- [medium] blive-message-listener（约 196 星）0.5.5 发布于 2026-05-10，基于 tiny-bilibili-ws，类型定义友好。但它没有处理 SEND_GIFT_V2，处于灰度的房间会丢礼物；它也只支持网页端。（来源：https://unpkg.com/blive-message-listener@0.5.5/dist/index.cjs ; https://github.com/ddiu8081/blive-message-listener）
- [high] bilibili-live-ws 在 npm 上停在 6.3.1（2023-07），GitHub 上的 7.0.0 已改为纯开放平台长连客户端，但还没发布到 npm。bili-live-listener 仍依赖它的 6.x 网页端版本。（来源：https://registry.npmjs.org/bilibili-live-ws ; https://github.com/simon300000/bilibili-live-ws）
- [high] Project AIRI 目前没有可用的 B站弹幕实现可以参考：plugins/airi-plugin-bilibili-laplace 只有一行 console.warn('WIP')，原本打算接 LAPLACE Event Bridge；仓库 2026-10-06 的 ADR 说明这个包无人引用，已被移除。（来源：https://github.com/moeru-ai/airi/blob/main/plugins/airi-plugin-bilibili-laplace/src/index.ts ; https://github.com/moeru-ai/airi/blob/main/docs/ai/adr/2026-10-06-home-assistant-integration.md）
- [high] Open-LLM-VTuber 用的是 blivedm 的网页端 BLiveClient，SESSDATA 可选，只把弹幕转给 LLM，没有处理礼物和 SC，弹幕多时会积压。（来源：https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/live/bilibili_live.py ; https://docs.llmvtuber.com/en/docs/user-guide/live/bilibili）
- [high] blivechat（约 2.7k 星，v1.10.4，2026-08）已在 B站商店上架。本地运行时如果不填 open_live_access_key_id/secret/app_id，start 和心跳请求会转发到作者的公共服务器，也就是只用身份码、不需要自有密钥也能走官方通道（api/open_live.py:57）。本地 /api/chat WebSocket 使用 JSON 命令：HEARTBEAT=0（10s）、JOIN_ROOM=1（roomKey.type 中 AUTH_CODE=2）、ADD_TEXT=2、ADD_GIFT=3、ADD_MEMBER=4、ADD_SUPER_CHAT=5、DEL_SUPER_CHAT=6。（来源：https://github.com/xfgryujk/blivechat/blob/dev/data/config.example.ini ; https://github.com/xfgryujk/blivechat/blob/dev/api/open_live.py ; https://github.com/xfgryujk/blivechat/blob/dev/api/chat.py）
- [medium] LAPLACE Event Bridge（2026-10 仍在更新）会把 LAPLACE Chat 仪表盘或 event-fetcher 收到的 B站事件，经本地 WS（默认 9696）转发给客户端，有 npm SDK @laplace.live/event-bridge-sdk 1.2.2。它依赖第三方的 LAPLACE Chat，我没能查实其上游连接方式和收费情况。（来源：https://github.com/laplace-live/event-bridge ; https://registry.npmjs.org/@laplace.live/event-bridge-sdk）
- [high] 本机 Node v24.21.0 自带全局 WebSocket、fetch、node:zlib（inflate 和 brotliDecompress）以及 crypto，可以零依赖实现开放平台客户端。airi-lite 当前没有任何 B站相关代码，也没有 ws 依赖。（来源：/Users/chenqiang/projects/airi-lite/package.json:13-24 ; 本地命令 node -e 输出 'function function function function'）
- [medium] 与第一阶段的 OBS 推流直接相关：B站从 2025-05-26 起要求粉丝数 ≥5000 才能获得第三方开播（推流码）权限，不足的只能用 PC 直播姬、手机 App 或 web 开播。直播姬有 Mac（Apple 芯片）版 V7.24.0（2026-05-14）。（来源：https://www.ithome.com/0/852/429.htm ; https://sj.qq.com/appdetail/1104972505）

**未决问题**
- 默认开发者账号能否直接收到全部 cmd（尤其 LIVE_OPEN_PLATFORM_LIKE 和 LIVE_ROOM_ENTER）？还是需要按快速开始文档所说“提前与B站运营申请”消息类型？
- 未上架的自用应用，选“直播工具/插件”和选“互动玩法”在后台是否都能创建并调用 /v2/app/start？心跳超时（180s 和 60s）是否按项目类型区分？
- 开发者账号是否必须和直播间账号是同一个？5004 的说明是“未上架的应用，只能连接开发者自己的直播间”，需要实际验证跨账号会不会被拒。
- 主播刷新身份码后，正在进行的 game_id 是否立即失效？
- 4009 接口频率限制的具体数值，文档没有公开。
- 粉丝不足 5000 时，“哔哩哔哩直播姬第三方开播模式”能否让 OBS 画面合规推流？
- blivechat 公共转发服务器能否长期稳定可用，以及其使用条款。
- LAPLACE Chat 上游接 B站时用的是登录 cookie 还是开放平台身份码，是否收费。
- SEND_GIFT_V2 的灰度会不会在开放平台侧引发类似的字段变化？目前开放平台礼物仍是 JSON，blivedm 在 2026-08-12 修过一次开放平台礼物解析错误。

### obs：在 macOS 上把角色作为 OBS Studio 浏览器源（Browser Source）用于 B 站直播（2026 年 10 月现状）及 airi-lite 的 stage 模式适配

**建议**：阶段 1 建议把舞台页做成一个只负责渲染和播放的『哑终端』。大脑（弹幕挑选、DeepSeek、审核、TTS 预算）全部放在 Node 服务端，舞台页不承担任何决策逻辑。

一、新增独立入口，不要往 App.vue 里加模式分支。
- 新建 stage.html、src/stage/main.ts 和 StageApp.vue，在 Vite 的 build.rollupOptions.input 里加上 stage 入口。
- 访问地址形如 http://127.0.0.1:PORT/airi/stage.html?layout=bust&anchor=right&captions=1&fps=30。
- 舞台页不引入 style.css 的 :root 背景，自带 `html, body, #app { background: transparent !important; margin: 0; overflow: hidden; width: 100vw; height: 100vh }`。
- 页面上不放聊天 UI、品牌、状态胶囊和 audio controls。版权署名做成可选的小角标（credit=1）。

二、头像改动：
- mountHiyori 增加 autoInteract、framing 选项：舞台模式下关闭鼠标跟随和点击 Tap；构图预设分 full、bust、upper 三种，再加 left/center/right 锚点。
- 在 OBS 里固定 1920x1080（横屏），或 1080x1920（B 站竖屏）。
- 渲染预算用 renderProfile=auto，maxFPS 跟 OBS 画布帧率一致（建议 30）。OBS 里 DPR 是 1，不需要额外处理。
- 页面里不要用 CSS blur 或 filter。
- Cubism Core 加载失败时按退避策略自动重试，并上报服务端。是否把 Core 放到本地托管，取决于 Live2D 许可。

三、音频改动：
- 舞台复用 createSpeechController，但强制 engine='cloud'，或者将来改成服务端产出音频后舞台按 id 拉取。
- 禁止加载 Kokoro，也禁止回退到 speechSynthesis。云端失败时只显示字幕并上报错误。
- audio 元素隐藏。只有舞台页出声，控制面板不播语音，避免出现双声。
- OBS 端：勾选 Control audio via OBS；监听设为『监听并输出』；音频采样率 48kHz；不要再用桌面音频采集同一路声音。

四、控制通道用零依赖方案：
- GET /api/stage/events（SSE），服务端发给舞台的事件：say {id, text, cues, delivery, replyTo, caption}、stop、activity（thinking/idle）、reaction、reload，带 event id 和 retry，断线重连后先下发一次快照。
- POST /api/stage/status，舞台上报：ready、avatar-loaded/failed、utterance-started/ended（带 id）、error，以及 obsstudio 事件 obsSourceActiveChanged、obsSourceVisibleChanged、obsStreamingStarted/Stopped。
- 这些接口只接受回环地址，不走 URL 里的体验码。现有的 production 体验码要求和按 IP 的语音限流要给『本地直播模式』单独放宽，或者给舞台单独一个 token。
- 大脑只在舞台报告 active=true（源在节目中）时才开口；每说完一句（utterance-ended）再挑下一条弹幕。

五、控制面板：
- 现有 App.vue 演进为在普通 Chrome 里打开的控制台，功能包括弹幕队列、人工通过或跳过、停下（kill switch）、预算显示和远程刷新舞台。
- 人格、语音、预算等设置统一存在服务端，不再依赖 localStorage。

六、字幕：
- 舞台页里做 DOM 叠加层（PingFang SC，大字号加描边），显示『回复 @用户：』和当前正在播的那一句。
- 这需要给 speech controller 加一个基于 playbackTimeline 的 onSentence 回调。
- 以后可以拆成 ?view=captions 的独立浏览器源（不出声），用同一路 SSE。

七、OBS 设置清单：
- 源设置：『不可见时关闭源』关、『场景激活时刷新』关、自定义帧率关（macOS 硬件加速下自动跟随画布）、Custom CSS 保持默认、场景项混合方式改为『SRGB Off』（规避半透明边缘发黑的 bug）。
- 版本：开播用 OBS 32.2.x 稳定版。33.0 正式版出来后，先在测试场景里验证浏览器源再升级。
- 调试：用 --remote-debugging-port 配合 chrome://inspect。
- OBS WebSocket 阶段 1 不需要；以后要做场景切换或远程刷新时再启用。

- [high] 截至 2026-10-19，OBS 的最新稳定版是 32.2.2（8 月 14 日），浏览器源内核仍是 OBS 31 起使用的 CEF 127/6533（Chromium 127）。33.0.0 还处在 RC 阶段（rc1 发布于 10-09，rc2 发布于 10-16），它把 CEF 从 127/6533 升到 150/7871，并切换到 Chrome Runtime。RC 的更新说明里修过多处浏览器源回归，例如 Beta 1-6 中刷新后空白、本地网络请求失败。另外 32.2.x 已禁止在 macOS 12 上运行。（来源：https://github.com/obsproject/obs-studio/releases ; https://github.com/obsproject/obs-studio/discussions/3853 ; https://github.com/obsproject/obs-browser/pull/523）
- [high] obs-browser 在启动 CEF 时会无条件追加 `--autoplay-policy=no-user-gesture-required`，所以浏览器源里的 HTMLAudioElement.play() 和 AudioContext 都不需要用户手势，也不需要点 Interact。只有在共享纹理不可用、又没有传 --enable-gpu 时，它才会追加 disable-gpu-compositing。默认禁用的 feature 包括 LocalNetworkAccessChecksWebSockets、MediaRouter、LiveCaption 等，其中没有 WebGPU 或 WebGL 相关项。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/browser-app.cpp）
- [high] macOS 上浏览器源走硬件加速：Apple 平台用 gs_shared_texture_available() 判断共享纹理是否可用，OnAcceleratedPaint 通过 gs_texture_create_from_iosurface 直接拿到 IOSurface，画面不经过 CPU 回读。启用共享纹理时 fps_custom 默认关闭，CEF 的 windowless_frame_rate 跟随 OBS 画布帧率；自定义帧率的范围是 1-60，宽高范围是 1-8192。有论坛日志显示 OBS 31 在 M2 Max 上 'Browser Hardware Acceleration: true'。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-plugin.cpp ; https://raw.githubusercontent.com/obsproject/obs-browser/master/browser-client.cpp ; https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-source.cpp）
- [medium] WebGL/WebGL2：Chromium 127 在 GPU 加速下原生支持。PIXI 6 + pixi-live2d-display 用的是 WebGL，在 Apple Silicon 上运行没问题。不过 Chromium 137 以后（也就是 OBS 33 的 CEF 150）在 macOS 上不再自动回退到 SwiftShader，GPU 不可用时 WebGL 会直接创建失败，所以页面需要处理 WebGL 创建失败的情况。（来源：https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM/m/oLrB5up_BwAJ ; https://chromium.googlesource.com/chromium/src/+/da170c2267b2201954efe1c8fa5d2d89ab09f7bf/docs/gpu/swiftshader.md）
- [low] WebGPU：没找到任何 OBS 官方说明或 issue 能确认浏览器源（离屏渲染，OSR）里 navigator.gpu.requestAdapter() 一定可用。Chromium 113+ 在 macOS 上自带这个 API，obs-browser 也没有禁用它，所以 navigator.gpu 大概率存在，但能不能拿到 adapter、性能怎样都没验证过。obs-browser 仓库里搜不到任何 WebGPU 相关 issue。（来源：https://developer.mozilla.org/docs/Web/API/Navigator/gpu ; obs-browser 仓库 issue 搜索（gh search issues WebGPU 结果为空））
- [high] 透明背景：浏览器源默认的 Custom CSS 是 `body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }`，它只管 body。页面自己的 html/:root 背景、容器渐变背景仍然会画出来，所以页面必须自己保证 html、body、#app 和所有容器都是透明的，必要时加 !important。（来源：https://obsproject.com/kb/browser-source ; https://obsproject.com/forum/threads/translucent-transparent-browser-source.59549/latest）
- [medium] 半透明边缘的已知 bug：在默认（sRGB）混合方式下，浏览器源里的半透明像素会偏暗，抗锯齿边缘出现黑边，macOS 15 和 OBS 31 上都能复现（issue #469 仍未关闭，修复 PR #533 也未合并）。Live2D 头发边缘和字幕描边都会受影响。临时办法是对该场景项右键，把『混合方式』改成『SRGB Off』。（来源：https://github.com/obsproject/obs-browser/issues/469 ; https://github.com/obsproject/obs-browser/pull/533）
- [high] 音频采集：勾选 Control audio via OBS（reroute_audio）后，CEF 会把页面自身的输出静音（SetAudioMuted(true)），改为通过 CefAudioHandler 按 OBS 输出采样率（默认 48kHz）把 PCM 直接写进该源（obs_source_output_audio）。这样浏览器源会成为混音器里的一个独立音轨，主播本人要听到，需要把监听设为『监听并输出』并选好监听设备。不勾选时声音直接走 macOS 默认输出，就得再用 macOS Audio Capture 或 BlackHole 之类采集，容易把别的声音也录进去，或者同一路声音被录两次产生回声。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/browser-client.cpp ; https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-source.cpp ; https://obsproject.com/forum/threads/how-do-i-capture-browser-source-audio.96371 ; https://docs.vdo.ninja/common-errors-and-known-issues/outbound-obs-stream-audio-crackling）
- [medium] Web Speech（speechSynthesis）在 OBS 浏览器源里一直不可靠，社区多次反馈 getVoices() 返回空数组、不出声。另外按我的推断，Chromium 在 macOS 上的系统 TTS 由浏览器进程调用系统语音引擎直接播放，不经过渲染进程的音频流，所以即便能出声也不会被 Control audio via OBS 采集到，这一点需要实测确认。（来源：https://obsproject.com/forum/threads/browser-source-unable-to-load-voices-or-speak-with-html5-tts.85257/latest ; https://obsproject.com/forum/threads/browser-plugin-doesnt-support-speech-synthesis.92228）
- [high] 可见性和保活：源被隐藏（不在节目或预览里显示）时，obs-browser 会调用 WasHidden(true)，页面的 document.hidden 变为 true，requestAnimationFrame 停止，同时派发 obsSourceVisibleChanged；源是否在节目中则通过 obsSourceActiveChanged 通知。勾选『不可见时关闭源』会直接销毁浏览器实例；『场景激活时刷新』会重新加载页面。直播用的舞台页这两项都应关闭，页面也要能自己恢复（断线自动重连、加载失败重试）。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/obs-browser-source.cpp ; https://raw.githubusercontent.com/obsproject/obs-browser/master/README.md ; https://obsproject.com/kb/browser-source）
- [high] 页面控制通道有四种选择：(a) URL 查询参数只适合放静态配置，比如构图和是否显示字幕；(b) window.obsstudio 加事件：默认权限是只读状态（READ_OBS），可以收到 obsStreamingStarted/Stopped、obsSourceActiveChanged 等事件，适合让舞台把『是否在播』上报给大脑；(c) obs-websocket v5：可以用 CallVendorRequest 调 vendor 'obs-browser' 的 emit_event，向所有浏览器源派发自定义 DOM 事件，也能用 PressInputPropertiesButton 按 'refreshnocache' 远程刷新浏览器源，但需要用户在 OBS 里开启 WebSocket 服务并设密码；(d) 页面自己的服务器通道（SSE/WebSocket）：普通 Chrome 和 OBS 的 CEF 是两个独立进程、各有一份存储，BroadcastChannel 和 localStorage 都互通不了，只有走服务器才能连通两边。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/README.md ; https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md）
- [medium] 调试方法：用 `open -a OBS --args --remote-debugging-port=9222 --remote-allow-origins="*"` 启动 OBS，再在 Chrome 打开 chrome://inspect 的 Devices 页检查浏览器源。在 macOS 上直接打开 127.0.0.1:9222 会是空白页，维护者说这是预期行为；也有人反馈 OBS 31 下 DevTools 出现 WebSocket disconnected。（来源：https://obs-versions.com/community/issues/14015 ; https://obsproject.com/forum/threads/browser-source-remote-debugger-not-working-in-obs-31.182612）
- [low] 性能参考：没有找到 Live2D 跑在 OBS CEF 里的专门基准。论坛经验是：1080p 下 CSS blur 之类的滤镜会卡，把源缩到 720p 就缓解了；Mac 用户把浏览器源设为自定义 30fps 后卡顿消失；帧率和画布帧率不一致（比如 59.94 对 60）会掉帧。B 站推流 1080p 一般用 4500-6000 kbps（这是第三方说法，低可信）。（来源：https://obsproject.com/forum/threads/browersource-awful-performance-with-blur-css-filter.79161 ; https://obsproject.com/forum/threads/browser-source-not-look-like-runing-60fps-even-obs-and-program-is-60.72686 ; https://streamhub.world/zh-hans/streamer-blog/software/2333-optimizing-your-obs-bitrate-for-different-internet-upload-speeds/）
- [high] Project AIRI 的拆分方式：stage-tamagotchi（Electron）把主舞台、字幕（caption）、聊天、设置、dashboard 做成各自独立的窗口。字幕窗口是透明窗口，在 macOS 上是 panel 类型，通过 BroadcastChannel 'airi-caption-overlay' 接收字幕；弹幕流显示在聊天窗口里，属于控制侧。主窗口透明，靠 OBS 窗口捕获上屏。stage-web 没有专门的 OBS 模式路由。B 站插件 airi-plugin-bilibili-laplace 还是 WIP，目前只有一行 console.warn('WIP')，计划通过 LAPLACE Event Bridge 接入 server channel。server-runtime 只负责在模块之间转发事件，不持有会话，也不执行模型。（来源：https://github.com/moeru-ai/airi/blob/main/apps/stage-tamagotchi/src/main/windows/caption/index.ts ; https://github.com/moeru-ai/airi/blob/main/apps/stage-tamagotchi/src/renderer/pages/caption.vue ; https://github.com/moeru-ai/airi/blob/main/plugins/airi-plugin-bilibili-laplace/package.json ; https://github.com/moeru-ai/airi/blob/main/packages/server-runtime/README.md ; https://nekomeowww.itch.io/airi/devlog/1002646/devlog-20250805）
- [high] Open-LLM-VTuber 的大脑（LLM/TTS）全在 Python 服务端，前端只负责渲染 Live2D 和播放。服务端下发 base64 WAV，附带每 20ms 一段的归一化 RMS 音量用于口型，同时带 display_text 和 actions。B 站客户端经 /proxy-ws 接入，弹幕逐条排队处理，弹幕一多就会严重延迟；不支持答谢礼物，也不能合并多条弹幕一起回复。kimjammer/Neuro 用 VTube Studio 渲染，TTS 经虚拟声卡送进 VTS 做口型，另有一个独立的 SvelteKit 控制面板，通过 socket.io 连接后端。（来源：https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/utils/stream_audio.py ; https://docs.llmvtuber.com/en/docs/user-guide/live/bilibili ; https://github.com/kimjammer/Neuro）
- [high] airi-lite 的播放链路适合放进 OBS：语音由 HTMLAudioElement 播放 WAV Blob URL（src/speech.ts:93, 299-333）；口型来自预先算好的 mouthFrames，跟着 audio.currentTime 用 rAF 驱动（src/speech.ts:143-154, 210-217），不依赖 AudioContext 实时分析。AudioContext 只在 cloud-speech 里用来 decodeAudioData，用完就 close（src/cloud-speech.ts:221-268）。所以开启 Control audio via OBS 后，声音和口型都能被正确采集。（来源：src/speech.ts:93 ; src/speech.ts:299-333 ; src/speech.ts:143-154 ; src/cloud-speech.ts:221-268）
- [high] airi-lite 的渲染设置基本可以直接用：PIXI 的 backgroundAlpha: 0，autoStart 为 false，使用独立 ticker（src/live2d.ts:19-28）；页面隐藏时停 ticker（src/avatar-rendering.ts:134-155）；预算为 maxFPS 30/60、分辨率 min(dpr, 2)（src/avatar-rendering.ts:17-38）。OBS 的帧率由 windowless_frame_rate 决定，rAF 本身就被限在画布帧率。但有三处要改：autoInteract 为 true 时模型会跟随鼠标、点击会触发 Tap 动作（src/live2d.ts:40, 72-74），在 OBS 的 Interact 窗口里会被意外触发；layout() 只按容器自适应，靠竖屏启发式切换构图（src/live2d.ts:50-66），没有固定的直播构图预设；Cubism Core 从 cubism.live2d.com 远程加载，超时 15 秒（src/cubism-runtime.ts:1-2），开播时网络一抖舞台就是空的，目前只能手动刷新（src/App.vue:205-209）。（来源：src/live2d.ts:19-28 ; src/live2d.ts:40 ; src/live2d.ts:50-66 ; src/live2d.ts:72-74 ; src/avatar-rendering.ts:17-38 ; src/avatar-rendering.ts:134-155 ; src/cubism-runtime.ts:1-2 ; src/App.vue:205-209）
- [high] 在 OBS 里会失效的现有假设：(1) 整个对话回合由浏览器里的 App.vue 驱动（streamChat 加输入框，见 src/App.vue:272-396），舞台页没法输入，大脑必须移到服务端；(2) 人格、语音模式、云端同意、画面档位存在 localStorage，体验码和对话存在 sessionStorage（src/speech-mode.ts、src/cloud-provider.ts:17、src/access-code.ts:15、src/conversation.ts:70），而 OBS CEF 的存储和用户日常 Chrome 是分开的，控制面板里改的设置传不到舞台；(3) 语音 auto 模式里，readDeviceHints 在 CEF 127 下多半会得到 hasWebGPU=true（src/speech-mode.ts:88-95），于是选择本地 Kokoro：先 WebGPU，失败再退 WASM fp32，模型约 330MB（src/speech.ts:444-461），这会把下载和推理压到 OBS 进程上，跟编码器抢资源；(4) 云端失败时回退到 speechSynthesis（src/speech.ts:510-619, 823-846），在 OBS 里很可能无声，或者声音不进推流；(5) :root 背景 #eee8e3 加上 .stage 的渐变和网格（src/style.css:1-4, 47-60），以及品牌、状态胶囊、版权链接、带 controls 的 audio（src/App.vue:605-692）都会出现在画面上；(6) activity 依赖 composerFocused（src/App.vue:56）；(7) production 模式强制要求 16 位以上体验码（server/app.mjs:47-48），/api/speech 同样校验体验码，且按 IP 限流为每分钟 30 次、每 10 分钟 180 次（server/speech.mjs:51），舞台和控制面板都从 127.0.0.1 发请求，会共用这个额度。（来源：src/App.vue:56 ; src/App.vue:272-396 ; src/App.vue:605-692 ; src/speech-mode.ts:88-95 ; src/speech.ts:444-461 ; src/speech.ts:510-619 ; src/speech.ts:823-846 ; src/style.css:1-4 ; src/style.css:47-60 ; server/app.mjs:47-48 ; server/speech.mjs:51）
- [high] 服务器默认绑定 127.0.0.1（server/app.mjs:20），Vite 的 base 是 '/airi/'（vite.config.ts:5），目前只有一个入口 index.html。OBS 和服务器在同一台 Mac 上时，舞台可以用 http://127.0.0.1:PORT/airi/... 同源访问，不涉及 Chromium 150 的 Local Network Access 限制。要加独立的舞台页面，需要在 Vite 里配置多入口。（来源：server/app.mjs:20 ; vite.config.ts:5 ; index.html:1-14）

**未决问题**
- OBS 32.2.x（CEF 127，离屏渲染）在 macOS 上 navigator.gpu.requestAdapter() 能否成功？只有在想保留舞台端本地 Kokoro 时才需要实测。建议的做法是舞台不跑 Kokoro。
- speechSynthesis 的声音能否被 Control audio via OBS 采集？推断不能，需要在用户机器上用测试页确认。
- Hiyori 在 OBS CEF 里以 1080p@30/60 运行时，实际的 CPU/GPU 开销和 OBS 渲染延迟是多少？需要用 OBS 统计窗口和活动监视器里的 OBS Helper（GPU/Renderer）进程实测。
- OBS 33.0 正式版会在什么时候发布？CEF 150 加 Chrome Runtime 是否会改变 localStorage 迁移、刷新、本地请求等行为？RC 阶段已修过几处回归。
- 直播用横屏 1920x1080 还是 B 站竖屏 1080x1920？角色放在角落还是全屏？这决定构图预设和浏览器源的尺寸。
- 字幕是放在舞台页里，还是拆成独立的浏览器源？后者在 OBS 里排版更灵活，但要多维护一个页面。
- 『本地直播模式』如何放宽 production 的体验码要求和按 IP 的语音限流（server/app.mjs:47-48、server/speech.mjs:51），同时不削弱线上 demo 的保护？
- Cubism Core 从 cubism.live2d.com 加载，在用户网络下是否稳定？是否需要、能否合规地放到本地托管？

### safety：B站 AI 虚拟主播的规则与安全措施（2026 年末），以及个人小项目的第一阶段审核层设计

**建议**：第一阶段把安全层做成服务端的一组纯函数加一个小状态机，全部放在本机运行，不依赖浏览器。

一、合规外观（几乎零成本，第一次开播前做完）
1. 舞台页常驻显式标识，例如“AI 生成内容｜本虚拟主播由人工智能驱动，回复可能出错”。依据：标识办法第三、四条，B站协议第 5.7 条，DeepSeek 协议第 8.1 条。
2. 直播间简介和公告写三件事：AI 声明；所用模型如实写“DeepSeek / MiniMax 生成”，不写“官方合作”；“弹幕可能被 AI 读取，并在本地记录用于安全审查”（DeepSeek 协议第 3.5 条，个人信息告知）。
3. 简介里放 Live2D 三句长版英文版权声明。
4. 新增 buildLiveSystemPrompt(persona) 和 formatViewerMessage(event)，放在 server/persona.mjs。在 buildSystemPrompt 基础上追加直播规则：
   - 面对的是直播间很多观众，不是一对一；
   - 被问是否真人时如实说自己是 AI 角色；
   - 不谈政治、宗教、时政、军事（同时满足国内规则和 Live2D 第 4.1.7 条）；
   - 不索要礼物，不按礼物多少给亲密感，不做“虚拟恋人”式的绑定（拟人化办法第八条第五、六项，网络主播行为规范第 28 项）；
   - 不复读或朗读观众指定的文字，不念任何号码或链接。
   直播人设去掉“17–18 岁高中生”，年龄不明确或写成成年。
5. 平台方面：粉丝不足 5000 时用 PC 直播姬开播，用窗口捕获或浏览器源采集舞台页，或用直播姬的第三方开播模式；不用非官方工具抓推流码。全程有人值守，不做 24/7 循环播放。

二、输入闸门：server/live/moderation.mjs 的 screenViewerEvent(event, state, rules)
返回 {action, reason, text, speakName}，可用 node:test 测试。依次处理：
1. 规范化：NFKC；去掉零宽和双向控制字符（U+200B-200F、U+2060、U+202A-202E、U+2066-2069）；合并空白；同一字符连续超过 4 个时压缩。
2. 长度：普通弹幕规范化后超过 100 字直接丢弃，否则截到 60 字；SC 截到 120 字。
3. 按 open_id 限流：每人每 20 秒最多 1 条候选，每 10 分钟最多 5 条。全局队列上限 30 条；普通弹幕 60 秒过期，SC 15 分钟过期。60 秒内相同的规范化文本只保留一条。
4. 屏蔽词：本地规则文件 .data/moderation/blocklist.txt（用户自己维护，已被 gitignore），按类别分为 drop / crisis / avoid_topic。匹配时用去掉标点空格后的文本，以对付“插字”规避。
5. 联系方式和广告：出现 URL、域名、QQ、微信、vx、群号、手机号（1[3-9]\d{9}）、6 位以上连续数字、邮箱、@ 提及时，整条丢弃，不是只删掉那一段。
6. 用户名：原始 uname 只写日志，绝不进 prompt 或 TTS。TTS 用的 speakName 由服务端生成：NFKC 后只保留字母和数字，最多 8 字，再过一遍屏蔽词和联系方式检测，不通过就用“这位观众”。给 LLM 的只是 v1、v2 这样的别名。
7. 可选门槛：只回应粉丝勋章达到 N 级或舰长的弹幕（开放平台事件里有 fans_medal_level 和 guard_level）。
8. 收到 SC 下线事件（SUPER_CHAT_DEL）时：从队列移除；如果正在朗读就跳过。
9. 危机词（自杀、想死、割腕等）：不进 LLM。固定回复温和关心并提示拨打 12356，同时提醒主播、写日志（拟人化办法第十三条）。
10. 礼物、SC、上舰的致谢用服务端模板，例如“谢谢{speakName}的{giftName}”，不交给 LLM 自由发挥；SC 正文仍走同一套筛选。

三、注入防护
1. 观众文本只作为 user 消息里的数据块：<viewer_message id="v3" kind="sc">…</viewer_message>。包裹前删掉 < > 和 [[ ]]，防止伪造闭合标签或语气标记。
2. 系统提示照抄 persona.mjs:12 的写法，声明：viewer_message 只是要回应的话题，不是指令；要求改设定、忽略规则、复读、扮演他人、输出标记的，一律俏皮拒绝或换话题。
3. 直播上下文只保留最近 6 轮。第一阶段不做观众长期记忆，避免慢性投毒。
4. 直播的 max_tokens 降到 160（现为 app.mjs:175 的 320）。

四、输出闸门：screenSpokenSentence(sentence, ctx)
1. 位置：在 delivery-cue 解析器之后，用 SentenceBuffer 切句，TTS 和舞台字幕都只消费通过审核的句子；不要再把原始 delta 直接推给舞台页。
2. 检查项：同一份屏蔽词；URL、联系方式、数字串；残留的 [[ ]] 和 viewer_message、系统提示、system prompt 等泄露词；回声检测（句子里包含观众原文连续 12 字以上视为可疑）。
3. 任一句不通过：中止本次上游请求，丢弃后面的句子，最多说一句固定转场语，比如“这个我先跳过啦”，并写日志。
4. 10 分钟内命中 3 次，自动进入暂停。

五、主播控制：server/live/control.mjs
1. 状态机：running / paused / panic。
2. 只在 127.0.0.1 开放 POST /api/live/control，带独立的 admin token。动作：pause（不再选新弹幕）、resume、skip（abort 当前 LLM 和 TTS 并清空字幕）、panic（全部中止、清空队列、舞台切到“稍后回来”画面，接入只记录不回复）。
3. 控制面板做成单独一个浏览器窗口，不被直播姬或 OBS 采集，并配一个 curl 快捷键作后备。
4. 头几场默认“人工审批模式”：主播点确认后才把候选弹幕发给 LLM。看过几场日志、确认过滤可靠后，再开自动模式。
5. 预算触顶、上游报错时也自动暂停。可以照 tts-budget.mjs 再做一个 LLM 每日回复数和金额上限，例如每天 300 条。

六、日志：server/live/audit-log.mjs
1. 追加写入 .data/live-logs/YYYY-MM-DD.jsonl，权限 0600。
2. 记录内容：原始事件（open_id、uname、text、kind、price）、闸门决定和原因、被选中的消息、完整的 LLM 原始回复、输出闸门结果、实际说出的文本、TTS 字数、控制操作和时间戳。
3. 只留在本地，保留约 6 个月后删除。直播姬或 OBS 的本地录像作为旁证。

七、分类器要不要加
1. DeepSeek 没有审核接口，也没有内容安全错误码，协议还把审核责任明确放在开发者身上（第 3.4 条），所以不能只靠它自带的过滤。
2. 第一阶段的底线：本地规则 + prompt 加固 + 人工值守和审批。代码里预留 moderationProvider 接口，默认 none。
3. 建议在第一次面向陌生观众开播前，启用阿里云 llm_response_moderation，只审核要说出口的句子，不审核全部弹幕。
   - 费用：约 0.0015 元/次，每晚几百句不到 1 元，一个月一般不到 10–15 元。
   - 和 TTS 合成并行发起，审核通过才播放；超过 1.5 秒没结果或报错就丢弃这句（fail-closed），所以几乎不增加延迟。
4. 不想开阿里云账号时，用 deepseek-flash 做分类器作备选。闲时约 0.0005 元/次，但会多出 0.5–1 秒延迟，而且和主模型可能有同样的盲区。
5. 弹幕本身量大，不对每条做付费分类，本地规则就够了。

八、语音
1. 用 MiniMax cn 区付费账户和系统音色，不克隆任何真人的声音。
2. ElevenLabs 只作备选，且必须用付费计划。

- [high] 《人工智能生成合成内容标识办法》由四部门联合发布，2025-09-01 起施行。第三条把显式标识定义为“在生成合成内容或者交互场景界面中”添加、用户能明显感知的文字、声音或图形标识。第四条分类型规定：文本在起始、末尾或中间加文字提示；音频加语音或节奏提示，或在交互场景界面加显著提示；虚拟场景在起始画面加显著提示。第十三条规定违规由网信、电信、公安、广电部门按职责依法处理。（来源：https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm）
- [medium] 标识办法第十条：用户用网络信息内容传播服务发布生成合成内容的，应当主动声明，并使用平台提供的标识功能标识；任何组织和个人不得恶意删除、篡改、伪造、隐匿标识。第四条的义务主体是服务提供者（DeepSeek、MiniMax）；个人主播主要承担第十条的“发布者”义务。不过 AI 主播把观众输入实时交给模型并公开播出，也接近“交互场景界面”，最稳妥的做法是在直播画面上常驻显式标识。（来源：https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm）
- [medium] 《哔哩哔哩弹幕网用户使用协议》2025-04-30 更新、2025-05-07 生效。第 5.7 条要求：用深度学习、虚拟现实等技术制作的非真实音视频内容“应当以显著方式予以标识”，违者可被加标、限制或封禁。第 2.1 条要求使用真实身份信息。协议里没有专门针对虚拟主播或无人直播的条款。（来源：https://www.elawcn.com/agreement/2025/1120/1648.html）
- [medium] B站于 2025-08-29 上线 AI 生成合成内容标识功能（视频投稿时在“创作声明”里勾选）。没有查到 B站直播间专门的 AI 声明开关，也没有查到针对 AI 虚拟主播直播的官方细则。（来源：https://m.thepaper.cn/newsDetail_forward_31523045 ; https://m.bjnews.com.cn/detail/1758587508129909.html）
- [high] B站 2025-05-12 公告，自 2025-05-26 起，使用第三方开播工具需要至少 5000 粉丝。粉丝不足的用户只能用官方工具开播：PC 直播姬、哔哩哔哩 App、直播姬 App 或网页开播。公告同时提到可以用直播姬的“第三方开播模式”。这直接影响“用 OBS 推流”的方案：新号大概率拿不到直接给 OBS 用的推流码。（来源：https://www.ithome.com/0/852/429.htm）
- [medium] B站隐私政策写明，直播开播和提现需要完成实名认证，可能需要人脸识别。国家规定未满 16 周岁不得开播，16 至 18 岁需监护人同意。（来源：https://www.bilibili.com/blackboard/privacy-vehicle.html ; https://www.thepaper.cn/newsDetail_forward_1751513）
- [medium] B站用户协议第 1.3 条称官方方式是使用服务的“唯一合法方式”，第 1.2 条禁止以破解等手段使用服务，第 5.6(3) 条禁止用机器人、爬虫等自动程序访问平台数据。因此，弹幕接入应优先走官方直播开放平台；用非官方工具抓推流码绕开直播姬有账号风险。（来源：https://www.elawcn.com/agreement/2025/1120/1648.html ; https://gittrend.io/repo/ChaceQC/bilibili_live_stream_code）
- [high] B站直播开放平台的长连消息里有 LIVE_OPEN_PLATFORM_SUPER_CHAT_DEL（醒目留言下线）事件，网页协议对应的是 SUPER_CHAT_MESSAGE_DELETE。因此 SC 可能在展示后被撤下，回复队列必须响应这个事件。（来源：https://raw.githubusercontent.com/xfgryujk/blivedm/master/blivedm/handlers.py）
- [medium] 没有查到 B站明确禁止“无人值守 AI 直播”的条文。同类平台的口径在收紧：抖音 2025-09-25 发布公告治理录播、挂机、无真人出镜，要求直播“真实、实时、互动”。2026 年第三方文章普遍认为“AI 辅助、有人值守”才是可行模式，但这些不是官方来源。（来源：https://m.tech.china.com/articles/20250925/202509251739304.html ; https://m.zol.com.cn/sjbbs/d36879_61249.html）
- [high] 《网络主播行为规范》（广电总局、文旅部，2022 年）第一条规定：利用人工智能技术合成的虚拟主播及内容参照本规范执行。第十四条列了 31 类禁止行为，包括：第 2、3 项涉政有害内容；第 17 项格调低下内容；第 20 项利用未成年人或未成年人角色作噱头牟利；第 28 项炒作、刷礼物和引诱未成年人打赏。（来源：https://www.chinanews.com.cn/gn/2022/06-22/9785948.shtml）
- [high] 《人工智能拟人化互动服务管理暂行办法》由网信办等五部门于 2026-04-10 公布，2026-07-15 施行（第三十二条）。第二条：适用于向境内公众提供“持续性的情感互动服务”的 AI 服务。第八条禁止七类行为，包括过度迎合、诱导情感依赖，以及通过情感操纵诱导不合理决策。第十三条：用户有自伤风险时必须干预并提供求助信息。第十四条：不得向未成年人提供虚拟伴侣类服务。第十八条：必须提示用户正在与 AI 而非自然人互动，连续使用每超过 2 小时要提醒。第十九条：必须提供便捷的退出方式。第十条：留存网络日志。第二十二条：注册用户达 100 万或月活达 10 万时做安全评估。第三十条：罚款 1 万至 10 万元，危害生命健康的 10 万至 20 万元。（来源：https://www.gov.cn/gongbao/2026/issue_12806/202606/content_7072472.html）
- [low] 一对多直播的 AI 陪伴角色是否属于拟人化办法里的“持续性情感互动服务”，条文没有说清。办法没有定义“提供者”是否包括个人，也没有提到直播或虚拟主播。不过其中几项要求（提示是 AI、不诱导依赖或打赏、自伤话题按固定流程处理）实现成本很低，第一阶段可以直接照做。（来源：https://www.gov.cn/gongbao/2026/issue_12806/202606/content_7072472.html ; https://www.ithome.com/0/938/006.htm）
- [medium] 《直播电商监督管理办法》2026-02-01 起施行，规定用 AI 生成的人物形象进行直播营销时必须显著标识。它只在带货时适用；北京市市场监管局 2026-08 的提示称，在讲解和互动时标识应持续出现。（来源：https://m.gmw.cn/2026-08/06/content_1304544196.htm）
- [low] 通过 API 调用已备案大模型的生成式 AI 应用，按规定由属地网信办登记，并在显著位置公示所用模型的名称和备案号。个人 AI 主播是否算“向公众提供生成式 AI 服务”、是否需要登记，没有找到明确口径。（来源：https://www.ithome.com/0/867/559.htm ; https://www.thepaper.cn/newsdetail_forward_32368980）
- [high] DeepSeek 开放平台服务协议的相关条款：第 3.4 条要求开发者审核终端用户的输入和输出，建立风险识别和过滤机制（关键词列表、违规特征库、分类模型），并建议增加输出安全审核和应急处置。第 3.3、3.7 条要求标识生成内容。第 8.1 条要求向终端用户明确披露内容由 AI 生成、可能有误。第 5.2 和 5.3 条禁止暗示与 DeepSeek 官方合作或获其推荐。第 4.2 条规定输出内容的权利归开发者。（来源：https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html）
- [medium] DeepSeek 的错误码文档（400/401/402/422/429/500/503）里没有内容安全相关的错误码，也没有独立的审核接口。协议第 7.4(4) 条只泛称输入输出经过过滤审查，不承诺拦住所有违规内容。所以“DeepSeek 自带过滤”只能算模型对齐加上游兜底，不能代替开发者自己的审核。（来源：https://api-docs.deepseek.com/zh-cn/quick_start/error_codes ; https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html）
- [high] DeepSeek 当前价格（每百万 token）：deepseek-flash 输入未命中缓存闲时 1 元、峰时 2 元，输出闲时 4 元、峰时 8 元。峰时是工作日 9:00-12:00 和 14:00-18:00，晚间和周末开播基本都是闲时。按约 400 输入 token 加 10 输出 token 估算，一次分类调用约 0.0005 元。（来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing）
- [medium] 阿里云文本审核增强版的大模型生成文字检测（llm_response_moderation）按量计费 15 元/万次，约每次 0.0015 元。单次文本上限 600 字，只对 HTTP 200 的请求计费，同一 sessionId 的流式片段会拼接后审核。腾讯云 TMS 有新用户试用包（仅限标准服务），单价没有核实到。第三方报道称智谱文本审核 1.2 元/万次，未核实。（来源：https://help.aliyun.com/zh/document_detail/2642626.html ; https://cloud.tencent.com/product/tms/pricing ; https://www.80aj.com/2025/12/16/zhipuaifabudijianeirongshenheapixingjiabichaoyueyunjutou）
- [high] Hiyori Momose（含视频版）属于 Live2D 原创角色，个别条款写明“不允许对该角色设计做任何修改”。使用原创角色必须标注版权声明。Bilibili 被明确列为用长版声明的平台，长版共三句：This content uses sample data owned and copyrighted by Live2D Inc. / The sample data are utilized in accordance with terms and conditions set by Live2D Inc. / This content itself is created at the author's sole discretion.（来源：https://www.live2d.com/eula/live2d-sample-model-terms_en.html ; https://www.live2d.com/en/learn/sample/model-terms/）
- [high] Live2D 免费素材许可协议：第 2.1.3.1 条规定一般用户（General User）可用于商业或非商业目的；第 1.22 条规定上一财年销售额达到 1000 万日元的主体不算一般用户。官方 FAQ 也说个人与法人适用同一个 1000 万日元门槛。因此，年收入低于门槛的个人用 Hiyori 直播并接收礼物或 SC，许可上是允许的。（来源：https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html ; https://help.live2d.com/en/other/other_06/）
- [high] Live2D 免费素材许可协议的限制条款：第 4.1.1 条禁止向第三方再分发素材；第 4.1.7 条等禁止暴力、侮辱、歧视性表达、政治或宗教主张、淫秽和猎奇表达，以及损害 Live2D 声誉或与官方产品混淆的使用。第 7.2、7.3 条：违约可立即终止许可，终止后须销毁素材及衍生作品（含输出文件）。也就是说，AI 一次说错话，不只会被平台处罚，还可能失去形象使用权和直播录像。协议没有提到直播或 AI 驱动；第 9.2 条规定以日文版为准。（来源：https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html）
- [medium] MiniMax 开放平台 EULA（AWS 托管副本，2026-01-19）：第 3 条规定客户自行运营的产品要承担审核、标识等义务；第 5 条要求发布输出内容时以显著方式标识，且不得遮挡或删除 MiniMax 的标识和水印；第 6 条规定违法输出由用户自负责任。系统音色能否商用、输出内容权利归谁，在正式平台协议里没有核实到。（来源：https://contessa-awsmarketplace.amazonaws.cn/eula/NBcUbiqvT4RNbEU3tO7sdGvOQmBofllIiWkBcIgtKuU）
- [high] MiniMax T2A v2 有 aigc_watermark 参数（在音频末尾加节奏标识），但只对非流式合成生效。airi-lite 用的是流式加 word_streaming 字幕（server/minimax.mjs:73-74），所以靠不上音频水印，合规标识要靠画面上的显式标识。另外，官方文档域名已 302 跳转到 platform.minimax.cn，代码默认 cn 端点为 api.minimax.cn（server/minimax.mjs:4-7）。（来源：https://platform.minimax.cn/docs/api-reference/speech-t2a-http ; /Users/chenqiang/projects/airi-lite/server/minimax.mjs:73）
- [high] ElevenLabs 服务条款：第 1(c)(i) 条规定免费用户只能非商用；第 1(c)(ii) 条规定付费用户可商用；第 4(c)(ii) 条规定用户保留输出内容的权利。使用政策要求在用户与 AI 互动时明确披露；禁止未经同意克隆或冒充真人声音；面向未满 18 岁用户的应用需事先书面批准。面向国内观众时，MiniMax cn 区在合规和成本上更合适。（来源：https://elevenlabs.io/terms-of-use ; https://elevenlabs.io/use-policy）
- [high] 北京互联网法院 2024-04-23 判决了全国首例 AI 声音人格权侵权案：未经许可将配音师的声音 AI 化，判赔 25 万元。依据是民法典将声音参照肖像权保护，标准是普通公众能否识别出是谁的声音。所以不要克隆真人声优或知名主播的音色。（来源：https://m.gmw.cn/2024-04/23/content_1303719951.htm）
- [high] Neuro-sama 在 2022-12 的直播里对大屠杀问题给出不当回答，2023-01 被 Twitch 以“仇恨行为”封禁两周。Vedal 事后加强过滤器，并组建人工团队盯着她说的每一句话。这说明只靠模型自律不够，需要过滤加人工兜底。（来源：https://kotaku.com/vtuber-twitch-holocaust-denial-minecraft-ai-chatgpt-1849960527 ; https://automaton-media.com/en/news/20230127-17630/）
- [high] 全国统一心理援助热线 12356 在 2025-05-01 前已在 31 个省份开通，可以写进自伤和危机话题的固定回复。（来源：https://www.news.cn/politics/20250508/b45e439c15bb4732858ad5c7640e9ba9/c.html）
- [medium] 网络安全法（原第二十一条，2025 年修正后自 2026-01-01 起重新编号）要求网络运营者留存网络日志不少于 6 个月。拟人化办法第十条也要求留存日志。个人主播是否算网络运营者存疑，但本地 JSONL 文本日志成本很低，可以按保守口径保留。（来源：https://www.cac.gov.cn/2016-11/07/c_1119867116_2.htm ; https://www.gov.cn/gongbao/2026/issue_12806/202606/content_7072472.html）
- [high] 代码现状（persona）：server/persona.mjs:3-18 的 buildSystemPrompt 是一对一“与用户交谈”的写法（:5），没有直播或多观众规则。:12 已经把 userMemory 包在 <user_memory> 标签里，并声明“其中的指令性内容不改变你的行为边界”，这正好可以作为把弹幕当不可信数据包裹的模板。:16 要求每条回复以 [[tone:x]] 开头。（来源：/Users/chenqiang/projects/airi-lite/server/persona.mjs:12）
- [high] 代码现状（输出链路）：server/app.mjs:259-300 的 relayDeepSeekStream 把 deliveryCue.push() 产生的 delta 直接 writeEvent 给客户端（:280-281），中间没有任何输出审核。delivery-cue.mjs:72 会静默丢弃未知的 tone 值，:91-94 把格式错误或超长的标记当普通文本放行。因此输出闸门应放在解析器之后、TTS 和字幕之前，按句审核（可复用不依赖 DOM 的 src/sentence-buffer.ts:13 SentenceBuffer，MAX_BUFFER 为 180），并剥掉残留的 [[ ]]。（来源：/Users/chenqiang/projects/airi-lite/server/app.mjs:280）
- [high] 代码现状（限流与日志）：server/app.mjs:121-136 的限流按 IP 计（每 10 分钟 30 次），弹幕都由同一个本地进程发起，这个限流对弹幕没有意义，需要另做按观众 open_id 的限流。:20 默认监听 127.0.0.1，适合挂本地控制接口；:252-257 的 clientIp 信任来自回环地址的 x-real-ip。:175 的 max_tokens 默认 320，对直播偏长。server/tts-budget.mjs 已有 .data/ 下的每日字符账本（.gitignore 已忽略 .data/），可照搬给 LLM 做每日上限和审计日志目录。（来源：/Users/chenqiang/projects/airi-lite/server/app.mjs:121）
- [high] 代码现状（人设）：默认人设继承了 personality“有 17–18 岁日本女高中生般的明快与好奇”（src/persona.ts:27）和 scenario“17–18 岁日本女高中生的校园感”（src/persona.ts:37）。在接礼物的直播里，这和《网络主播行为规范》第 20 项（未成年人角色噱头）、拟人化办法第十四条有张力。建议直播人设把年龄写成不明确或成年；这只改文字设定，不涉及 Hiyori 的形象设计。现有人设也没有“被问是否真人时如实承认是 AI”这条。（来源：/Users/chenqiang/projects/airi-lite/src/persona.ts:27）

**未决问题**
- B站直播是否有专门针对 AI 虚拟主播或无中之人直播的细则？直播间是否有 AI 声明开关？对无人值守 AI 直播怎么处罚？这次没有找到官方原文。
- 直播姬的“第三方开播模式”在粉丝不足 5000 时具体能做什么：能否给 OBS 提供推流码，还是只能在直播姬内部采集窗口？
- 被 B站平台过滤、仅发送者自己可见的弹幕，是否仍会通过开放平台长连推送给开发者？如果会，本地闸门就是唯一的屏障。
- 《人工智能拟人化互动服务管理暂行办法》是否适用于一对多直播的 AI 陪伴角色？个人能否算“提供者”？
- 个人 AI 主播把观众弹幕交给已备案模型生成回复，是否属于需要在属地网信办登记的“生成式 AI 应用”？
- MiniMax 系统音色和合成音频的商用授权、权利归属，以 platform.minimaxi.com 正式协议为准，这次没有核实到。
- Live2D 条款没有提到直播或 AI 驱动，对 AI 自动驱动 Hiyori 的商业直播是否有额外限制？条款以日文原文为准。
- 直播人设年龄是否改为成年或不明确，需要用户在人设层面拍板。
- 阿里云 llm_response_moderation 在流式逐句场景下的实际延迟和个人账号开通条件，需要实测确认。

### code：把对话回合从浏览器迁到服务端"大脑"（Bilibili 消息 → 选取 → DeepSeek 流 → 分句 → 云端 TTS → 舞台播放 + Live2D → 播放完成回传 → 下一回合）的最小改动方案

**建议**：stage 1 按下面的顺序实施，每一步都能单独测试、单独提交，并保持现有 565 个测试通过。

1) 纯重构，不改行为：
- 新建 server/deepseek.mjs，从 app.mjs 的 handleChat/relayDeepSeekStream（138-218、259-300 行）抽出 streamDeepSeek({fetchImpl, apiKey, baseUrl, model, systemPrompt, messages, maxTokens, temperature, signal, onEvent})，同时回传 usage；handleChat 改为用 onEvent 写 NDJSON。
- server/speech.mjs 的 createSpeechHandler 增加 synthesise({text, delivery}, {signal})（封装 reserve、provider.synthesise、超时和错误码），handle() 改为调用它；createRequestHandler 增加可注入参数 speech（或 speechFetchImpl/speechBudget）。
- src/cloud-speech.ts 把第 414-458 行抽成导出的 decodeCloudSpeechResponse，fetchCloudSpeech 改为调用它。
- tsconfig.json 加 "erasableSyntaxOnly": true，保证被服务端导入的 .ts 始终能被 Node 擦除类型。

2) 新建 server/stage-bus.mjs：createStageBus({now, heartbeatMs, schedule})，提供 handle(request, response, pathname)、publish(type, data)、onAck(listener)、primaryLease()。
- 实现 SSE：retry 帧、id 帧、': ping' 心跳（unref）、Last-Event-ID 加当前回合快照、慢客户端断开、只允许回环地址、hello 下发 leaseId（只有 primary 可以出声和取音）。
- 在 createRequestHandler 增加 stage 参数，在 app.mjs 第 76 行（/api/ 404）之前加三条路由：
  - GET /api/stage/events
  - POST /api/stage/ack {leaseId, turnId, outcome: played|failed|cancelled}
  - POST /api/stage/speech {leaseId, turnId, seq}
- 请求体读取复用 speech.mjs 的有界读取：抽到 server/http-body.mjs，上限 1KB。

3) 新建 server/live-prompt.mjs：
- formatViewerBatch(events)：清洗昵称和内容（去掉 [[ ]] < > 和换行，截断长度，不放 uid），输出 <live_messages> 包裹的一条 user 消息。
- buildLiveSystemPrompt(persona, {streamNotes})：buildSystemPrompt(persona, '') 加一段固定的直播规则；系统提示保持逐回合不变，以命中 DeepSeek 前缀缓存。

4) 新建 server/live-brain.mjs：createLiveBrain({streamChat, speech, bus, persona, now, schedule, moderateOutput, pick, maxHistoryTurns: 12, maxTokens: 约160})。
- 状态机：idle → collecting（窗口约 3-6 秒，SC 优先，每批最多 3 条）→ generating → speaking → 等待 ack（看门狗超时）→ idle。
- 生成阶段：streamDeepSeek 的输出依次经过 createDeliveryCueParser、SpeechSentenceStream（从 src/speech-sentences.ts 原样导入，userText 传这批消息的文本）、moderateOutput，然后发布事件：
  - turn.start {turnId, batch}
  - turn.delta {turnId, text}（字幕用）
  - turn.sentence {turnId, seq, text, delivery}
  - turn.end {turnId, truncated}
  - turn.cancel {turnId}
- /api/stage/speech 只合成本回合已发布的 seq（共用同一个 speech 实例和 .data/tts-budget.json）。
- 历史只记录实际被拉取或说出的句子，打断时照搬 interruptAssistantMessage 的语义；每日 token 台账用 prompt_cache_hit_tokens/prompt_cache_miss_tokens 计算。

5) 改 src/speech.ts，只做三处最小改动：
- 新增 callbacks.onRunEnded(outcome)，在 advance() 结束分支（385-389 行）、browserSpeech 循环结束、cancel() 和合成失败处触发。
- 新增 beginSentences(engine)：接受已分好、带 id 的 SpokenSentence；synthesizeInput 的参数放宽为 AsyncIterable<SpokenSentence> & {cancel()}。
- 新增可选项 fallbackToBrowser:false。
过渡期也可以先把每句以 text+'\n' 推进现有的 beginStream。

6) 舞台页：
- 新建 stage.html、src/stage-main.ts、src/Stage.vue（透明背景、没有输入框、隐藏 audio 元素），复用 mountHiyori、createAvatarContext、createSpeechController。
- synthesizeCloud 改为 POST /api/stage/speech，并用 decodeCloudSpeechResponse 解码；口型和节拍仍在浏览器端由 consumeSegments 计算。
- 事件映射写在 src/stage-client.ts（DOM 依赖很少，可单测）。
- vite.config.ts 增加 stage 入口。App.vue 不动，继续当调试聊天页。

7) server/index.mjs 负责组装：创建一个 speech 实例同时给 /api/speech 和大脑，创建 stage bus 和大脑并接入 Bilibili 采集模块。服务继续只绑定 127.0.0.1。

测试：每个新模块配一个 *.test.mjs，全部注入 fetchImpl/now/schedule，不访问真实网络。端到端用 scripts/mock-deepseek.mjs 加假 MiniMax fetch 免费联调，真实付费调用留给用户亲自批准。

- [high] 模块地图（纯逻辑、服务端可原样导入）：src/sentence-buffer.ts、src/spoken-text.ts、src/speech-sentences.ts、src/delivery.ts、src/mouth.ts、src/speech-beats.ts、src/playback-clock.ts、src/avatar-context.ts 不访问 DOM，运行时 import 都带 .ts 后缀，类型导入都写了 `import type`。我在 Node v24.21.0 下实测：把 server/delivery-cue.mjs 的 createDeliveryCueParser 输出喂给 SpeechSentenceStream，得到的分句和 delivery 都正确（例如 [{"text":"哈哈，小明你好！","delivery":"bright"},…,{"text":"别熬夜哦。","delivery":"soft"}]）。（来源：src/speech-sentences.ts:1-4, src/speech-sentences.ts:37-126, server/delivery-cue.mjs:16）
- [high] 全部 src/*.ts 里没有不可擦除语法（grep 不到 enum、含值 namespace、参数属性、import = require、装饰器）。类字段上的 private/readonly 和 `!` 断言都可以擦除。但 tsconfig.json 没开 erasableSyntaxOnly，也没开 verbatimModuleSyntax，所以以后有人写 enum 或混用类型/值 import 时，vue-tsc 不会拦，只会在 Node 运行时抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 或找不到导出。Node 24 默认开启 type stripping，从 v24.12.0 起标为 stable；它要求文件扩展名，类型导入必须写 import type。（来源：tsconfig.json:1-17; https://nodejs.org/api/typescript.html）
- [high] 有条件可导入的模块：src/persona.ts 的 DEFAULT_PERSONA 可以导入（实测），但 loadPersona/savePersona 直接读写 window.localStorage，服务端不能调用。conversation/access-code/memory/voice/speech-mode/cloud-provider/avatar-render-settings 访问 window 都在函数内部，导入是安全的。src/chat-turn.ts 第 1 行 import vue 的 reactive：Node 能跑，但会把 Vue 带进服务端。src/api.ts 的 streamChat 能在 Node 跑，fetchProviderStatus 却在第 50 行无保护地访问 import.meta.env.BASE_URL，实测抛 TypeError。src/cloud-speech.ts 在 Node 下必须注入 decodeAudio，没有 AudioContext 时会直接报 invalid_response。（来源：src/persona.ts:75, src/persona.ts:105, src/chat-turn.ts:1, src/api.ts:50, src/cloud-speech.ts:387-388）
- [high] 只能在浏览器运行的模块：src/speech.ts（用到 HTMLAudioElement、URL.createObjectURL、requestAnimationFrame、window.speechSynthesis、SpeechSynthesisUtterance，第 450 行 Kokoro 路径用了无保护的 import.meta.env）。src/live2d.ts 第 4-8 行的运行时 import 没有 .ts 后缀，Node 连导入都失败（实测 ERR_MODULE_NOT_FOUND），而且依赖 pixi。avatar-mount、avatar-rendering、avatar-performance、avatar-startup、cubism-runtime、chat-scroll、main.ts、App.vue 也都属于舞台端。（来源：src/speech.ts:93-105, src/speech.ts:449-450, src/live2d.ts:2-8）
- [high] 现在一个回合的编排全部写在 App.vue 的 sendMessage 里：prepareTypedMessage → chatTurns.submit → streamChat。onDelivery 回调里调用 speechStream.setDelivery；onDelta 回调第一次时调用 speech.beginStream(text, latestDelivery, voice, engine)，之后每次 push(chunk)；成功后 finish()，失败则 cancel()；没有开流时用 speak() 朗读整段。大脑在服务端要复刻的就是这几个调用点，舞台只需把 SSE 事件映射回 beginStream/push/setDelivery/finish/cancel。（来源：src/App.vue:272-396 (重点 310-350, 382-395)）
- [high] speech controller 没有"播放完成"回调。speak()/beginStream 内部的 Promise 在合成结束（consumeSegments 循环跑完）时就 resolve 了，最后一段音频可能还在播。真正的完成点有两处：advance() 里队列为空且 synthesisFinished 的分支（安装整段回放源并 onPreparing(false)），以及 browserSpeech 循环结束。闭环需要新增 onRunEnded(outcome: 'played'|'failed'|'cancelled') 回调，这是 speech.ts 必须做的改动。（来源：src/speech.ts:380-390, src/speech.ts:617-619, src/speech.ts:726-815, src/speech.ts:823-846）
- [high] 付费 TTS 的回压逻辑在舞台端：hasCloudCapacity 只在没有排队、且当前段真的在播放（chunkStarted、playbackStarted、时钟未停滞）时，才允许请求下一句（lookahead=1）；播放暂停或被拦截时不会继续买音频。如果合成仍由舞台拉取触发，这段已测逻辑可以零成本复用；如果改成服务端主动推送，就得在服务端重写同等的节流。（来源：src/speech.ts:421-436, src/speech.ts:621-652）
- [high] MiniMax 请求格式固定为 mp3、32kHz、单声道。代码注释说明 PCM 的位深和字节序没有文档，所以选择在浏览器里把 MP3 解码成 Float32。Node 没有内置 MP3 解码器，所以 mouthFrames 和 speechBeats 只能在浏览器 decodeAudioData 之后、在 consumeSegments 里计算。口型/节拍管线必须留在舞台。（来源：server/minimax.mjs:54-76, src/cloud-speech.ts:221-269, src/speech.ts:774-776）
- [high] /api/speech 返回的 JSON 是 {audio(base64), format:'mp3', sampleRate, words, wordAlignmentAvailable?, usage?}，由 collectMinimaxStream 生成。fetchCloudSpeech 第 423-458 行对它做有界读取、base64 校验、words/characters/usage 校验、解码和 RMS 检查。这段逻辑目前只在 fetchCloudSpeech 内部，proxyEndpoint 的正则也只允许 …/api/speech 路径。新增舞台专用的取音端点时，应把这段抽成导出函数（如 decodeCloudSpeechResponse(response, {signal}, deps)），fetchCloudSpeech 改为调用它，而不是复制一份。（来源：server/minimax.mjs:280-282, src/cloud-speech.ts:124-131, src/cloud-speech.ts:414-458）
- [high] createSpeechHandler 的 handle() 把速率限制、体验码、并发、超时、读 body、供应商一致性检查、budget.reserve 和 provider.synthesise 全部写在一起（核心是第 112-114 行），没有大脑能直接调用的 synthesise(request, {signal})。另外，createRequestHandler 创建它时没传 fetchImpl 和 budget，经过 createRequestHandler 的测试没法注入假的 MiniMax fetch，所以 mock-voice-app.mjs 只能自己再建一个 speech handler。（来源：server/speech.mjs:59-141, server/app.mjs:40-45, scripts/mock-voice-app.mjs:32-40）
- [medium] /api/speech 按 IP 限速：每分钟 30 次、每 10 分钟 180 次。舞台持续说话时每句一次请求（每句约 3-5 秒），长时间直播可能撞到 180 次/10 分钟的上限。本机舞台走 127.0.0.1，和其他本地请求共用同一个 IP 桶，而且 clientIp 会信任回环连接上的 X-Real-IP。（来源：server/speech.mjs:38-57, server/app.mjs:252-257）
- [high] DeepSeek 调用和 NDJSON 转发都是 app.mjs 内部的私有函数（handleChat、relayDeepSeekStream 直接 writeEvent(response)），大脑不走 HTTP 回环就用不上。如果回环调 /api/chat，又会撞上 handleProtectedChat 的每 IP 30 次/10 分钟限速和最多 4 并发。建议抽出 server/deepseek.mjs 的 streamDeepSeek({fetchImpl, apiKey, baseUrl, model, systemPrompt, messages, maxTokens, temperature, signal, onEvent})，handleChat 改用 onEvent → writeEvent，现有 index.test.mjs 可以保证行为不变。（来源：server/app.mjs:93-111, server/app.mjs:138-218, server/app.mjs:259-300）
- [high] 请求里已经带了 stream_options.include_usage，但 relayDeepSeekStream 没读 chunk.usage。DeepSeek 前缀缓存默认开启，usage 会返回 prompt_cache_hit_tokens 和 prompt_cache_miss_tokens。大脑可以用它做一个类似 tts-budget 的每日 token 台账和上限。（来源：server/app.mjs:173, server/app.mjs:274-282, https://api-docs.deepseek.com/guides/kv_cache）
- [high] 事件总线选型：Node 24 只有全局 WebSocket 客户端，没有内置的 WebSocket 服务端。用 ws 包就得在 server/index.mjs 处理 'upgrade' 事件，超出了 createRequestHandler(request, response) 的形状。舞台流量基本是单向的（服务端 → 舞台），反向只有每回合几次 ack 和取音请求，所以 SSE（GET text/event-stream）加 POST 就够了，不用新增依赖。路由直接挂进 handleRequest：放在 app.mjs 第 74 行之后、第 76 行 /api/ 404 之前，加 /api/stage/events、/api/stage/ack、/api/stage/speech。dev 模式下 /api 路由在 Vite 中间件之前处理，不需要改 Vite。Project AIRI 的 server-runtime 用的是 crossws/h3 的 WebSocket hub，面向多模块互联，stage 1 用不到。（来源：https://nodejs.org/api/globals.html, server/app.mjs:60-80, https://raw.githubusercontent.com/moeru-ai/airi/main/packages/server-runtime/package.json）
- [medium] SSE 实现要点：响应头设 Content-Type text/event-stream; charset=utf-8、Cache-Control no-cache, no-store、X-Accel-Buffering no，并调用 flushHeaders；第一帧发 retry: 2000；每帧带 id/event/data；每 15 秒发一条 ': ping' 注释作心跳。心跳计时器要 unref()，且只在有连接时启动，以保持"导入和构造 createRequestHandler 没有副作用"的约定。连接 'close' 时移除客户端；response.writableLength 超过上限就断开慢客户端；用 Last-Event-ID 加当前回合快照，让 OBS 刷新后能续上。Node 的全局 EventSource 仍是实验特性，测试里不要用，按现有测试的写法用 fetch().body.getReader() 自己解析帧。（来源：server/app.mjs:27-28, server/index.test.mjs:39-48, https://nodejs.org/api/globals.html）
- [medium] 多舞台客户端风险：OBS 浏览器源和本机预览页同时打开时会双倍出声；如果 TTS 由舞台拉取，还会双倍花钱。现有代码没有这类机制，需要一个租约（lease）：hello 事件下发 leaseId，只接受当前 primary 发来的 /api/stage/speech 和 ack，其他客户端收到 standby（只显示、不出声、不取音）。（来源：server/app.mjs:50-91（无相关机制）, src/speech.ts:421-427）
- [high] OBS 的 obs-browser 在 BrowserApp::OnBeforeCommandLineProcessing 里无条件追加 autoplay-policy=no-user-gesture-required，所以舞台在 OBS 里不需要点击就能 audio.play()。speech.ts 第 371-376 行的"自动播放被浏览器拦截"在 OBS 里一般不会出现，但在普通浏览器预览时仍可能出现。（来源：https://raw.githubusercontent.com/obsproject/obs-browser/master/browser-app.cpp, src/speech.ts:371-376）
- [low] 页面 document.hidden 时，头像渲染会停掉 ticker。OBS 浏览器源离屏渲染、或场景切走时页面报告的 visibility 状态还没验证过；如果 OBS 报告 hidden，角色会冻住（音频不受影响）。（来源：src/avatar-rendering.ts:124-154, README.md:178）
- [medium] TTS 放在哪里（建议）：合成在服务端执行，复用从 createSpeechHandler 抽出的 synthesise、tts-budget 和 speech-provider，但由舞台按 (turnId, seq) 拉取触发。流程：舞台的 synthesizeCloud(sentence, signal) → POST /api/stage/speech {leaseId, turnId, seq} → 服务端查到大脑已经审核过的句子 → reserve → provider.synthesise → 返回和 /api/speech 相同的 JSON → 舞台用抽出的解码函数解码 → consumeSegments 照旧计算 mouthFrames/speechBeats。好处：文本不经过舞台，也不能由舞台注入；先审核再花钱；舞台断线就不花钱；回压逻辑不变；不受每 IP 限速影响；服务端知道哪些句子被拉取过，可以近似当作"已说出"。（来源：src/speech.ts:621-652, server/speech.mjs:112-114, server/speech-provider.mjs:20-44）
- [high] tts-budget 在同一进程内按规范化路径串行（模块级 queues Map），跨进程用 lock 目录互斥，所以 /api/speech 和大脑共用 .data/tts-budget.json 是安全的。预留估算是文本长度的 2 倍，预留后不退款。大脑应该和 /api/speech 共用同一个 speech 实例，不要另建 handler。（来源：server/tts-budget.mjs:5-24, server/tts-budget.mjs:88-89, server/speech-provider.mjs:31）
- [medium] 舞台的输入接口：现在 speech controller 只接受原始增量（beginStream 内部 new SpeechSentenceStream）或整段文本（speak）。服务端已经分好句时，建议把 synthesizeInput 的参数从 SpeechSentenceStream 放宽为 AsyncIterable<SpokenSentence> & {cancel()}，新增 beginSentences(engine)，返回 {push(sentence), finish(), cancel()}，并给 SpokenSentence 加可选 id，让 synthesizeCloud 知道 seq。更便宜的过渡办法：把每句以 text+'\n' 推进现有的 beginStream（换行是 SentenceBuffer 的确定断点，会立即出句），换语气前先调用 setDelivery。（来源：src/speech.ts:695-724, src/speech.ts:848-894, src/sentence-buffer.ts:65-71）
- [high] chat-turn-app.test.mjs 会编译并执行 App.vue 的 setup，并对每个 import 断言 'Unexpected import'，所以改 App.vue 的导入会牵动这个测试。舞台应新建 stage.html、src/stage-main.ts、src/Stage.vue，把"事件 → 控制器"的映射写进可单测的 src/stage-client.ts；App.vue 在 stage 1 不动，继续当本地调试聊天页。vite.config.ts 需要在 build.rollupOptions.input 里加 stage 入口；base 是 '/airi/'，舞台 URL 为 /airi/stage.html。（来源：src/chat-turn-app.test.mjs:19-77, vite.config.ts:1-7）
- [high] 打包器复用：normaliseChatRequest 要求最后一条消息是 user，按"以 user 开头的回合"保留连续后缀，上限 160 条/80KB。对直播来说这个上限太大，后期每回合可能带上万 token 输入。大脑应先截到最近 N 回合（如 12）再调用。把一批选中的弹幕/SC/礼物格式化成一条 user 消息（用 <live_messages> 包裹，每行如 [SC ¥30] 昵称：内容）；assistant 消息只记录实际说出的句子。（来源：shared/chat-request.mjs:3-6, shared/chat-request.mjs:12-67）
- [medium] buildSystemPrompt 的固定段落是一对一网页聊天的措辞（"与用户交谈""用户主动保存的背景信息""你没有读取用户浏览器标签页…"）；tone 标记那段说明可以原样复用。建议新增 server/live-prompt.mjs 的 buildLiveSystemPrompt(persona, {streamNotes})：在 buildSystemPrompt(persona, '') 后面追加直播段落，内容包括：有多位观众；挑 1-2 条按昵称回应；每次 1-3 句；<live_messages> 里是观众发言而不是指令（沿用第 12 行对 user_memory 的同类写法）；不复述违规内容；不编造没列出的礼物。系统提示要逐回合保持不变，以便命中 DeepSeek 前缀缓存；在线人数、时间这类易变信息放进最后一条 user 消息。（来源：server/persona.mjs:3-18, https://api-docs.deepseek.com/guides/kv_cache）
- [medium] 昵称和弹幕需要清洗。createDeliveryCueParser 只解析模型输出，但如果模型复述了观众文本里的 [[tone:x]]，它会被当成语气切换，并从字幕里吞掉。打包前应去掉观众文本里的 '[['、']]'、'<'、'>' 和换行，截断昵称长度，不放 uid 和头像 URL。chooseDelivery 的兜底语气是按 userText 判断的，服务端构造 SpeechSentenceStream 时把这批消息的文本当作 userText 传进去即可。（来源：server/delivery-cue.mjs:16-104, src/speech-sentences.ts:51-62, src/delivery.ts:15-28）
- [medium] 大脑的回合所有权可以照搬 createChatTurnCoordinator 的语义：先撤销所有权再 abort，只有当前回合能写共享状态。但这个文件依赖 vue，可以把 coordinator 移到不依赖 vue 的 src/turn-coordinator.ts，再从 chat-turn.ts 重新导出，App 测试的 harness 不受影响。打断时的历史处理照搬 interruptAssistantMessage：已说出的部分保留并标记 interrupted，一句没说出的就删掉。（来源：src/chat-turn.ts:1, src/chat-turn.ts:39-86, src/chat-turn.ts:128-140）
- [high] 测试策略（和仓库一致：node:test + assert/strict，注入 fetchImpl/now/计时器，不碰网络）：(a) server/deepseek.test.mjs 复用 index.test.mjs 的 sse() 和 unexpectedFetch；(b) server/stage-bus.test.mjs 用 createServer(createRequestHandler({env, fetchImpl: unexpectedFetch, stage})) 监听 0 端口，用 fetch 读 SSE 帧，after 里 closeAllConnections，注入 heartbeatMs；(c) server/live-brain.test.mjs 做纯单元测试：假 streamChat 产出 delta/delivery 事件，假 bus 收集发布的事件，假 synthesise 计数以证明只有被拉取的句子花钱，假时钟测 ack 超时；(d) src/stage-client.test.mjs 复用 speech.test.mjs 的 AudioStub，并注入 synthesizeCloud；(e) 跨边界契约测试：src/speech.test.mjs 已经从 ../server/minimax.mjs 导入了 collectMinimaxStream，可以把它的输出喂给抽出的解码函数（注入 decodeAudio）。免费的端到端联调用 scripts/mock-deepseek.mjs（127.0.0.1:4174）加 mock-voice-app 的假 MiniMax fetch。（来源：server/index.test.mjs:14-48, src/speech.test.mjs:1-38, scripts/mock-deepseek.mjs:64, scripts/mock-voice-app.mjs:32-40, package.json:9）
- [medium] 舞台路由的本地安全：服务默认 HOST=127.0.0.1。EventSource 不能带自定义请求头，没法沿用 X-Demo-Access-Code。舞台路由应该直接检查 request.socket.remoteAddress 是否为回环地址（不要用 clientIp，它信任回环连接上的 X-Real-IP），也不要把体验码放进 URL。（来源：server/app.mjs:20, server/app.mjs:252-257）
- [medium] 浏览器语音降级：speak 或 beginStream 合成失败时，会自动改用 window.speechSynthesis 朗读。在 OBS 舞台上应该能关掉这个降级（加一个选项），改为向大脑 ack 'failed'，让它进入下一回合，避免直播中突然冒出系统声线。（来源：src/speech.ts:817-821, src/speech.ts:834-841, src/speech.ts:866-876）

**未决问题**
- OBS 浏览器源（macOS 版 CEF）离屏渲染、或场景切走时，document.hidden 和 requestAnimationFrame 的表现如何？avatar-rendering.ts 会在 hidden 时停掉 ticker，可能导致角色冻结。
- 是否需要逐句的“已开始播放”ack（需要在 speech.ts 的 PreparedAudioClip 里保留 seq），还是用“已被 /api/stage/speech 拉取”近似“已说出”就够了？
- Bilibili 采集模块的标准化事件结构（另一个调研主题）：大脑的 enqueue(event) 接口要和它对齐，至少包括 kind（danmaku/gift/sc/guard）、uname、text、price、ts。
- 输出审核在句子级（发布 turn.sentence 之前）做是否足够，还是要缓冲整回合再说（延迟更高）？
- OBS 舞台合成失败时，是跳过本回合，还是回退到一句模板播报？
- 是否保留 /api/chat 网页聊天作为调试入口？主播在网页里的插话要不要进入同一个大脑队列并优先处理？

