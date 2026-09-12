import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowService } from "../workflows.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const script = (body) =>
  `export const meta = {name:'test', description:'offline'};\n${body}`;
async function fixture(
  t,
  runAgent = async ({ prompt }) => ({ id: prompt, value: prompt }),
  callbacks = {},
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
  const service = new WorkflowService({
    cwd,
    agentDir: path.join(cwd, "agent"),
    sessionId: "session",
    runAgent,
    ...callbacks,
  });
  t.after(async () => {
    await service.dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    service,
    run: async (body) =>
      (await service.start({ script: script(body) })).promise,
  };
}

test("quick startup, JSON schema object passthrough and once-only notification", async (t) => {
  let notifications = 0;
  const { service } = await fixture(
    t,
    async () => {
      await sleep(100);
      return {
        id: "child",
        value: { answer: 42 },
        usage: { output: 37, tokens: 3, cost: 0.25, totalCost: 0.5 },
      };
    },
    { notify: () => notifications++ },
  );
  const record = await service.start({
    script: script(
      `const value = await agent('q',{schema:{type:'object',required:['answer'],properties:{answer:{type:'number'}}}}); return {value,budget:{total:budget.total,spent:budget.spent(),unlimited:budget.remaining() === Infinity}};`,
    ),
  });
  assert.equal(record.status, "running");
  assert.match(record.id, /^wf_/);
  await record.promise;
  assert.equal(record.status, "completed", record.error);
  assert.deepEqual(record.result.value, { answer: 42 });
  assert.deepEqual(record.result.budget, {
    total: null,
    spent: 37,
    unlimited: true,
  });
  assert.equal(notifications, 1);
});

test("helper callback failures become null and skip only the failed pipeline chain", async (t) => {
  const { run } = await fixture(t);
  for (const body of [
    "return parallel([1,2,3], x => { if(x === 2) throw Error('ordinary'); return x; }, {concurrency:1});",
    "return parallel([()=>1, async()=>{throw Error('ordinary')}, ()=>3]);",
    "return pipeline([1,2,3], async x=>{if(x===2) throw Error('ordinary'); return x;}, x=>{if(x===null) throw Error('must skip'); return x;});",
  ]) {
    const record = await run(body);
    assert.equal(record.status, "completed", record.error);
    assert.deepEqual(record.result, [1, null, 3]);
  }
  const skipped = await run(
    "const seen=[]; const result=await pipeline([1,2], x=>{if(x===1)throw Error('bad');return x}, x=>{seen.push(x);return x});return {result,seen};",
  );
  assert.deepEqual(skipped.result, { result: [null, 2], seen: [2] });
  for (const hook of ["parallel", "pipeline"]) {
    for (const action of [
      "Math.random()",
      "await parallel(Array(4097), x=>x)",
      "await agent('x',{unknown:true})",
    ]) {
      const record = await run(
        `try { await ${hook}([1,2], async()=>{${action};return 1}); } catch {} return 'caught';`,
      );
      assert.equal(record.status, "failed", `${hook}: ${action}`);
    }
  }
});

test("nested file references and failures are catchable but nested fatal state is not", async (t) => {
  const { cwd, run } = await fixture(t);
  await fs.writeFile(path.join(cwd, "child.js"), script("return args.value;"));
  const objectRef = await run(
    "return workflow({scriptPath:'child.js'},{value:42});",
  );
  assert.equal(objectRef.status, "completed", objectRef.error);
  assert.equal(objectRef.result, 42);
  await fs.writeFile(path.join(cwd, "bad.js"), "invalid");
  await fs.writeFile(
    path.join(cwd, "throws.js"),
    script("throw Error('ordinary nested failure');"),
  );
  for (const ref of [
    "'missing'",
    "{scriptPath:'missing.js'}",
    "{scriptPath:'bad.js'}",
    "{scriptPath:'throws.js'}",
    "null",
    "{}",
    "42",
    "{name:'child'}",
    "{scriptPath:'child.js',extra:1}",
  ]) {
    const record = await run(
      `try { await workflow(${ref}); return 'unexpected'; } catch(e) { return 'recovered'; }`,
    );
    assert.equal(record.status, "completed", record.error);
    assert.equal(record.result, "recovered", ref);
  }
  for (const body of [
    "try { Math.random(); } catch {} return 1;",
    "try { await workflow('missing'); } catch {} return 1;",
  ]) {
    await fs.writeFile(path.join(cwd, "fatal.js"), script(body));
    const record = await run(
      "try { await workflow({scriptPath:'fatal.js'}); } catch {} return 'caught';",
    );
    assert.equal(record.status, "failed", record.error);
  }
});

test("seeded Date supports deterministic APIs without original constructor escapes", async (t) => {
  const { run } = await fixture(t);
  const seeded = await run(
    "return [new Date(0).toISOString(),Date.parse('1970-01-01T00:00:00Z'),Date.UTC(2000,0,1),new Date(0).constructor === Date,Date.prototype.constructor === Date];",
  );
  assert.equal(seeded.status, "completed", seeded.error);
  assert.deepEqual(seeded.result, [
    "1970-01-01T00:00:00.000Z",
    0,
    946684800000,
    true,
    true,
  ]);
  const intercepted = await run(
    "let leaked=false;Reflect.construct=(ctor)=>{leaked=true;return ctor};new Date(0);return leaked;",
  );
  assert.equal(intercepted.status, "completed", intercepted.error);
  assert.equal(intercepted.result, false);
  for (const expression of [
    "Date(0)",
    "new Date()",
    "Date.now()",
    "new Date.prototype.constructor()",
    "new (new Date(0).constructor)()",
    "new Date(0).constructor.now()",
    "Date.prototype.constructor()",
    "Object.getPrototypeOf(new Date(0)).constructor.now()",
  ]) {
    const record = await run(
      `try { ${expression}; } catch {} return 'caught';`,
    );
    assert.equal(record.status, "failed", expression);
  }
});

test("final results require strict JSON without invoking accessors", async (t) => {
  const { run } = await fixture(t);
  for (const expression of [
    "NaN",
    "Infinity",
    "-Infinity",
    "[,1]",
    "[undefined]",
    "({x:undefined})",
    "({[Symbol('x')]:1})",
    "new Date(0)",
    "new Map()",
    "Object.create({x:1})",
    "Object.assign([], {extra:1})",
    "Object.setPrototypeOf([1],null)",
    "({get x(){throw Error('getter executed')}})",
    "Object.defineProperty({},'x',{value:1})",
    "(()=>{const x={};x.self=x;return x})()",
    "1n",
    "(()=>1)",
  ]) {
    const record = await run(`return ${expression};`);
    assert.equal(record.status, "failed", expression);
    assert.match(record.error, /strict JSON/, expression);
  }
  const valid = await run(
    "const shared={x:1};return [shared,shared,Object.assign(Object.create(null),{a:[1,true,null]})];",
  );
  assert.equal(valid.status, "completed", valid.error);
  assert.deepEqual(valid.result, [{ x: 1 }, { x: 1 }, { a: [1, true, null] }]);
  assert.equal((await run("return;")).result, null);
});

test("gate failures journal exit status and bounded stdout/stderr", async (t) => {
  const { run } = await fixture(t);
  const record = await run(
    "return agent('gate',{gate:'printf stdout-message; printf stderr-message >&2; exit 7'});",
  );
  assert.equal(record.status, "completed", record.error);
  assert.equal(record.result, null);
  const entry = JSON.parse(
    (await fs.readFile(record.journalPath, "utf8")).trim(),
  );
  assert.match(entry.error, /exit code 7/);
  assert.match(entry.error, /stdout-message/);
  assert.match(entry.error, /stderr-message/);
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)")}`;
  const overflow = await run(
    `return agent('overflow',{gate:${JSON.stringify(command)}});`,
  );
  assert.equal(overflow.status, "completed", overflow.error);
  assert.equal(overflow.result, null);
  const failed = JSON.parse(
    (await fs.readFile(overflow.journalPath, "utf8")).trim(),
  );
  assert.match(failed.error, /output exceeded 64 KiB/);
  assert.ok(Buffer.byteLength(failed.error) < 64 * 1024 + 200);
  assert.equal((await run("return agent('ok',{gate:'exit 0'});")).result, "ok");
});

test("concurrent pipeline replay stops at earlier failed invocation prefix", async (t) => {
  const calls = [];
  const { service } = await fixture(t, async ({ prompt }) => {
    calls.push(prompt);
    await sleep(prompt === "a" ? 70 : 5);
    if (prompt === "b") throw Error("ordinary");
    return { id: prompt, value: prompt };
  });
  const first = await service.start({
    script: script(
      "return pipeline(['a','b'], x=>agent(x), (x,item)=>agent(item+'2'));",
    ),
  });
  await first.promise;
  assert.equal(first.status, "completed", first.error);
  const replay = await service.start({ resumeFromRunId: first.id });
  await replay.promise;
  assert.equal(replay.status, "completed", replay.error);
  assert.deepEqual(replay.result, first.result);
  assert.equal(calls.filter((x) => x === "a").length, 1);
  for (const prompt of ["b", "a2", "b2"])
    assert.equal(calls.filter((x) => x === prompt).length, 2);
});

test("pipeline overlaps stages without a cross-item barrier", async (t) => {
  const events = [];
  const { run } = await fixture(t, async ({ prompt }) => {
    events.push(`start:${prompt}`);
    await sleep(prompt === "slow" ? 160 : 15);
    events.push(`end:${prompt}`);
    return { id: prompt, value: prompt };
  });
  const record = await run(
    `return pipeline(['fast','slow'], (previous,item,index) => { if(previous !== item || item !== ['fast','slow'][index]) throw Error('arguments'); return agent(item); }, (previous,item,index) => { if(previous !== item || item !== ['fast','slow'][index]) throw Error('arguments'); return agent(previous+'2'); });`,
  );
  assert.equal(record.status, "completed", record.error);
  assert.deepEqual(record.result, ["fast2", "slow2"]);
  assert.ok(events.indexOf("start:fast2") < events.indexOf("end:slow"));
});

test("journal is invocation-ordered, replays prefix and runs edits live", async (t) => {
  let calls = 0;
  const { service } = await fixture(t, async ({ prompt }) => {
    calls++;
    await sleep(prompt === "a" ? 80 : 5);
    return { id: prompt, value: prompt };
  });
  const source = script(`return parallel(['a','b'], x => agent(x));`);
  const first = await service.start({ script: source });
  await first.promise;
  const entries = (await fs.readFile(first.journalPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    entries.map((e) => e.index),
    [0, 1],
  );
  assert.deepEqual(
    entries.map((e) => e.value),
    ["a", "b"],
  );
  const replay = await service.start({
    script: source,
    resumeFromRunId: first.id,
  });
  await replay.promise;
  assert.equal(replay.status, "completed", replay.error);
  assert.equal(calls, 2);
  const bad = await service.start({
    script: script(`return agent('changed');`),
    resumeFromRunId: first.id,
  });
  await bad.promise;
  assert.equal(bad.status, "completed", bad.error);
  assert.equal(bad.result, "changed");
  assert.equal(calls, 3);
  const short = await service.start({
    script: script(`return 1;`),
    resumeFromRunId: first.id,
  });
  await short.promise;
  assert.equal(short.status, "completed", short.error);
});

test("failed calls are never replayed; resume retains gate-failed child label", async (t) => {
  const calls = [];
  const { service, run } = await fixture(t, async (input) => {
    calls.push(input);
    return { id: `child-${calls.length}`, value: "value" };
  });
  const first = await run(
    `const failed = await agent('first',{label:'writer',gate:'exit 1'}); const next = await agent('retry',{resume:'writer'}); return [failed,next];`,
  );
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(first.result, [null, "value"]);
  assert.equal(calls[1].options.resume, "child-1");
  assert.equal(calls[0].options.gate, undefined);
  await assert.rejects(
    service.start({ script: script("return 1"), resumeFromRunId: first.id }),
    /child resume/,
  );
  const failed = await run(`return agent('gate',{gate:'exit 1'});`);
  const again = await service.start({
    script: script(`return agent('gate',{gate:'exit 1'});`),
    resumeFromRunId: failed.id,
  });
  await again.promise;
  assert.equal(calls.length, 4);
});

test("normal callback errors and schema mismatch become null; invalid options remain fatal when caught", async (t) => {
  const { run } = await fixture(t, async ({ prompt }) => {
    if (prompt === "throws") throw new Error("child failed");
    return { id: "x", value: { answer: "bad" } };
  });
  assert.equal((await run(`return agent('throws');`)).result, null);
  assert.equal(
    (
      await run(
        `return agent('schema',{schema:{type:'object',properties:{answer:{type:'number'}}}});`,
      )
    ).result,
    null,
  );
  for (const options of [
    "{isolation:false}",
    "{resume:'x',model:'y'}",
    "{schema:{type:'nonsense'}}",
    "{unknown:true}",
  ]) {
    const record = await run(
      `try { await agent('x',${options}); } catch {} return 'ok';`,
    );
    assert.equal(record.status, "failed", options);
  }
});

test("saved directory precedence, args, exported literal meta and single-level nested workflow", async (t) => {
  const { cwd, service, run } = await fixture(t);
  for (const directory of [
    ".pi/workflows",
    ".agents/workflows",
    "agent/workflows",
  ])
    await fs.mkdir(path.join(cwd, directory), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi/workflows/child.js"),
    `export const meta = {name:'child',description:'nested'}; return agent(args.question);`,
  );
  await fs.writeFile(
    path.join(cwd, ".agents/workflows/child.js"),
    script(`return 'wrong';`),
  );
  const record = await run(`return workflow('child',{question:'hello'});`);
  assert.equal(record.status, "completed", record.error);
  assert.equal(record.result, "hello");
  await fs.writeFile(
    path.join(cwd, ".pi/workflows/deep.js"),
    script(`return workflow('child',{});`),
  );
  assert.equal((await run(`return workflow('deep');`)).status, "failed");
  await assert.rejects(service.start({ name: "../child" }), /Unsafe/);
  const fromPath = await service.start({
    scriptPath: ".pi/workflows/child.js",
    args: { question: "path" },
  });
  await fromPath.promise;
  assert.equal(fromPath.result, "path");
});

test("meta validation uses AST literals and rejects dynamic imports", async (t) => {
  const { service } = await fixture(t);
  for (const source of [
    "return 1;",
    "const meta = makeMeta();",
    'const meta = {...{name:"x"}};',
    'const meta = {get name(){return "x"}};',
    "const meta = {name: `x`};",
    "const meta = {name: 3};",
    script(`return import('node:fs');`),
  ])
    await assert.rejects(service.start({ script: source }));
  const record = await service.start({
    script: `/* leading comment */ export const meta = {name:'valid',description:'literal',phases:['one','two'],extra:[-1,null,true]}; return 1;`,
  });
  await record.promise;
  assert.equal(record.result, 1);
});

test("source contract requires first exported const literal and bounded UTF-8 bytes", async (t) => {
  const { service } = await fixture(t);
  for (const source of [
    "const meta = {name:'x',description:'x'}; return 1;",
    "meta({name:'x',description:'x'}); return 1;",
    "return 1; export const meta = {name:'x',description:'x'};",
    "; export const meta = {name:'x',description:'x'};",
    "export let meta = {name:'x',description:'x'};",
    "export const meta = {name:'x'};",
    "export const meta = {description:'x'};",
    "export const meta = {name:' ',description:'x'};",
    "export const meta = {name:'x',description:''};",
    "export const meta = {name:'x',description:'x',phases:'one'};",
    "export const meta = {name:'x',description:'x',phases:[makePhase()]};",
    "export const meta = {name:'x',description:'x',phases:[...[]]};",
  ])
    await assert.rejects(service.start({ script: source }), undefined, source);
  const base = script("return 1; //");
  const boundary = base + "x".repeat(512 * 1024 - Buffer.byteLength(base));
  assert.equal((await service.resolve({ script: boundary })).meta.name, "test");
  await assert.rejects(service.resolve({ script: boundary + "x" }), /512 KiB/);
  await assert.rejects(
    service.resolve({ script: base + "é".repeat(256 * 1024) }),
    /512 KiB/,
  );
});

test("source precedence ignores lower priorities and absent args stay undefined", async (t) => {
  const { cwd, service, run } = await fixture(t);
  await fs.writeFile(path.join(cwd, "chosen.js"), script("return args;"));
  const record = await service.start({
    scriptPath: "chosen.js",
    script: "invalid",
    name: "../bad",
    args: null,
  });
  await record.promise;
  assert.equal(record.status, "completed", record.error);
  assert.equal(record.result, null);
  const inline = await service.start({
    script: script("return args === undefined;"),
    name: "../bad",
  });
  await inline.promise;
  assert.equal(inline.result, true);
  assert.equal((await run("return args === undefined;")).result, true);
  await fs.mkdir(path.join(cwd, ".pi/workflows"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".pi/workflows/noargs.js"),
    script("return args === undefined;"),
  );
  assert.equal((await run("return workflow('noargs');")).result, true);
  const cycle = {};
  cycle.self = cycle;
  for (const args of [
    NaN,
    Infinity,
    1n,
    () => 1,
    { x: undefined },
    { x: NaN },
    new Date(),
    [,],
    cycle,
  ])
    await assert.rejects(
      service.start({ script: script("return args;"), args }),
      /JSON/,
    );
});

test("resume-only uses owned script snapshot and original args", async (t) => {
  const { cwd, service } = await fixture(t);
  const filename = path.join(cwd, "original.js");
  await fs.writeFile(filename, script("return args;"));
  const args = { value: "original" };
  const original = await service.start({ scriptPath: filename, args });
  await original.promise;
  args.value = "mutated";
  await fs.writeFile(filename, "invalid");
  const resumed = await service.start({ resumeFromRunId: original.id });
  await resumed.promise;
  assert.equal(resumed.status, "completed", resumed.error);
  assert.deepEqual(resumed.result, { value: "original" });
  const overridden = await service.start({
    resumeFromRunId: original.id,
    args: null,
  });
  await overridden.promise;
  assert.equal(overridden.result, null);
  const absent = await service.start({
    script: script("return args === undefined;"),
  });
  await absent.promise;
  const absentReplay = await service.start({ resumeFromRunId: absent.id });
  await absentReplay.promise;
  assert.equal(absentReplay.result, true);
  await assert.rejects(
    service.start({ resumeFromRunId: "unknown" }),
    /settled run/,
  );
  service.sessionId = "other";
  await assert.rejects(
    service.start({ resumeFromRunId: original.id }),
    /same session/,
  );
});

test("edited replay cannot resume a cached label owned by the earlier run", async (t) => {
  const calls = [];
  const { service } = await fixture(t, async (input) => {
    calls.push(input);
    return { id: "original-child", value: "ok" };
  });
  const original = await service.start({
    script: script("return agent('first',{label:'old-label'});"),
  });
  await original.promise;
  assert.equal(original.status, "completed", original.error);
  assert.equal(calls.length, 1);
  const replay = await service.start({
    resumeFromRunId: original.id,
    script: script(
      "await agent('first',{label:'old-label'}); try { await agent('continue',{resume:'old-label'}); } catch {} return 'caught';",
    ),
  });
  await replay.promise;
  assert.equal(replay.status, "failed");
  assert.match(replay.error, /Cannot resume replayed label 'old-label'/);
  assert.match(replay.error, /rerun without resumeFromRunId/);
  assert.equal(
    calls.length,
    1,
    "replay and rejected resume launch no new children",
  );
});

test("structured child resume inherits validation without forwarding forbidden overrides", async (t) => {
  const inputs = [];
  const { run } = await fixture(t, async (input) => {
    inputs.push(input);
    return {
      id: `child-${inputs.length}`,
      value: { value: inputs.length === 3 ? "bad" : 42 },
    };
  });
  const record = await run(`
    const first = await agent('first',{label:'first',schema:{type:'object',required:['value'],properties:{value:{type:'number'}}}});
    const second = await agent('second',{resume:'first',label:'second'});
    const third = await agent('third',{resume:'second'});
    return [first,second,third];
  `);
  assert.equal(record.status, "completed", record.error);
  assert.deepEqual(record.result, [{ value: 42 }, { value: 42 }, null]);
  assert.equal(inputs[1].options.resume, "child-1");
  assert.equal(inputs[1].options.schema, undefined);
  assert.equal(inputs[2].options.resume, "child-2");
});

test("concurrent pipeline replay preserves completion ordering and caches every call", async (t) => {
  const calls = [];
  const { service } = await fixture(t, async ({ prompt }) => {
    calls.push(prompt);
    await sleep(prompt === "a" ? 120 : 5);
    return { id: prompt, value: prompt };
  });
  const first = await service.start({
    script: script("return pipeline(['a','b'], x=>agent(x), x=>agent(x+'2'));"),
  });
  await first.promise;
  assert.equal(first.status, "completed", first.error);
  assert.deepEqual(calls, ["a", "b", "b2", "a2"]);
  for (let i = 0; i < 3; i++) {
    const replay = await service.start({ resumeFromRunId: first.id });
    await replay.promise;
    assert.equal(replay.status, "completed", replay.error);
    assert.deepEqual(replay.result, ["a2", "b2"]);
    assert.equal(calls.length, 4);
  }
});

test("edited control flow does not wait for old concurrent completion dependencies", async (t) => {
  const calls = [];
  const { service } = await fixture(t, async ({ prompt }) => {
    calls.push(prompt);
    await sleep(prompt === "a" ? 80 : 5);
    return { id: prompt, value: prompt };
  });
  const original = await service.start({
    script: script("return parallel(['a','b'], x=>agent(x));"),
  });
  await original.promise;
  const edited = await service.start({
    resumeFromRunId: original.id,
    script: script("return [await agent('a'), await agent('b')];"),
  });
  await edited.promise;
  assert.equal(edited.status, "completed", edited.error);
  assert.deepEqual(edited.result, ["a", "b"]);
  assert.deepEqual(calls, ["a", "b"]);
});

test("edited scripts replay only the canonical unchanged prefix", async (t) => {
  const calls = [];
  const { service } = await fixture(t, async ({ prompt }) => {
    calls.push(prompt);
    return { id: prompt, value: prompt };
  });
  const original = await service.start({
    script: script(
      "await agent('a',{label:'a',phase:'one'}); await agent('b'); return agent('c');",
    ),
  });
  await original.promise;
  const edited = await service.start({
    resumeFromRunId: original.id,
    script: script(
      "await agent('a',{phase:'one',label:'a'}); await agent('changed'); return agent('c');",
    ),
  });
  await edited.promise;
  assert.equal(edited.status, "completed", edited.error);
  assert.deepEqual(calls, ["a", "b", "c", "changed", "c"]);
});

test("determinism bans and no host capabilities or code generation", async (t) => {
  const { run } = await fixture(t);
  for (const source of [
    "return Date.now();",
    "return new Date();",
    "return Math.random();",
    "return Intl.DateTimeFormat().format();",
    "return agent.constructor('return process')();",
    "return ({}).constructor.constructor('return process')();",
    "return eval('1');",
  ]) {
    const record = await run(source);
    assert.equal(record.status, "failed", source);
  }
  const record = await run(
    `return ['process','require','fetch','Buffer','setTimeout','WebAssembly','__receive','__execute'].map(x => typeof globalThis[x]);`,
  );
  assert.deepEqual(record.result.slice(0, 5), Array(5).fill("undefined"));
  assert.deepEqual(record.result.slice(6), ["undefined", "undefined"]);
});

test("stop waits for actual child settlement; disposal suppresses all later callbacks", async (t) => {
  let startedResolve, release;
  const started = new Promise((r) => (startedResolve = r));
  let notices = 0;
  const { service } = await fixture(
    t,
    async ({ signal }) => {
      startedResolve();
      await new Promise((r) => (release = r));
      assert.equal(signal.aborted, true);
      return { id: "x", value: "late" };
    },
    { notify: () => notices++, onUpdate: () => notices++ },
  );
  const record = await service.start({
    script: script(`return agent('wait');`),
  });
  await started;
  let settled = false;
  const stopping = service.stop(record.id).then(() => (settled = true));
  await sleep(40);
  assert.equal(settled, false);
  assert.equal(record.status, "stopping");
  const disposing = service.dispose();
  const count = notices;
  release();
  await disposing;
  await stopping;
  assert.equal(record.status, "cancelled");
  assert.equal(notices, count);
});

test("pending fire-and-forget calls fail and cancel real children", async (t) => {
  let aborted = false;
  const { run } = await fixture(t, async ({ signal }) => {
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    aborted = true;
    return { id: "x", value: "x" };
  });
  const record = await run(`agent('forgotten'); return 1;`);
  assert.equal(record.status, "failed");
  assert.match(record.error, /unawaited/);
  // A child still queued when script return arrives need not be launched.
  assert.equal(typeof aborted, "boolean");
});

test("gate executes in cwd after child and stop waits for gate close", async (t) => {
  const { cwd, service } = await fixture(t, async () => {
    await fs.writeFile(path.join(cwd, "child-ready"), "yes");
    return { id: "child", value: "ok" };
  });
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('fs').accessSync('child-ready'); require('fs').writeFileSync('gate-ready','yes'); setInterval(()=>{},1000)")}`;
  const record = await service.start({
    script: script(`return agent('gate',{gate:${JSON.stringify(command)}});`),
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fs.access(path.join(cwd, "gate-ready"));
      break;
    } catch {
      await sleep(10);
    }
  }
  await fs.access(path.join(cwd, "gate-ready"));
  await service.stop(record.id);
  assert.equal(record.status, "cancelled");
});

test("CPU-bound scripts do not block host and remain cancellable", async (t) => {
  const { service } = await fixture(t);
  const record = await service.start({ script: script("while(true) {}") });
  await sleep(30);
  await service.stop(record.id);
  assert.equal(record.status, "cancelled");
});

test("service-wide cap and bounded helper inventories", async (t) => {
  let active = 0,
    peak = 0;
  const { service, run } = await fixture(t, async ({ prompt }) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(15);
    active--;
    return { id: prompt, value: prompt };
  });
  service.cap = 2;
  const a = await service.start({
    script: script(`return parallel(['a','b','c'], x=>agent(x));`),
  });
  const b = await service.start({
    script: script(`return parallel(['d','e','f'], x=>agent(x));`),
  });
  await service.waitForAll();
  assert.equal(peak, 2);
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  assert.equal(
    (await run(`return parallel(Array(4097).fill(1), x=>x);`)).status,
    "failed",
  );
});
