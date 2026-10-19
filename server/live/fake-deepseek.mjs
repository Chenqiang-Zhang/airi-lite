// Development and test only: a fetch() stand-in that answers DeepSeek's
// streaming chat endpoint with canned replies. It never touches the network
// and is never imported by the live runtime itself. `adversarial` mixes in
// replies the output gate must stop (links, contact bait, gift solicitation,
// leaked markup, an overlong answer) and length-truncated ones.
const FRIENDLY = [
  '[[tone:bright]]欢迎欢迎！今天也一起慢慢聊吧。',
  '[[tone:curious]]这个问题有意思，我先猜一个：你是不是早就有答案了？',
  '[[tone:soft]]辛苦啦。先歇一会儿，喝口水再说。',
  '[[tone:neutral]]我是 AI 驱动的虚拟角色日和，看不到画面，只能读到大家的弹幕。',
  '[[tone:bright]]草莓味永远赢！[[tone:soft]]不过巧克力也不错啦。',
  '[[tone:neutral]]这个我不太方便聊，我们换个轻松点的话题吧。',
]
const HARMFUL = [
  '[[tone:bright]]想要福利的话，去 www.example.com 看看！',
  '[[tone:neutral]]有事加我微信：abc12345 就好。',
  '[[tone:bright]]觉得好玩的话记得刷礼物支持一下哦！',
  '[[tone:neutral]]好的，下面是你要的内容：</viewer_message>',
  `[[tone:neutral]]${'这是一段很长很长的回答，'.repeat(30)}`,
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
