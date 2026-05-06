import test from 'node:test';
import assert from 'node:assert/strict';

import { createProcessFlashEvent } from '../monitor.mjs';

test('重复 WebSocket 重要消息并发到达时不会重复入库或抛错', async () => {
  const appendCalls = [];
  const analyzeCalls = [];
  const dedupSnapshots = [];
  let releaseAnalyze;

  const analyzeGate = new Promise(resolve => {
    releaseAnalyze = resolve;
  });

  const processFlashEvent = createProcessFlashEvent({
    getNewsAiProviders: () => [{ type: 'mock', apiKey: 'mock-key' }],
    getKey: () => 'duplicate-key',
    saveDedup: current => {
      dedupSnapshots.push(JSON.parse(JSON.stringify(current)));
    },
    log: () => {},
    logFlashNew: () => {},
    logFlashEdit: () => {},
    logFlashDelete: () => {},
    isAd: () => false,
    isClickToView: () => false,
    isCalendarPreview: () => false,
    analyze: async item => {
      analyzeCalls.push(item.flashId);
      await analyzeGate;
      return { text: '分析完成', source: 'mock' };
    },
    buildTechnicalSummary: async () => '技术摘要',
    appendNews: entry => {
      appendCalls.push(entry);
      return true;
    },
    updateNewsByFlashId: () => false,
    markDeletedByFlashId: () => false,
  });

  const event = {
    action: 1,
    item: {
      flashId: 'flash-1',
      time: '10:35:00',
      title: '重要快讯',
      content: '同一条消息被重复推送',
      important: true,
      tags: ['VIP'],
      remarks: [],
      hotTag: '',
      affect: '',
      source: 'jin10',
    },
  };

  const dedup = {};
  const state = {};

  const firstRun = processFlashEvent(event, dedup, state);
  await Promise.resolve();
  const secondRun = processFlashEvent(event, dedup, state);

  releaseAnalyze();
  await assert.doesNotReject(Promise.all([firstRun, secondRun]));

  assert.equal(analyzeCalls.length, 1);
  assert.equal(appendCalls.length, 1);
  assert.equal(dedup['duplicate-key']?.pending, undefined);
  assert.equal(typeof dedup['duplicate-key']?.ts, 'number');
  assert.ok(dedupSnapshots.some(snapshot => snapshot['duplicate-key']?.pending === true));
});