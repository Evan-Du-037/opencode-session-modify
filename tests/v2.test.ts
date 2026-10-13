import { expect, test } from 'bun:test';
import { fromV2, toV2 } from '../src/v2';
import { sessionId, messageId } from '../src/ids';
import { v2Session } from './v2-fixture';

test('v2 round trip preserves tool content, provider fields, files and timeline events', () => {
  const data: any = v2Session('/tmp/project');
  data.messages[0].files = [{ type: 'file', mediaType: 'image/png', data: 'image-data', source: { type: 'inline' } }];
  data.messages[1].content[2].state.content.push({ type: 'file', uri: 'file:///tmp/image.png', mediaType: 'image/png' });
  data.messages.push(
    { id: 'msg_system', type: 'system', text: 'system text', time: { created: 1 } },
    { id: 'msg_synthetic', type: 'synthetic', text: 'synthetic text', time: { created: 1 } },
    { id: 'msg_compact', type: 'compaction', status: 'completed', reason: 'manual', summary: 'summary', recent: 'recent', time: { created: 1 } },
    { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 1 } },
    { id: 'msg_model', type: 'model-switched', model: { providerID: 'test', id: 'new' }, time: { created: 1 } },
  );
  const view = fromV2(data);
  const output = toV2(view);
  const expected = structuredClone(data);
  delete expected.messages[1].content[0].state.anthropic;
  expect(output).toEqual(expected);
  expect(data.messages[1].content[0].state.anthropic).toBeDefined();
  view.messages[0].parts[0].text = 'edited user';
  view.messages[1].parts[2].state.input = { path: 'edited' };
  view.messages[1].parts[2].state.content[0].text = 'edited output';
  view.messages[1].parts[3].state.error.message = 'edited error';
  view.messages[4].parts[0].text = 'edited summary';
  const edited = toV2(view);
  expect(edited.messages[0].text).toBe('edited user');
  expect(edited.messages[1].content[2].state.input).toEqual({ path: 'edited' });
  expect(edited.messages[1].content[2].state.content[1]).toEqual(expected.messages[1].content[2].state.content[1]);
  expect(edited.messages[1].content[3].state.error.message).toBe('edited error');
  expect(edited.messages[4].summary).toBe('edited summary');
});

test('new assistant and reasoning are settled and use the session model; deletion survives conversion', () => {
  const view = fromV2(v2Session('/tmp/project'));
  view.messages.splice(1, 1);
  view.messages.push({ info: { id: 'msg_new', role: 'assistant' }, parts: [
    { type: 'reasoning', text: 'new reasoning', time: { start: 1, end: 2 } }, { type: 'text', text: 'new answer' },
  ] });
  const output = toV2(view);
  expect(output.messages).toHaveLength(2);
  expect(output.messages[1].time.completed).toBeNumber();
  expect(output.messages[1].model).toEqual(view.info.model);
  expect(output.messages[1].content[0].time).toEqual({ created: 1, completed: 2 });
  view.messages[1].info.role = 'user';
  expect(() => toV2(view)).toThrow('只支持文本');
});

test('clone identifiers do not collide within a millisecond', () => {
  expect(new Set(Array.from({ length: 1000 }, () => sessionId(0))).size).toBe(1000);
  expect(new Set(Array.from({ length: 1000 }, () => messageId(0))).size).toBe(1000);
});
