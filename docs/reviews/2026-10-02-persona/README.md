# 日和普通分享与短回应：追加诊断（2026-10-02）

这一轮保留活泼俏皮与稳定偏好，不增加固定口癖或每轮必讲的笑话。默认卡将“小步骤建议”限定为用户确实找办法时，提醒模型别替普通分享补迟到、损失、内疚等后果；提问也不能偷带未成立的前提，自己的旧猜测不成为用户事实。再加两条有事实依据的短接话示例。

## 实际生成与失败保留

先冻结 [4 个上下文](cases.json)与[三维规则](rubric.md)，各取旧卡与初版候选一次，共 8 次真实 DeepSeek 回复。旧卡是 10-01 shipped card，与本轮开始时的默认卡完全相同；[初版候选](candidate-card.json)不等于最终上线卡。

- 旧卡闹钟回复问“今天有没有因此迟到或者慌了一下”；初版候选不再问，却又写“代价就是醒来那瞬间的懵”。两位复核都标了后者的 unsupported inner experience。这一步没有解决闹钟问题。
- 旧卡错过电车回复加了“站台吹吹风”“别盯着表看了”；初版候选只接十分钟等待，没有继续安慰或安排。
- 旧卡纠正后仍加“翻个身”这个未提供的动作；初版候选只说“闹钟按时上班，你按时回去睡”。
- 旧卡布丁回复“没撑住”的分寸有分歧；不能替 reviewer 强行归为共同失败。

[基线原事件](baseline-replies.jsonl)与[候选原事件](candidate-replies.jsonl)全部保留。随后在[预算 amendment](budget-amendment.md)中冻结再 4 次生成与两份独立复核，不重新抽样挑好回答。最终卡增加例子；复测同一闹钟失败点，再测 3 个不同的分享/普通回应上下文。

最终 4 条[真实输出](final-replies.jsonl)为：

- 闹钟：“按掉到再睡过去，中间那段时间简直是自动完成的。”
- 提前看完电影：“想看就看完了，周末的份额提前用掉。”
- 杯水已经擦好：“水的话还好，擦掉就结束了。”
- 只要普通一句：“那就先这样，普通地待着就好。”

这四条没有再拆解决步骤或追加问题，两位新建 reviewer 均给 fits/fits/clear；不是广泛消除脑补、长期人格稳定或整体自然度的证明。最后一句是否足够自然仍值得真人试听与使用反馈，AI 一致不能替代它。

## 独立复核覆盖与限制

每个 batch 先 prepare，生成不同 blind IDs、顺序与哈希；之后才调用两个无历史 agent。它们只读自己的 packet 与冻结规则，不读版本映射、卡片、另一位评价。后续 4 条使用两个新的无历史 agent，不沿用看过初版结果的 reviewer。orchestrator 不投票、不自动采用 reviewer rewrite。

| batch | register 一致 | attunement 一致 | grounding 一致 | 条目 assignment |
| --- | --- | --- | --- | --- |
| 旧卡/初版 8 条 | 8/8 | 7/8 | 6/8 | 16 |
| 最终卡 4 条 | 4/4 | 4/4 | 4/4 | 8 |

前一 batch 的 3 个分歧字段来自旧卡电车 grounding、旧卡布丁 attunement/grounding；保留待人工判断，不做 field adjudication。helper 给 9 个 silver 字段、15 个 provisional 字段、0 个缺失字段；后者包含带 issue 条目的共同判断，不全是分歧。最终 batch 为 12 个 silver 字段。`unresolved_fields=0` 仅是 helper 聚合状态，不表示所有条目合格或人工争议已解决。

校准路由 3/8 与 3/4，固定随机审计 3/8 与 1/4；小分层取整扩大了份额。选中 ID、每维一致数和哈希在 [routing-and-agreement.json](routing-and-agreement.json)。它们不是已执行真人校准。问题条目加固定审计形成 8 条不同输出的人工队列，全部待审；真人标签 = 0。

总计真实生成 12 次、4 个独立 reviewer batches、24 个条目 assignments、0 次 malformed retry、0 次字段仲裁。health/requested model 是 deepseek-flash；上游精确修订、native token usage/计费与 reviewer 精确修订/用量不可见，均不猜测。原始 agent final 输出与规范化标签分别保存；应用 NDJSON 不是 provider-native response。[provenance](reviewer-provenance.json)记录卡片与相同服务端提示词/runner 哈希。

前 8 条不是随机对照，最终 4 条也不是盲测或 held-out benchmark；修改已看过失败。历史 assistant 只是人工夹具。此检查不覆盖真实语音自然度、手机性能、长时间连续对话或所有任务请求。

## 迁移与发布

- 旧 10-01 默认卡按全字段精确匹配升级。8 个字段逐一自定义/清空与字符串额外键测试均保留原卡；不会强改用户人格。原加载逻辑仍只接受字符串字段，非字符串额外键会被过滤，但不会触发默认迁移。
- 完整测试 317/317，TypeScript 与生产构建通过；原有 bundle-size warning 仍在，不据此声称实际手机流畅。
- [线上 demo](https://mmturingtest.online/airi/)已发布最终卡。主 JS `index-Dl6PLNKu.js` 的本地、VPS 与公开 HTTPS 内容 SHA-256 均为 `b07e6352cc354f36e1c2ae7cd0e8bae1e2e98cfd1c94d8d7f3bcc1cf9c512c20`。
- 发布前在独立 staging 用现有服务器环境核验新语音配置仍为 MiniMax、configured=false；只同步 server/shared/dist，未同步 .env/.data，角色素材保留。服务重启成功，公开 health 仍为 DeepSeek configured=true、体验码保护开启、语音 configured=false。
- 旧运行时代码与构建备份留在 VPS `/opt/airi-lite/backups/20261002-persona-before.tar.gz`；环境文件元数据在同步前后相同。Eleven v4 adapter 现已随代码部署，但未启用、未调用真实语音或变更账户许可。
- 实际浏览器能加载 Hiyori、新默认偏好/行为边界/示例编辑器，无 warning/error；未解锁或发送额外对话。浏览器观察与前面的 12 次真实生成是独立验证项。

广义拟人化目标仍未完成：声线与情绪需用户选定账户后真实试听，精确音素嘴形、长期行为及真实移动设备仍需验证。不能把这轮短回复或 AI 一致当成 VTuber/Turing-test 级验收。
