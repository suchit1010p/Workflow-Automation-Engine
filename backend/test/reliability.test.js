import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolveListen()))
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function startServer(databaseFile) {
  const port = await availablePort()
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDirectory,
    env: { ...process.env, DB_FILE: databaseFile, PORT: String(port) },
    stdio: 'ignore',
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited with code ${child.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return { child, baseUrl }
    } catch {}
    await sleep(50)
  }
  child.kill()
  throw new Error('Backend did not become ready')
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(3000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  if (child.exitCode === null) await exited
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`)
  assert.equal(response.status, 200, `${path} should return HTTP 200`)
  return response.json()
}

test('waiting runs resume after restart and message delivery stays idempotent', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'workflow-engine-reliability-'))
  const databaseFile = join(temporaryDirectory, 'restart-test.sqlite')
  let server
  let db
  t.after(async () => {
    if (server) await stopServer(server.child)
    if (db?.open) db.close()
    const safeTempRoot = resolve(tmpdir())
    const target = resolve(temporaryDirectory)
    assert.ok(target.startsWith(`${safeTempRoot}${process.platform === 'win32' ? '\\' : '/'}`), 'test cleanup target must stay under the OS temp directory')
    rmSync(target, { recursive: true, force: true })
  })

  server = await startServer(databaseFile)
  const workflows = await getJson(server.baseUrl, '/api/workflows')
  const demo = workflows.find((workflow) => workflow.name === 'High-value order follow-up')
  assert.ok(demo, 'startup should create the demo workflow in the isolated test database')

  const triggerResponse = await fetch(`${server.baseUrl}/api/workflows/${demo.id}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { amount: 750, orderId: 'RESTART-TEST' } }),
  })
  assert.equal(triggerResponse.status, 201)
  const triggered = await triggerResponse.json()
  assert.equal(triggered.status, 'waiting')
  assert.ok(triggered.resume_at, 'wait resume time should be returned from persisted run state')
  assert.equal(triggered.current_step, 'follow_up', 'run should persist the next step to execute')
  const persistedResumeAt = triggered.resume_at

  await stopServer(server.child)
  server = null
  server = await startServer(databaseFile)
  const restartedRun = await getJson(server.baseUrl, `/api/runs/${triggered.id}`)
  assert.equal(restartedRun.status, 'waiting')
  assert.equal(restartedRun.resume_at, persistedResumeAt, 'restart must preserve the existing resume timestamp')
  assert.equal(restartedRun.current_step, 'follow_up')

  const resumeDeadline = Date.parse(persistedResumeAt) + 500
  let completed
  while (Date.now() < resumeDeadline + 3000) {
    completed = await getJson(server.baseUrl, `/api/runs/${triggered.id}`)
    if (completed.status === 'completed') break
    await sleep(75)
  }
  assert.equal(completed.status, 'completed', 'scheduler should resume the due run after restart')
  const sentMessages = await getJson(server.baseUrl, '/api/messages')
  assert.equal(sentMessages.length, 1)
  assert.equal(sentMessages[0].idempotency_key, `${triggered.id}:follow_up`)

  process.env.DB_FILE = databaseFile
  ;({ db } = await import('../src/database.js'))
  // Simulate a crash after message insertion but before run advancement was persisted.
  await stopServer(server.child)
  server = null
  db.prepare("UPDATE runs SET status = 'running', current_step = 'follow_up', resume_at = NULL WHERE id = ?").run(triggered.id)
  server = await startServer(databaseFile)
  const recoveredRun = await getJson(server.baseUrl, `/api/runs/${triggered.id}`)
  assert.equal(recoveredRun.status, 'completed', 'startup should recover a run left in its running state')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE run_id = ?').get(triggered.id).count, 1)
  assert.throws(() => db.prepare('INSERT INTO messages (run_id, step_id, message, idempotency_key) VALUES (?, ?, ?, ?)')
    .run(triggered.id, 'follow_up', 'duplicate', `${triggered.id}:follow_up`), /UNIQUE constraint failed/)

  const dueResponse = await fetch(`${server.baseUrl}/api/workflows/${demo.id}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { amount: 850, orderId: 'DUE-ON-STARTUP' } }),
  })
  assert.equal(dueResponse.status, 201)
  const dueRun = await dueResponse.json()
  assert.equal(dueRun.status, 'waiting')
  await stopServer(server.child)
  server = null
  await sleep(Math.max(0, Date.parse(dueRun.resume_at) - Date.now() + 150))

  server = await startServer(databaseFile)
  const recoveredDueRun = await getJson(server.baseUrl, `/api/runs/${dueRun.id}`)
  assert.equal(recoveredDueRun.status, 'completed', 'startup should immediately recover a wait whose resume time has passed')
  const finalMessages = await getJson(server.baseUrl, '/api/messages')
  assert.equal(finalMessages.length, 2)
  assert.equal(new Set(finalMessages.map((message) => message.idempotency_key)).size, 2)
})
