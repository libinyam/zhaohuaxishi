// Run: node --test scripts/landing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/landing.js', import.meta.url), 'utf8');
// landing.js 顶层会实例化 IntersectionObserver / 调用 setupReveal()，浏览器 API 打桩后再加载
const context = vm.createContext({
  IntersectionObserver: class { observe() {} unobserve() {} },
  document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
});
// Load pure selection logic without starting the browser-only fetch.
vm.runInContext(source.replace(/\nboot\(\);\s*$/, ''), context);

test('homepage selects at most six approved cards, with topic variety and safe IDs', () => {
  const card = (id, topic = '文学', status = 'approved') => ({ id, topicTags: [topic], status });
  const cards = [
    card('card_1'), card('card_2'), card('card_3'), card('card_4'),
    card('card_5'), card('card_6'), card('card_7', '数学'),
    card('card_8', '技术', 'rejected'), card('javascript:alert(1)'),
  ];
  const selected = Array.from(context.selectHomepageCards(cards), c => c.id);
  assert.deepEqual(selected, ['card_1', 'card_7', 'card_2', 'card_3', 'card_4', 'card_5']);
  assert.equal(context.selectHomepageCards([]).length, 0);
  assert.equal(context.selectHomepageCards([card('card_bad', '文学', 'pending')]).length, 0);
  assert.equal(cards.length, 9, 'input is not consumed');
});
