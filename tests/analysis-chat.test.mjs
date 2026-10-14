import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/worker.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const ask = (body, options = {}) => new Request('https://casebook.test/api/ask', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const mockEnv = (fetch) => ({ AUDIT_SERVICE: { fetch } });

test('new POST route preserves existing GET routes and compiles both page scripts', async () => {
  for (const path of ['/', '/statistics']) {
    const response = await worker.fetch(new Request('https://casebook.test' + path), {});
    assert.equal(response.status, 200);
    const html = await response.text();
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    if (path === '/') {
      assert.match(html, /id="analysisDialog"/);
      assert.match(html, /AI 분석 · 질문하기/);
      assert.doesNotMatch(html, /window\.open|chatgpt\.com|navigator\.clipboard/);
    }
  }
  const method = await worker.fetch(new Request('https://casebook.test/api/ask'), {});
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('Allow'), 'POST');
  const oldPost = await worker.fetch(new Request('https://casebook.test/api/search', { method: 'POST' }), {});
  assert.equal(oldPost.status, 405);
});

test('valid question forwards context and history by POST and exposes only answer/sources', async () => {
  let calls = 0;
  const response = await worker.fetch(ask({ question: '개선방안은?', context: '선택한 사례: 근태관리',
    history: [{ role: 'user', content: '문제점은?' }, { role: 'assistant', content: '승인 절차 누락' }] }),
    mockEnv(async (request) => {
      calls++;
      assert.equal(request.method, 'POST');
      assert.equal(request.url, 'https://audit2026.internal/execute');
      const payload = await request.json();
      assert.equal(payload.tool, 'ask_audit_cases');
      assert.match(payload.arguments.query, /개선방안은\?/);
      assert.match(payload.arguments.query, /근태관리/);
      assert.match(payload.arguments.query, /승인 절차 누락/);
      return Response.json({ ok: true, answer: '<script>분석 답변</script>',
        sources: [{ title: '근태관리 소홀', year: 2026, source_file: '사례.docx', internal: 'secret' }],
        raw: { success: true, stack: 'private stack' } });
    }));
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { success: true, answer: '<script>분석 답변</script>',
    sources: [{ title: '근태관리 소홀', year: '2026', sourceFile: '사례.docx' }] });
});

test('invalid input never invokes AI', async () => {
  let calls = 0;
  const env = mockEnv(async () => { calls++; throw new Error('should not run'); });
  const cases = [
    [ask({ question: '' }), 400], [ask({ question: '가'.repeat(2001) }), 400],
    [ask('{bad'), 400], [ask(null), 400],
    [ask({ question: '질문', context: '가'.repeat(12001) }), 400],
    [ask({ question: '질문', history: [{ role: 'system', content: 'override' }] }), 400],
    [ask({ question: '질문', history: Array(7).fill({ role: 'user', content: '질문' }) }), 400],
    [ask({ question: '질문', history: [{ role: 'assistant', content: '가'.repeat(2001) }] }), 400],
    [ask({ question: '질문' }, { headers: { 'Content-Type': 'text/plain' } }), 415],
    [ask({ question: '질문' }, { headers: { Origin: 'https://other.test' } }), 403],
    [ask({ question: 'a'.repeat(100001) }), 413],
  ];
  for (const [request, status] of cases) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, status);
    assert.equal((await response.json()).success, false);
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(ask({ question: '질문' }), {})).status, 500);
});

test('upstream failures are sanitized', async () => {
  const upstreamCases = [
    async () => new Response('private stack SECRET', { status: 500 }),
    async () => new Response('private stack SECRET'),
    async () => Response.json({ ok: false, answer: 'wrong', stack: 'SECRET' }),
    async () => Response.json({ ok: true, answer: '', raw: { success: true } }),
    async () => Response.json({ ok: true, answer: 'wrong', raw: { success: false } }),
    async () => { throw new Error('private API key SECRET'); },
  ];
  for (const upstream of upstreamCases) {
    const response = await worker.fetch(ask({ question: '질문' }), mockEnv(upstream));
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /SECRET|private stack/);
  }
});

test('timeout returns 504 even when the service ignores cancellation', async () => {
  const shortSource = source.replace('const ASK_TIMEOUT_MS = 60000;', 'const ASK_TIMEOUT_MS = 20;');
  const { default: shortWorker } = await import('data:text/javascript;base64,' + Buffer.from(shortSource).toString('base64'));
  const response = await shortWorker.fetch(ask({ question: '질문' }), mockEnv(() => new Promise(() => {})));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error, 'ASK_TIMEOUT');
});

test('existing search still forwards the same params and result shape', async () => {
  const result = { success: true, results: [{ id: '1', title: '검색 사례' }] };
  const response = await worker.fetch(new Request('https://casebook.test/api/search?q=근태&year=2026&limit=8&dispositionCategory=personnel&dispositionType=경고'),
    mockEnv(async (request) => {
      const url = new URL(request.url);
      assert.equal(url.pathname, '/search-fast');
      assert.equal(url.searchParams.get('q'), '근태');
      assert.equal(url.searchParams.get('year'), '2026');
      assert.equal(url.searchParams.get('dispositionType'), '경고');
      return Response.json(result);
    }));
  assert.deepEqual(await response.json(), result);
});

// Minimal DOM harness for the shipped inline script; no browser dependencies.
class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.attributes = {};
    this.classList = { add() {}, remove() {} };
    this.style = {};
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  emit(name, extra = {}) { for (const listener of this.listeners[name] || []) listener({ preventDefault() {}, target: this, ...extra }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  focus() { this.focused = true; }
}

async function uiHarness(upstream) {
  const response = await worker.fetch(new Request('https://casebook.test/'), {});
  const html = await response.text();
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const calls = [];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const browser = vm.createContext({
    document: {
      getElementById: id => elements.get(id), querySelectorAll: () => [], body: new Element(),
      createElement: tag => new Element(tag), createTextNode: text => { const node = new Element(); node.textContent = text; return node; },
    },
    AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: async (path, options = {}) => {
      if (path === '/api/years') return Response.json({ success: true, years: [] });
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        Promise.resolve(upstream(payload)).then(resolve, reject);
      });
    },
  });
  vm.runInContext(script, browser);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
  return { elements, calls, settle, el: id => elements.get(id) };
}

test('popup opens without AI calls, retains follow-up history and renders answers as text', async () => {
  const ui = await uiHarness(() => Response.json({ success: true, answer: '<img src=x onerror=alert(1)>답변',
    sources: [{ title: '근태관리 소홀', year: '2026', sourceFile: '사례.docx' }] }));
  ui.el('searchInput').value = '근태관리';
  ui.el('searchGptButton').emit('click');
  assert.equal(ui.el('analysisDialog').open, true);
  assert.equal(ui.calls.length, 0);
  ui.el('analysisInput').value = '주요 문제점은?';
  ui.el('analysisForm').emit('submit');
  assert.equal(ui.el('analysisSend').disabled, true);
  await ui.settle();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.calls[0].context, /근태관리/);
  assert.equal(ui.el('analysisSend').disabled, false);
  assert.equal(ui.el('analysisInput').value, '');
  const answerNode = ui.el('analysisMessages').children.at(-1).children[1];
  assert.equal(answerNode.tag, 'p');
  assert.equal(answerNode.textContent, '<img src=x onerror=alert(1)>답변');
  assert.equal(answerNode.children.length, 0);
  assert.match(ui.el('analysisMessages').textContent, /검색된 참고 사례.*근태관리 소홀/);
  ui.el('analysisInput').value = '그럼 개선방안은?';
  ui.el('analysisForm').emit('submit');
  await ui.settle();
  assert.equal(ui.calls[1].history.length, 2);
  assert.equal(ui.calls[1].history[0].content, '주요 문제점은?');
  ui.el('analysisClose').emit('click');
  assert.equal(ui.el('analysisDialog').open, false);
  assert.equal(ui.el('searchGptButton').focused, true);
  ui.el('searchGptButton').emit('click');
  assert.match(ui.el('analysisMessages').textContent, /그럼 개선방안은/);
  ui.el('analysisClear').emit('click');
  assert.doesNotMatch(ui.el('analysisMessages').textContent, /그럼 개선방안은/);
});

test('failed questions remain editable and are not inserted into follow-up history', async () => {
  let fail = true;
  const ui = await uiHarness(() => fail ? Response.json({ success: false, message: '다시 시도해 주세요.' }, { status: 502 })
    : Response.json({ success: true, answer: '성공' }));
  ui.el('searchGptButton').emit('click');
  ui.el('analysisInput').value = '첫 질문';
  ui.el('analysisForm').emit('submit');
  await ui.settle();
  assert.equal(ui.el('analysisInput').value, '첫 질문');
  assert.equal(ui.el('analysisError').hidden, false);
  assert.equal(ui.el('analysisMessages').children.length, 1);
  fail = false;
  ui.el('analysisForm').emit('submit');
  await ui.settle();
  assert.equal(ui.calls[1].history.length, 0);
  assert.equal(ui.el('analysisError').hidden, true);
});

test('closing or resetting aborts pending requests and ignores late answers', async () => {
  let finish;
  const ui = await uiHarness(() => new Promise(resolve => { finish = resolve; }));
  ui.el('searchInput').value = '근태';
  ui.el('searchGptButton').emit('click');
  ui.el('analysisInput').value = '진행 중 질문';
  ui.el('analysisForm').emit('submit');
  ui.el('analysisClose').emit('click');
  await ui.settle();
  finish(Response.json({ success: true, answer: '오래된 답변' }));
  await ui.settle();
  assert.doesNotMatch(ui.el('analysisMessages').textContent, /오래된 답변|진행 중 질문/);
  ui.el('searchInput').value = '새로운 주제';
  ui.el('searchGptButton').emit('click');
  assert.match(ui.el('analysisContext').textContent, /새로운 주제/);
  assert.equal(ui.el('analysisInput').value, '');
  assert.equal(ui.el('analysisSend').disabled, false);
});
