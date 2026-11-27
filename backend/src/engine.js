import { randomUUID } from 'node:crypto'
import { db } from './database.js'

const timers = new Map()
const stamp = () => new Date().toISOString()
const getRun = db.prepare('SELECT * FROM runs WHERE id = ?')
const saveRun = db.prepare(`UPDATE runs SET status = ?, trigger_data = ?, current_step = ?, resume_at = ?, logs = ?, updated_at = ? WHERE id = ?`)
const appendLog = (logs, stepId, message, data) => logs.push({ at: stamp(), stepId, message, ...(data === undefined ? {} : { data }) })

function persist(run, values) {
  saveRun.run(values.status, run.trigger_data, values.current_step, values.resume_at, JSON.stringify(values.logs), stamp(), run.id)
}

function scheduleResume(runId, when) {
  clearTimeout(timers.get(runId))
  const delay = Math.max(0, new Date(when).getTime() - Date.now())
  timers.set(runId, setTimeout(() => {
    timers.delete(runId)
    execute(runId)
  }, delay))
}

export function execute(runId) {
  let run = getRun.get(runId)
  if (!run || !['queued', 'waiting'].includes(run.status)) return
  const workflow = db.prepare('SELECT definition FROM workflows WHERE id = ?').get(run.workflow_id)
  if (!workflow) return
  const definition = JSON.parse(workflow.definition)
  const steps = new Map(definition.steps.map((step) => [step.id, step]))
  const data = JSON.parse(run.trigger_data)
  const logs = JSON.parse(run.logs)
  let stepId = run.current_step || definition.startAt
  let count = 0

  try {
    while (stepId && count++ < 100) {
      const step = steps.get(stepId)
      if (!step) throw new Error(`Step not found: ${stepId}`)
      if (step.type === 'task') {
        appendLog(logs, step.id, step.label || 'Task completed', { result: step.output ?? 'Task completed' })
        stepId = step.next || null
      } else if (step.type === 'condition') {
        const actual = data[step.field]
        const expected = step.value
        const compare = {
          equals: () => actual === expected,
          not_equals: () => actual !== expected,
          greater_than: () => Number(actual) > Number(expected),
          less_than: () => Number(actual) < Number(expected),
        }[step.operator]
        if (!compare) throw new Error(`Unsupported condition operator: ${step.operator}`)
        const result = compare()
        appendLog(logs, step.id, `Condition ${step.field} ${step.operator} ${expected}: ${result}`)
        stepId = result ? step.trueNext || null : step.falseNext || null
      } else if (step.type === 'wait') {
        const resumeAt = new Date(Date.now() + Math.max(0, Number(step.durationMs) || 0)).toISOString()
        appendLog(logs, step.id, `Waiting until ${resumeAt}`)
        persist(run, { status: 'waiting', current_step: step.next || null, resume_at: resumeAt, logs })
        scheduleResume(run.id, resumeAt)
        return
      } else if (step.type === 'message') {
        const key = `${run.id}:${step.id}`
        db.prepare('INSERT OR IGNORE INTO messages (run_id, step_id, message, idempotency_key) VALUES (?, ?, ?, ?)')
          .run(run.id, step.id, step.message || '', key)
        appendLog(logs, step.id, 'Simulated message sent', { message: step.message || '' })
        stepId = step.next || null
      } else {
        throw new Error(`Unsupported step type: ${step.type}`)
      }
      persist(run, { status: 'running', current_step: stepId, resume_at: null, logs })
    }
    if (count >= 100) throw new Error('Workflow exceeded 100 steps')
    persist(run, { status: 'completed', current_step: null, resume_at: null, logs })
  } catch (error) {
    appendLog(logs, stepId, `Execution failed: ${error.message}`)
    persist(run, { status: 'failed', current_step: stepId, resume_at: null, logs })
  }
}

export function triggerWorkflow(workflowId, triggerData) {
  const workflow = db.prepare('SELECT id FROM workflows WHERE id = ?').get(workflowId)
  if (!workflow) return null
  const definition = JSON.parse(db.prepare('SELECT definition FROM workflows WHERE id = ?').get(workflowId).definition)
  const now = stamp()
  const result = db.prepare(`INSERT INTO runs (workflow_id, status, trigger_data, current_step, logs, created_at, updated_at)
    VALUES (?, 'queued', ?, ?, '[]', ?, ?)`).run(workflowId, JSON.stringify(triggerData), definition.startAt, now, now)
  execute(Number(result.lastInsertRowid))
  return getRun.get(Number(result.lastInsertRowid))
}

export function resumeWaitingRuns() {
  for (const run of db.prepare("SELECT id, resume_at FROM runs WHERE status = 'waiting'").all()) scheduleResume(run.id, run.resume_at)
}

export function makeId() { return randomUUID() }
