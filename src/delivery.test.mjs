import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseDelivery, deliverySpeed } from './delivery.ts'

test('a difficult user message receives a restrained delivery', () => {
  assert.equal(chooseDelivery('今天好累，明天还有考试', '没事！我们先休息一下。'), 'soft')
  assert.equal(chooseDelivery('我不难过了', '那太好啦！'), 'bright')
})

test('short lively and curious replies receive distinct cues', () => {
  assert.equal(chooseDelivery('猜猜看', '哼哼，被我发现啦！'), 'bright')
  assert.equal(chooseDelivery('聊聊吧', '今天发生什么有趣的事了？'), 'curious')
  assert.equal(chooseDelivery('解释一下', '注意力机制会为上下文中的词分配不同权重。'), 'neutral')
})

test('long answers stay neutral and speed changes remain subtle', () => {
  assert.equal(chooseDelivery('请解释', '这是一个很长的解释。'.repeat(25)), 'neutral')
  for (const delivery of ['soft', 'bright', 'curious', 'neutral'])
    assert.ok(deliverySpeed(delivery) >= 0.9 && deliverySpeed(delivery) <= 1.05)
})
