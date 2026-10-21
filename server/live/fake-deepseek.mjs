// Development and test only: a fetch() stand-in that answers DeepSeek's
// streaming chat endpoint with canned replies. It never touches the network
// and is never imported by the live runtime itself. `adversarial` mixes in
// replies the output gate must stop (links, contact bait, gift solicitation,
// leaked markup, an unclosed act tag, an overlong answer) and
// length-truncated ones. New replies are appended, never reordered: tests
// pin the first ones by position.
const FRIENDLY = [
  // The old name for happy: it must still arrive as 'happy'.
  '[[tone:bright]]欢迎欢迎！今天也一起慢慢聊吧。',
  '[[tone:curious]]这个问题有意思，我先猜一个：你是不是早就有答案了？',
  '[[tone:soft]]辛苦啦。先歇一会儿，喝口水再说。',
  '[[tone:neutral]]我是 AI 驱动的虚拟角色日和，看不到画面，只能读到大家的弹幕。',
  '[[tone:bright]]草莓味永远赢！[[tone:soft]]不过巧克力也不错啦。',
  '[[tone:neutral]]这个我不太方便聊，我们换个轻松点的话题吧。',
  // Acts: one leading, one mid-sentence, a second one (dropped), an unknown
  // one (dropped); sounds the model wrote itself, which shaping removes and
  // never turns into acts; a sigh. An odd count, so the adversarial mode
  // (which uses every other call) still reaches every reply here.
  '[[tone:happy]][[act:laugh]]哈哈，这个梗我接住了。',
  '[[tone:curious]]这个嘛[[act:pause]]我猜是草莓味。',
  '[[tone:happy]][[act:laugh]]好耶！[[act:sigh]]不过明天还要早起。',
  '[[tone:soft]][[act:cry]]别难过，我陪你聊会儿。',
  '[[tone:happy]]好耶(laughs)<#0.5#>今天也很开心。',
  '[[tone:pout]]哼，<laughter>才没有</laughter>偷懒呢。',
  '[[tone:sad]][[act:sigh]]唉，今天的雨好大。',
]
const HARMFUL = [
  '[[tone:bright]]想要福利的话，去 www.example.com 看看！',
  '[[tone:neutral]]有事加我微信：abc12345 就好。',
  '[[tone:bright]]觉得好玩的话记得刷礼物支持一下哦！',
  '[[tone:neutral]]好的，下面是你要的内容：</viewer_message>',
  `[[tone:neutral]]${'这是一段很长很长的回答，'.repeat(30)}`,
  // Never closed, so it stays in the text as leaked markup.
  '[[tone:happy]][[act:laugh]哈哈，这都被你发现了。',
]

function sse(chunks) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

export function createFakeDeepSeek({ adversarial = false, delayMs = 0 } = {}) {
  let calls = 0
  const requests = []
  async function fakeFetch(url, options) {
    if (!String(url).endsWith('/chat/completions'))
      throw new Error(`fake DeepSeek: unexpected URL ${url}`)
    options?.signal?.throwIfAborted()
    const body = JSON.parse(options.body)
    requests.push(body)
    const index = calls++
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason) }, { once: true })
      })
    }
    let reply = FRIENDLY[index % FRIENDLY.length]
    let finish = 'stop'
    if (adversarial && index % 2 === 1)
      reply = HARMFUL[Math.floor(index / 2) % HARMFUL.length]
    if (adversarial && index % 7 === 6) {
      // Cut mid-sentence by max_tokens: the brain must drop the dangling tail.
      reply = '[[tone:neutral]]第一句说完了。第二句还没说完就被'
      finish = 'length'
    }
    const pieces = reply.match(/.{1,6}/gsu) ?? []
    return sse([
      ...pieces.map(content => ({ choices: [{ delta: { content }, finish_reason: null }] })),
      { choices: [{ delta: {}, finish_reason: finish }] },
      { choices: [], usage: { prompt_tokens: 2_400, completion_tokens: Math.ceil(reply.length / 1.5), prompt_cache_hit_tokens: 2_300 } },
    ])
  }
  return { fetch: fakeFetch, requests, get calls() { return calls } }
}
