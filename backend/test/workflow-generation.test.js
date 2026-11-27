import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { validateWorkflowDefinition } from '../src/workflow-generator.js'

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function startBackend(databaseFile) {
  const portServer = createServer()
  await new Promise((resolveListen, reject) => portServer.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolveListen()))
  const { port } = portServer.address()
  await new Promise((resolveClose, reject) => portServer.close((error) => error ? reject(error) : resolveClose()))
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDirectory,
    env: { ...process.env, DB_FILE: databaseFile, PORT: String(port), GROQ_API_KEY: '' },
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

async function stopBackend(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(3000)])
  if (child.exitCode === null) child.kill('SIGKILL')
  if (child.exitCode === null) await exited
}

test('fallback generation validates, saves, and executes a natural-language order workflow', async (t) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'workflow-engine-generation-'))
  const databaseFile = join(temporaryDirectory, 'generated.sqlite')
  let backend
  t.after(async () => {
    if (backend) await stopBackend(backend.child)
    const target = resolve(temporaryDirectory)
    const tempRoot = resolve(tmpdir())
    assert.ok(target.startsWith(`${tempRoot}${process.platform === 'win32' ? '\\' : '/'}`), 'test cleanup target must stay under the OS temp directory')
    rmSync(target, { recursive: true, force: true })
  })

  backend = await startBackend(databaseFile)
  const description = 'When a new order arrives, if the order amount is above $1000, wait 10 seconds and send a VIP thank-you message.'
  const generatedResponse = await fetch(`${backend.baseUrl}/api/workflows/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  })
  assert.equal(generatedResponse.status, 200)
  const generated = await generatedResponse.json()
  assert.equal(generated.source, 'fallback')
  assert.equal(generated.definition.trigger.type, 'order_created')
  assert.equal(validateWorkflowDefinition(generated.definition, { requireOrderTrigger: true }), null)
  assert.equal(generated.definition.steps.find((step) => step.type === 'condition').value, 1000)
  assert.equal(generated.definition.steps.find((step) => step.type === 'wait').durationMs, 10_000)
  assert.match(generated.definition.steps.find((step) => step.type === 'message').message, /VIP customer/)

  const invalidGeneration = await fetch(`${backend.baseUrl}/api/workflows/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Send a message.' }),
  })
  assert.equal(invalidGeneration.status, 422)
  assert.match((await invalidGeneration.json()).error, /order trigger/i)

  const invalidWorkflow = await fetch(`${backend.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invalid', definition: { startAt: 'a', steps: [{ id: 'a', type: 'shell', code: 'process.exit()' }] } }),
  })
  assert.equal(invalidWorkflow.status, 400)

  const savedResponse = await fetch(`${backend.baseUrl}/api/workflows`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: generated.name, definition: generated.definition }),
  })
  assert.equal(savedResponse.status, 201)
  const saved = await savedResponse.json()
  const listed = await fetch(`${backend.baseUrl}/api/workflows`).then((response) => response.json())
  assert.ok(listed.some((workflow) => workflow.id === saved.id), 'saved workflow should appear in workflow listing')

  const triggerResponse = await fetch(`${backend.baseUrl}/api/workflows/${saved.id}/trigger`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { amount: 1200, orderId: 'GENERATED-ORDER' } }),
  })
  assert.equal(triggerResponse.status, 201)
  const run = await triggerResponse.json()
  assert.equal(run.status, 'waiting')

  const deadline = Date.now() + 12_000
  let detail
  while (Date.now() < deadline) {
    detail = await fetch(`${backend.baseUrl}/api/runs/${run.id}`).then((response) => response.json())
    if (detail.status === 'completed') break
    await sleep(100)
  }
  assert.equal(detail.status, 'completed')
  const messages = await fetch(`${backend.baseUrl}/api/messages`).then((response) => response.json())
  assert.equal(messages.length, 1)
  assert.equal(messages[0].run_id, run.id)
  assert.equal(messages[0].message, generated.definition.steps.find((step) => step.type === 'message').message)
})

test('definition validation rejects broken references, invalid waits, and executable step properties', () => {
  const base = { startAt: 'gate', trigger: { type: 'order_created' }, steps: [
    { id: 'gate', type: 'condition', field: 'amount', operator: 'greater_than', value: 100, trueNext: 'delay', falseNext: null },
    { id: 'delay', type: 'wait', durationMs: 1000, next: 'send' },
    { id: 'send', type: 'message', message: 'Thanks!', next: null },
  ] }
  assert.equal(validateWorkflowDefinition(base, { requireOrderTrigger: true }), null)
  const invalidReference = structuredClone(base)
  invalidReference.steps[0].trueNext = 'missing'
  assert.match(validateWorkflowDefinition(invalidReference), /reference an existing step/)
  const invalidWait = structuredClone(base)
  invalidWait.steps[1].durationMs = 0
  assert.match(validateWorkflowDefinition(invalidWait), /wait duration/)
  const executable = structuredClone(base)
  executable.steps[2].code = 'process.exit()'
  assert.match(validateWorkflowDefinition(executable), /unsupported properties/)
  const missingMessage = structuredClone(base)
  missingMessage.steps[2].message = '  '
  assert.match(validateWorkflowDefinition(missingMessage), /message content/)
})
