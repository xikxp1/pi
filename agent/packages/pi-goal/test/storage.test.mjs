import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { readConfig, saveConfig, safePath, snapshot, changedFiles, artifactDir, saveArtifact } from '../storage.mjs'
import { hash } from '../core.mjs'

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'pi-goal-storage-'))
  const cwd = join(base, 'project')
  await mkdir(cwd)
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, cwd }
}
const plan = (...files) => ({ steps: [{ files }] })

test('profiles start empty, save atomically/private, and malformed configuration fails closed', async t => {
  const { cwd } = await fixture(t)
  assert.deepEqual(await readConfig(cwd), { version: 1, profiles: {} })
  const profiles = { researcher: { model: 'provider/model', thinking: 'medium', maxTurns: 16 } }
  await saveConfig(cwd, { profiles })
  assert.deepEqual((await readConfig(cwd)).profiles, profiles)
  assert.equal((await stat(join(cwd, 'goal.json'))).mode & 0o777, 0o600)
  await writeFile(join(cwd, 'goal.json'), 'broken')
  await assert.rejects(readConfig(cwd), /Cannot read goal profiles/)
  await writeFile(join(cwd, 'goal.json'), '{"version":2}')
  await assert.rejects(readConfig(cwd), /Unsupported/)
})

test('snapshots hash raw bytes and detect additions, modifications and deletions', async t => {
  const { cwd } = await fixture(t)
  const bytes = Buffer.from([0, 1, 255, 128])
  await writeFile(join(cwd, 'binary'), bytes)
  const before = await snapshot(cwd, plan('binary', 'new-file'))
  assert.deepEqual(before, { binary: { hash: hash(bytes), bytes: bytes.length }, 'new-file': null })
  await writeFile(join(cwd, 'new-file'), 'hello')
  await rm(join(cwd, 'binary'))
  const after = await snapshot(cwd, plan('binary', 'new-file'))
  assert.deepEqual(changedFiles(before, after).sort(), ['binary', 'new-file'])
  assert.deepEqual(changedFiles(after, after), [])
})

test('new nested targets and existing in-project symlinks are inspected correctly', async t => {
  const { cwd } = await fixture(t)
  assert.deepEqual(await snapshot(cwd, plan('new/sub/file')), { 'new/sub/file': null })
  await writeFile(join(cwd, 'actual'), 'hello')
  await symlink('actual', join(cwd, 'alias'))
  assert.equal((await snapshot(cwd, plan('alias'))).alias.hash, hash('hello'))
})

test('outward existing and dangling symlinks cannot become approved targets', async t => {
  const { base, cwd } = await fixture(t)
  await mkdir(join(base, 'outside'))
  await symlink(join(base, 'outside'), join(cwd, 'escape'))
  await assert.rejects(safePath(cwd, 'escape/new-file'), /escapes project/)
  await symlink(join(base, 'missing-outside'), join(cwd, 'dangling'))
  await assert.rejects(safePath(cwd, 'dangling/new-file'), /Dangling symlink/)
  await assert.rejects(safePath(cwd, 'dangling'), /Dangling symlink/)
})

test('Git metadata is rejected through both direct names and internal aliases', async t => {
  const { cwd } = await fixture(t)
  await mkdir(join(cwd, '.git'))
  await writeFile(join(cwd, '.git', 'config'), 'metadata')
  await symlink('.git', join(cwd, 'metadata'))
  await assert.rejects(safePath(cwd, '.git/config'), /Git metadata/)
  await assert.rejects(safePath(cwd, 'metadata/config'), /Git metadata/)
  await assert.rejects(safePath(cwd, 'metadata/new-file'), /Git metadata/)
})

test('snapshots refuse directories and oversized files', async t => {
  const { cwd } = await fixture(t)
  await mkdir(join(cwd, 'directory'))
  await assert.rejects(snapshot(cwd, plan('directory')), /must be a file/)
  await writeFile(join(cwd, 'large'), Buffer.alloc(5 * 1024 * 1024 + 1))
  await assert.rejects(snapshot(cwd, plan('large')), /exceeds 5 MiB/)
})

test('artifact path components are sanitized and artifacts are private JSON', async t => {
  const { cwd } = await fixture(t)
  const dir = artifactDir(cwd, '../session', '/goal/../')
  assert(!relative(join(cwd, 'goals'), dir).startsWith('..'))
  const file = await saveArtifact(dir, '../../report', { summary: 'ok' })
  assert(!relative(dir, file).startsWith('..'))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { summary: 'ok' })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})
