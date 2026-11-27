import express from 'express'
import cors from 'cors'
import { db } from './database.js'
import { execute, resumeWaitingRuns, triggerWorkflow } from './engine.js'

const app = express()
const port = Number(process.env.PORT || 3001)
app.use(cors())
app.use(express.json())

const demo = {
  startAt: 'check_amount',
  steps: [
    { id: 'check_amount', type: 'condition', field: 'amount', operator: 'greater_than', value: 500, trueNext: 'delay', falseNext: 'small_order' },
    { id: 'delay', type: 'wait', durationMs: 5000, next: 'follow_up' },
    { id: 'follow_up', type: 'message', message: 'Thanks for your order! We’ll be in touch with a follow-up shortly.', next: null },
    { id: 'small_order', type: 'task', label: 'Order did not meet the follow-up threshold', output: 'No follow-up was sent.', next: null },
  ],
}

if (!db.prepare('SELECT id FROM workflows LIMIT 1').get()) {
  db.prepare('INSERT INTO workflows (name, definition) VALUES (?, ?)').run('High-value order follow-up', JSON.stringify(demo))
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object' || !Array.isArray(definition.steps) || !definition.startAt) return 'definition must include startAt and a steps array'
  const ids = new Set()
  for (const step of definition.steps) {
    if (!step.id || ids.has(step.id)) return 'each step must have a unique id'
    ids.add(step.id)
    if (!['task', 'condition', 'wait', 'message'].includes(step.type)) return `unsupported step type: ${step.type}`
    if (step.type === 'condition' && !['equals', 'not_equals', 'greater_than', 'less_than'].includes(step.operator)) return `unsupported condition operator: ${step.operator}`
  }
  if (!ids.has(definition.startAt)) return 'startAt must reference an existing step'
  return null
}
const workflowRow = (row) => row && ({ ...row, definition: JSON.parse(row.definition) })
const runRow = (row) => row && ({ ...row, trigger_data: JSON.parse(row.trigger_data), logs: JSON.parse(row.logs) })

app.post('/api/workflows', (req, res) => {
  const { name, definition } = req.body || {}
  const error = validateDefinition(definition)
  if (!name || error) return res.status(400).json({ error: error || 'name is required' })
  const result = db.prepare('INSERT INTO workflows (name, definition) VALUES (?, ?)').run(name, JSON.stringify(definition))
  res.status(201).json(workflowRow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(result.lastInsertRowid)))
})

app.get('/api/workflows', (_req, res) => res.json(db.prepare('SELECT * FROM workflows ORDER BY id DESC').all().map(workflowRow)))
app.post('/api/workflows/:id/trigger', (req, res) => {
  const data = req.body?.data ?? req.body
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'trigger data must be a JSON object' })
  const run = triggerWorkflow(Number(req.params.id), data)
  if (!run) return res.status(404).json({ error: 'workflow not found' })
  res.status(201).json(runRow(run))
})
app.get('/api/runs', (_req, res) => res.json(db.prepare('SELECT * FROM runs ORDER BY id DESC').all().map(runRow)))
app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(req.params.id))
  if (!run) return res.status(404).json({ error: 'run not found' })
  const workflow = db.prepare('SELECT id, name FROM workflows WHERE id = ?').get(run.workflow_id)
  res.json({ ...runRow(run), workflow })
})
app.get('/api/messages', (_req, res) => res.json(db.prepare('SELECT * FROM messages ORDER BY id DESC').all()))
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }))

resumeWaitingRuns()
app.listen(port, () => console.log(`Workflow API listening on http://localhost:${port}`))
