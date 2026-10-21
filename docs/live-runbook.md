# AIRI 开播手册

适用于第一阶段 M3「人工转述」直播：B 站弹幕还没有接进服务（开放平台客户端在 M5 接入），观众的话由主播在控制台「对她说」里转述，或者直接用「让她照读」。推流主机可以是这台 Mac，也可以是 Windows + NVIDIA 的电脑；观众只在 B 站看。

> 本手册里的 Windows 步骤还没有在 Windows 上实际跑过，第一次在 Windows 开播前请先完整彩排一次（见[零费用彩排](#零费用彩排)）。

## 一次性准备

两种主机都要做：

1. **Node 24**：Mac 用 Homebrew；Windows 从 nodejs.org 装 24.x 的 LTS 安装包。然后在项目目录按锁文件装依赖（不需要全局安装 pnpm，也不需要管理员权限）：
   ```bash
   npx pnpm@10.33.0 install --frozen-lockfile
   ```
2. **Hiyori 模型**：按 README 的说明把官方 `hiyori_free/runtime/` 的内容放进 `public/models/hiyori/`（仓库里没有模型文件）。没有它，舞台会一直报「形象载入失败」。
3. **OBS Studio 32.x**（Mac 选 Apple 芯片版）。
4. **`.env.local`**：在项目根目录自己创建，变量见下面的[环境变量](#环境变量)。不要把内容贴到聊天里，也不要提交到 Git。
5. **屏蔽词**：新建 `.data/moderation/blocklist.txt`，每行一个词。前缀 `drop:`（默认，命中就不说）、`avoid:`、`crisis:` 区分类别，`#` 后面是注释。服务只在启动时读这个文件，改了要重启。开播预检要求这里至少有一条可用的词。
6. **MiniMax 每分钟请求数**（`cloud` 档位）：首播前在 MiniMax 控制台确认账号的 RPM（官方文档：国内站免费账号 10、充值账号 20，主账号和子账号共用），直播和网页聊天用的是同一个 Key。超了的那一段会等 4 秒重试一次，控制台「当前」栏显示「语音提示：MiniMax 每分钟请求数到上限…」；经常出现就向 MiniMax 申请提额（官方说要 3–5 个工作日）。

Windows 额外注意：

- 项目不要放在 OneDrive 同步的文件夹里（「桌面」「文档」常被重定向到 OneDrive）。同步程序会锁住 `.data/` 里的账本文件，导致额度记录失败、语音全部被拒。建议放在 `C:\airi-lite` 这类本地目录。
- 下面的命令在 PowerShell 里执行。服务只监听 `127.0.0.1`，不需要放行防火墙；跑本地 TTS 时如果引擎在另一台机器上，才需要给那台机器的端口放行局域网访问。

## 环境变量

都写在 `.env.local` 里。`npm run live` 会自己设 `NODE_ENV=production` 和 `AIRI_LIVE=1`，`.env.local` 里的同名值不会覆盖它们。

| 变量 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `AIRI_LIVE` | 由 `npm run live` 设置 | — | `1` 才开启直播接口。部署到服务器的网页版永远不要设。 |
| `AIRI_PROFILE` | 否 | `cloud` | 主机档位：`cloud`（云端语音，例如这台 Mac + MiniMax）或 `local-voice`（本机/局域网 TTS 引擎，例如 Windows + NVIDIA）。写错会让预检失败。 |
| `HOST` | 否 | `127.0.0.1` | 直播模式只允许回环地址，否则服务拒绝启动。 |
| `PORT` | 否 | `5173` | 改了以后，下面所有网址里的 5173 一起改。 |
| `AIRI_DEMO_ACCESS_CODE` | **是** | — | production 模式启动必须有，至少 16 个字符的随机字符串（保护网页聊天的花费）。 |
| `DEEPSEEK_API_KEY` | 是 | — | 大脑用的 DeepSeek 密钥。没有它预检不过、不会生成回复。 |
| `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL` | 否 | `deepseek-flash` / `https://api.deepseek.com` | |
| `LIVE_DAILY_REPLY_LIMIT` | 否 | `250`（1–5000） | 每天最多调用几次大脑（含失败和中止的调用），记在 `.data/live-reply-budget.json`。用完自动暂停。 |
| `LIVE_MAX_TOKENS` | 否 | `160`（32–400） | 每条直播回复的最大输出 token。 |
| `LIVE_JOIN_SENTENCES` | 否 | 开 | 一条回复里语气相同的相邻句子合成一次（一段最多 60 字），句与句之间的语调不再断开。控制台显示「已取音 3/3 句（1 段）」：句是字幕和记忆的单位，段是实际的语音请求。设 `0` 回到一句一请求。 |
| `TTS_PROVIDER` | 否 | `minimax` | `minimax`、`elevenlabs` 或 `local`（`local-voice` 档位用）。 |
| `MINIMAX_TTS_ENABLED`、`MINIMAX_API_KEY`、`MINIMAX_VOICE_ID`、`MINIMAX_TTS_DAILY_CHAR_LIMIT` | `cloud` 档位必需 | `MINIMAX_TTS_ENABLED=0` | 四项都要填，`ENABLED=1` 才会花钱。可选 `MINIMAX_TTS_MODEL`（`speech-2.8-turbo`）、`MINIMAX_TTS_REGION`（`cn`）、`MINIMAX_PRONUNCIATION`（默认开：句子里出现「日和」「Hiyori」这类词时附带读音表，词表在 `server/minimax-pronunciation.mjs`；读错时设 `0` 关掉）。细节见 `.env.example`。 |
| `LOCAL_TTS_URL` 等 `LOCAL_TTS_*` | `local-voice` 档位必需 | — | 本地 TTS 引擎的基础地址，例如 `http://127.0.0.1:9880`（程序会接上 OpenAI 兼容的 `/v1/audio/speech`）；还要 `LOCAL_TTS_ENABLED=1`、`LOCAL_TTS_MODEL`、`LOCAL_TTS_VOICE`，其余见 `docs/local-tts.md` 和 `.env.example`。预检会对这个地址的主机做一次很轻的 HEAD 请求，确认引擎开着。 |
| `BILIBILI_OPEN_ACCESS_KEY_ID`、`BILIBILI_OPEN_ACCESS_KEY_SECRET`、`BILIBILI_OPEN_APP_ID`、`BILIBILI_OPEN_CODE` | 现在不需要 | — | B 站开放平台凭据。目前只有 `scripts/bili-probe.mjs` 读取，直播服务还不读（M5 接入弹幕时才用）。 |
| `MOCK_LIVE_PORT`、`MOCK_SAY_VOICE`、`MOCK_TTS_LATENCY_MS` | 否 | `4176` / 自动 / 无 | 只给零费用彩排用。`MOCK_TTS_LATENCY_MS=800,40` 让每段假语音晚 800 毫秒 + 每字 40 毫秒才到，模拟云端合成要等的时间，用来看段与段之间会不会断档。 |

每日额度按 UTC 日期计算，也就是北京时间早上 8 点清零。

## 启动

```bash
npm run live
```

它会先做类型检查和构建（`vue-tsc --noEmit`、`vite build`），再用 production 模式启动服务。看到这两行就可以了：

```
AIRI Lite running at http://127.0.0.1:5173/airi/
Live mode: enabled (stage /airi/stage.html, console /airi/console.html)
Live control: paused until 继续 in the console passes the go-live checklist
```

服务启动后是「已暂停」（控制台显示「刚启动，还没开播」），她不会开口，也不会调用 DeepSeek，直到你在控制台点「继续」。

- 已经构建过、只想快速重启（比如处理完残留锁）：`npm run live -- --skip-build`。直播期间不要改代码。
- 停止：在这个终端按一次 Ctrl+C，等它自己退出（最多 3 秒）。不要连按两次，也不要直接关窗口：服务需要这点时间写完账本、释放锁，否则下次会出现残留锁。

控制台在同一台电脑的普通浏览器（Chrome、Edge、Safari）里打开：`http://127.0.0.1:5173/airi/console.html`。必须用 `127.0.0.1` 或 `localhost`，从别的电脑或手机打开会被拒绝。

## OBS 浏览器源

Mac 和 Windows 设置相同。新建「浏览器」源：

| 设置 | 值 |
| --- | --- |
| URL | `http://127.0.0.1:5173/airi/stage.html?role=obs` |
| 宽 / 高 | 1920 / 1080 |
| 使用自定义帧率 | 不勾（舞台自己按 30fps 渲染，匹配 1080p30 输出） |
| 通过 OBS 控制音频（Control audio via OBS） | **勾选**，她的声音才会进 OBS 混音器 |
| 当不可见时关闭源（Shutdown source when not visible） | **不勾**，否则切场景后她会冻结、重新连接 |
| 当场景变为活动状态时刷新浏览器 | **不勾** |
| 自定义 CSS | 保留 OBS 默认的透明背景那一行即可 |
| 页面权限 | 默认。若控制台的「OBS」一栏一直是「未检测到 OBS」或状态未知，再试着调高一级 |

然后：

1. **混合方式**：在源上右键 →「混合方式」（Blending Method）→ **SRGB Off**。默认的线性混合会让头发、字幕描边等半透明边缘发黑。
2. **音频路由**：混音器 → 高级音频属性，把这个浏览器源的「音频监听」设为「监听并输出」，戴耳机听（用外放会被麦克风收进去形成回声）。混音器里应该只有这一个她的声音来源。
3. **网址参数**：`&fps=60` 只在 OBS 输出是 60fps 时加；`&captions=0` 隐藏舞台字幕。同一时间只开一个 `role=obs` 的源：最新连上的页面拿到发声权，旧页面自动待命。只想看画面不出声，用 `?role=preview`。
4. Windows 上确认 设置 → 高级 → 来源 →「启用浏览器源硬件加速」是勾上的（默认就是）。
5. 舞台左上角常驻「AI 生成内容 · 回复可能出错」标识，不要用裁剪或遮挡把它盖住。

OBS 会自动播放声音，不需要点页面。用普通浏览器打开舞台时，浏览器的自动播放规则要求先在页面上点一下。

## 推流路线

**粉丝 ≥ 5000：OBS 直推。** 在直播中心开播，拿到推流地址和推流码，填到 OBS 设置 → 直播（服务选「自定义」）。输出 1920×1080、30fps；编码器 Mac 用 Apple VT H264 硬件编码，Windows 用 NVIDIA NVENC H.264；码率按直播中心的推荐值。

**粉丝 < 5000：直播姬。** 从 2025 年 5 月 26 日起，B 站只给 ≥5000 粉的账号开放第三方推流，其余账号只能用官方工具开播（PC 直播姬、手机 App、网页开播）。不要用网上「获取第三方推流码」一类的绕过工具，这违反平台规则。可行的做法是 OBS 负责合成画面，直播姬负责推流：

1. OBS 里照常做好场景（背景 + 舞台浏览器源），点「启动虚拟摄像机」。
2. 直播姬里添加摄像头素材，选「OBS Virtual Camera」，铺满画面。虚拟摄像机没有透明通道，背景要放在 OBS 场景里。
3. 声音：虚拟摄像机**不带声音**，要另外送进直播姬。
   - Windows：让 OBS 的监听设备输出到系统默认声卡，直播姬里打开「系统声音」采集；或者装一个虚拟声卡（如 VB-CABLE），把 OBS 的监听设备设为它，再在直播姬里把它选为麦克风/音频输入。
   - Mac：macOS 不能直接采集系统声音，需要虚拟声卡（如开源的 BlackHole 2ch）：OBS 监听设备选 BlackHole，直播姬里把 BlackHole 选为音频输入。Mac 上直播姬桌面版的可用性和采集方式还没有确认，如果用不了，就把推流放到 Windows 电脑上。
4. 第一次开播前，用直播姬的预览/录制确认画面清晰、只有一路她的声音、口型和声音对得上。

以上直播姬的具体菜单名以你装的版本为准，这一节需要你实测后修正。

## 直播间简介和 AI 标识

《人工智能生成合成内容标识办法》（2025 年 9 月 1 日起施行）要求对 AI 生成的文字、声音、画面、虚拟场景做显式标识。舞台上的常驻标识是画面上的那一层；另外建议：

- **标题**带上「AI 虚拟主播」字样，例如：`【AI 虚拟主播】日和在线陪聊（测试中）`。
- **简介**模板：

  > 本直播间的主播是 AI 虚拟角色：形象为 Live2D 官方免费素材「桃濑日和」，声音由 AI 合成，回复由大模型生成，可能出错，不代表任何真人观点。真人主播全程在场审核，弹幕经过人工挑选后才会被回答。请勿发送手机号、地址等个人信息；不需要打赏或礼物。

- **开场**先用「让她照读」说一句「大家好，我是 AI 虚拟主播日和……」，让只听声音的观众也知道。
- 直播中心或开播设置里如果有「AI 生成内容」之类的声明选项，打开它。

条文细节（声音提示放在哪、虚拟场景怎么标）以官方原文和 B 站当时的规则为准。

## 开播流程

1. 启动 `npm run live`，等它打印 `Live mode: enabled`。服务启动后是「已暂停」。
2. 打开 OBS（舞台源会自动连上），再在浏览器打开控制台。
3. 在控制台的「开播预检」里点「重新检查」，所有项都应该是 ✓（见下表）。
4. 点「继续」：它会再跑一次预检，全部通过才会开始。没通过时控制台列出原因，她保持暂停。
5. 在 OBS（或直播姬）开始推流。控制台的「OBS」一栏应显示「推流中」。
6. 用「让她照读」说开场白；之后用「对她说」转述观众的话，或在「待回答」里逐条「通过」。

### 预检各项

| 项目 | 通过的条件 | 没通过时 |
| --- | --- | --- |
| 主机档位 | `AIRI_PROFILE` 是 `cloud` 或 `local-voice`（不填就是 `cloud`） | 改正拼写后重启。 |
| DeepSeek | 有 `DEEPSEEK_API_KEY` | 写进 `.env.local` 后重启。预检不会真的调用 DeepSeek。 |
| 语音 | 语音服务已配置，且与档位一致：`cloud` 要 MiniMax/ElevenLabs，`local-voice` 要本地 TTS | 按提示补齐变量后重启。 |
| 本地 TTS（仅 `local-voice`） | `LOCAL_TTS_URL` 是本机/局域网地址，且它的主机 1.5 秒内有任何 HTTP 响应 | 先启动引擎，确认地址和端口。 |
| 回复额度 | 今天的 `LIVE_DAILY_REPLY_LIMIT` 还没用完 | 等北京时间早上 8 点重置，或调高额度后重启。 |
| 额度账本 | `.data/` 可写，且没有 15 秒以上的 `*.lock` | 见下面的残留锁处理。 |
| 屏蔽词 | `.data/moderation/blocklist.txt` 读取成功且至少有一条可用的词 | 补好文件后重启。 |
| 舞台 | 有 `role=obs` 的舞台连着并已就绪 | 检查 OBS 浏览器源网址；点「刷新舞台」。 |
| 形象 | 舞台上报 Hiyori 已载入 | 确认模型文件在 `public/models/hiyori/` 并已重新构建；用 Chrome 打开 `stage.html?role=preview`，在开发者工具的控制台看报错。 |
| OBS 源 | 舞台源不是「未激活」（不在节目画面上时她不会开口） | 切到含舞台源的场景。舞台不在 OBS 里（例如用浏览器窗口）时按通过处理并注明。 |

确实需要带着问题开播时（例如还没准备屏蔽词的私下测试），点预检下方的「跳过预检，仍然继续」。跳过和每一次「继续」的预检结果都会写进审计日志 `.data/live-logs/`。

### 残留锁

服务异常退出（被强制结束、断电、连按两次 Ctrl+C）时，可能在 `.data/` 留下 `tts-budget.json.lock`、`live-reply-budget.json.lock` 这样的**文件夹**。只要它在，对应的额度就会一直拒绝，语音或回复全部失败。处理：

1. 确认没有别的 AIRI 服务在跑（另一个终端里的 `npm run live`、`pnpm dev`、`mock-live`）。
2. 在服务终端按一次 Ctrl+C 停止服务。
3. 删除预检里列出的锁（是空文件夹）。

   Mac：
   ```bash
   rmdir .data/tts-budget.json.lock
   ```
   Windows（PowerShell）：
   ```powershell
   Remove-Item .data\tts-budget.json.lock
   ```
4. `npm run live -- --skip-build` 重新启动，再检查一次预检。

## 紧急情况

控制台按钮：

- **停下**：只停当前这句话。
- **暂停**：说完/停下当前这句后不再开口，待回答的消息保留。
- **紧急停止**：立刻停声、清空字幕和待回答队列、丢掉对话上下文，舞台显示「稍后回来」。恢复要点「继续」，会重新跑预检。
- **刷新舞台**：让舞台页面重新载入（形象卡住时用）。更新代码后，旧版本的舞台页面在报告就绪时会被自动要求刷新（控制台显示「舞台页面版本过旧」）；它仍不就绪时再手动点一次。

控制台打不开时，在推流电脑上直接发紧急停止：

Mac：
```bash
curl -X POST http://127.0.0.1:5173/airi/api/live/control -H 'Content-Type: application/json' -H 'X-Airi-Live: 1' -d '{"action":"panic"}'
```

Windows（PowerShell）：
```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5173/airi/api/live/control -ContentType 'application/json' -Headers @{ 'X-Airi-Live' = '1' } -Body '{"action":"panic"}'
```

把 `panic` 换成 `stop`、`pause` 就是对应的按钮。再不行：在 OBS 里把舞台源静音或切到别的场景，或者直接停止推流；最后才在服务终端按 Ctrl+C。

## 收播

1. 在 OBS/直播姬停止推流。
2. 服务终端按一次 Ctrl+C，等它退出。
3. 审计日志在 `.data/live-logs/<UTC 日期>.jsonl`，记录了每条事件（包括观众昵称和原文、每次预检结果），只有本机用户可读，保留 183 天。不要上传或分享整个文件。

## 零费用彩排

```bash
node scripts/mock-live.mjs --replay --speed=10
```

真实的服务、大脑和审核，但 DeepSeek 换成固定的假回复，语音换成假 TTS：Mac 上用系统的 `say`，Windows/Linux 上（或加 `--tone`）用一段随句长变化的正弦波提示音，口型照样会动。不读 `.env.local`，不产生任何费用。端口是 4176：舞台 `http://127.0.0.1:4176/airi/stage.html?role=obs`，控制台 `http://127.0.0.1:4176/airi/console.html`。彩排自带一个示例屏蔽词，预检可以全部通过。彩排和正式开播一样从「已暂停」开始，点「继续」才会开口。加 `--adversarial` 可以看到审核拦下不良回复。

彩排的声音不代表真实语音链路。首播前还要用真实配置合成并试听一次（第一次付费调用前先确认额度）。

## 还没验证的

- Windows 上的整套流程（启动、OBS、直播姬、PowerShell 命令）。
- 直播姬的菜单名、Mac 版直播姬能否使用、虚拟声卡路线的实际效果。
- OBS 页面权限是否影响舞台收到「源激活」事件。
- SRGB Off 对半透明边缘的实际效果（M1 清单里也有这一项）。
