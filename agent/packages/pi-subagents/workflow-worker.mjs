import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

// No host function or object enters this realm. Both directions use JSON strings.
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
const bootstrap = `
'use strict';
(() => {
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
  const out = [], pending = new Map(), calls = [];
  let next = 0, fatal = null, currentPhase, spent = 0;
  const fail = message => { fatal = String(message); throw new Error(fatal); };
  const json = value => { const s = stringify(value); if (s === undefined) fail('Expected JSON value'); return parse(s); };
  const strictResult = value => {
    const seen = new Set();
    const visit = item => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      const array = Array.isArray(item);
      if (typeof item !== 'object' || seen.has(item) ||
          (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) &&
           (array || Object.getPrototypeOf(item) !== null))) fail('Workflow result must be strict JSON data');
      seen.add(item);
      const keys = Reflect.ownKeys(item).filter(key => !(array && key === 'length'));
      if (array && keys.length !== item.length) fail('Workflow result must be strict JSON data');
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
            (array && (!/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= item.length)))
          fail('Workflow result must be strict JSON data');
        visit(property.value);
      }
      seen.delete(item);
    };
    visit(value);
    return json(value);
  };
  const send = message => out.push(stringify(message));
  const request = (kind, data) => {
    const id = next++;
    const state = { observed: false, settled: false }; calls.push(state);
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject, state }));
    promise.catch(() => {});
    send({ kind, id, data: json(data) });
    return {
      then(resolve, reject) { state.observed = true; return promise.then(resolve, reject); },
      catch(reject) { state.observed = true; return promise.catch(reject); },
      finally(fn) { state.observed = true; return promise.finally(fn); }
    };
  };
  const itemsCheck = items => { if (!Array.isArray(items) || items.length > 4096) fail('Call items cap is 4096'); };
  const hooks = {
    agent(prompt, options = {}) { return request('agent', { prompt, options: { ...(currentPhase === undefined ? {} : { phase: currentPhase }), ...options } }); },
    async parallel(items, fn, options = {}) {
      itemsCheck(items);
      if (fn && typeof fn === 'object') { options = fn; fn = undefined; }
      const concurrency = options.concurrency ?? (items.length || 1);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4096) fail('Invalid parallel concurrency');
      const results = new Array(items.length); let cursor = 0;
      await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (cursor < items.length) {
          if (fatal) throw new Error(fatal);
          const i = cursor++; const item = items[i];
          try { results[i] = await (fn ? fn(item, i) : typeof item === 'function' ? item() : item); }
          catch (error) { if (fatal) throw new Error(fatal); results[i] = null; }
        }
      })); return results;
    },
    async pipeline(items, ...stages) {
      itemsCheck(items);
      if (!Array.isArray(stages) || stages.length > 256 || stages.some(s => typeof s !== 'function')) fail('Invalid pipeline stages');
      return hooks.parallel(items, async (item, index) => { let value = item; for (const stage of stages) value = await stage(value, item, index); return value; });
    },
    phase(name, fn) { if (typeof name !== 'string') fail('Invalid phase'); currentPhase = name; if (fn === undefined) return name; if (typeof fn !== 'function') fail('Invalid phase callback'); return fn(); },
    log(...values) { send({ kind: 'log', data: json(values) }); },
    budget: Object.freeze({ total: null, spent: () => spent, remaining: () => Infinity }),
    workflow(name, args) { return request('workflow', { name, args }); },
  };
  for (const [name, value] of Object.entries(hooks)) Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'args', { value: ${workerData.args === undefined ? "undefined" : `parse(${JSON.stringify(JSON.stringify(workerData.args))})`}, writable: false });
  const ban = () => fail('Nondeterministic Date/random is forbidden');
  Object.defineProperty(Math, 'random', { value: ban, writable: false, configurable: false });
  const OriginalDate = Date, construct = Reflect.construct;
  function SeededDate(...values) {
    if (!new.target || !values.length) return ban();
    return construct(OriginalDate, values, new.target);
  }
  SeededDate.prototype = OriginalDate.prototype;
  Object.defineProperty(SeededDate.prototype, 'constructor', { value: SeededDate, writable: false, configurable: false });
  Object.defineProperties(SeededDate, {
    now: { value: ban }, parse: { value: OriginalDate.parse }, UTC: { value: OriginalDate.UTC }
  });
  Object.defineProperty(globalThis, 'Date', { value: SeededDate, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'Intl', { value: undefined, writable: false, configurable: false });
  return {
  drain: () => stringify(out.splice(0)),
  receive: text => {
    const m = parse(text), p = pending.get(m.id); if (!p) return;
    if (typeof m.spent === 'number') spent = m.spent;
    pending.delete(m.id); p.state.settled = true;
    if (m.error) { if (m.fatal) fatal = m.error; p.reject(new Error(m.error)); } else p.resolve(m.value);
  },
  execute: async fn => {
    try {
      const value = await fn();
      if (fatal) throw new Error(fatal);
      if (pending.size || calls.some(c => !c.observed)) throw new Error('Pending or unawaited workflow calls at script return');
      send({ kind: 'done', value: value === undefined ? null : strictResult(value) });
    } catch (error) { send({ kind: 'failed', error: String(error?.message ?? error), fatal: Boolean(fatal) }); }
  }};
})();
`;
try {
  const bridge = vm.runInContext(bootstrap, context, { timeout: 1000 });
  const drain = () => {
    const batch = bridge.drain();
    for (const message of JSON.parse(batch)) parentPort.postMessage(message);
  };
  parentPort.on("message", (text) => {
    try {
      bridge.receive(text);
      drain();
    } catch (error) {
      parentPort.postMessage(
        JSON.stringify({ kind: "failed", error: error.message }),
      );
    }
  });
  setInterval(() => {
    drain();
    parentPort.postMessage('{"kind":"heartbeat"}');
  }, 20);
  const script = vm.runInContext(
    `(async () => {\n${workerData.source}\n})`,
    context,
    { timeout: 1000, filename: workerData.filename },
  );
  bridge.execute(script);
  drain();
} catch (error) {
  parentPort.postMessage(
    JSON.stringify({ kind: "failed", error: error.message }),
  );
}
