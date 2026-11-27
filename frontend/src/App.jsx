import { useCallback, useEffect, useState } from 'react'
import './App.css'

const api = async (path, options) => {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Request failed')
  return body
}
const date = (value) => value ? new Date(value).toLocaleString() : '—'

function App() {
  const [workflows, setWorkflows] = useState([])
  const [runs, setRuns] = useState([])
  const [messages, setMessages] = useState([])
  const [selected, setSelected] = useState(null)
  const [amount, setAmount] = useState('750')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const refresh = useCallback(async () => {
    const [workflowData, runData, messageData] = await Promise.all([api('/workflows'), api('/runs'), api('/messages')])
    setWorkflows(workflowData); setRuns(runData); setMessages(messageData)
    if (selected) setSelected(await api(`/runs/${selected.id}`).catch(() => null))
  }, [selected?.id])
  useEffect(() => { refresh().catch((error) => setNotice(error.message)) }, [refresh])
  useEffect(() => { const timer = setInterval(() => refresh().catch(() => {}), 1500); return () => clearInterval(timer) }, [refresh])
  async function trigger(workflowId) {
    setBusy(true); setNotice('')
    try {
      const run = await api(`/workflows/${workflowId}/trigger`, { method: 'POST', body: JSON.stringify({ data: { amount: Number(amount), orderId: `ORD-${Date.now().toString().slice(-6)}` } }) })
      setSelected(await api(`/runs/${run.id}`))
      setNotice(Number(amount) > 500 ? 'Run started. It will send the follow-up after the 5 second wait.' : 'Run completed. This order is below the follow-up threshold.')
      await refresh()
    } catch (error) { setNotice(error.message) } finally { setBusy(false) }
  }
  const currentWorkflow = workflows.find((workflow) => workflow.name === 'High-value order follow-up') || workflows[0]
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-icon">↗</span><span>flow<span className="brand-light">state</span></span></div><div className="workspace-label">WORKSPACE</div><button className="nav-item active"><span>▤</span> Workflows <span className="nav-count">{workflows.length}</span></button><button className="nav-item" onClick={() => document.getElementById('runs')?.scrollIntoView({ behavior: 'smooth' })}><span>◷</span> Run history</button><button className="nav-item" onClick={() => document.getElementById('messages')?.scrollIntoView({ behavior: 'smooth' })}><span>✉</span> Messages</button><div className="sidebar-bottom"><div className="avatar">WS</div><div><strong>Workspace</strong><small>Local environment</small></div><span className="more">•••</span></div></aside>
    <main className="main"><header className="topbar"><div className="crumb">Workspace <span>/</span> Workflows</div><div className="top-right"><span className="live-dot"/> Engine online <div className="avatar small">WS</div></div></header>
      <div className="content"><div className="page-heading"><div><div className="eyebrow">AUTOMATION</div><h1>Workflows</h1><p>Build and monitor the work that runs in the background.</p></div><button className="button-secondary" onClick={() => refresh().catch((e) => setNotice(e.message))}>↻ <span>Refresh</span></button></div>
        {notice && <div className="notice"><span>●</span>{notice}<button onClick={() => setNotice('')}>×</button></div>}
        <section className="stats-grid"><div className="stat-card"><div className="stat-label">TOTAL WORKFLOWS <span className="stat-icon purple">▤</span></div><strong>{workflows.length}</strong><small>Ready to run</small></div><div className="stat-card"><div className="stat-label">TOTAL RUNS <span className="stat-icon blue">↗</span></div><strong>{runs.length}</strong><small>All time executions</small></div><div className="stat-card"><div className="stat-label">MESSAGES SENT <span className="stat-icon green">✉</span></div><strong>{messages.length}</strong><small>Simulated messages</small></div><div className="stat-card"><div className="stat-label">ENGINE STATUS <span className="status-pill">● Online</span></div><strong className="status-text">Operational</strong><small>Local SQLite storage</small></div></section>
        <section className="section-head"><div><h2>Your workflows</h2><p>Trigger a workflow to create a new run.</p></div><span className="subtle-count">{workflows.length} workflow{workflows.length === 1 ? '' : 's'}</span></section>
        <section className="workflow-list">{workflows.map((workflow) => <article className="workflow-card" key={workflow.id}><div className="workflow-symbol">⌘</div><div className="workflow-info"><div className="title-line"><h3>{workflow.name}</h3><span className="enabled">● Active</span></div><p>When a new order arrives, send a follow-up for orders over $500.</p><div className="workflow-meta"><span>◈ {workflow.definition.steps.length} steps</span><span>◷ Created {date(workflow.created_at)}</span><span>↗ {runs.filter((r) => r.workflow_id === workflow.id).length} runs</span></div></div><div className="workflow-actions"><button className="trigger-button" disabled={busy} onClick={() => trigger(workflow.id)}>▶ <span>Run workflow</span></button></div></article>)}{!workflows.length && <div className="empty">No workflows found.</div>}</section>
        <section className="demo-panel"><div className="demo-copy"><div className="demo-icon">✦</div><div><h3>Try the demo workflow</h3><p>Test the order follow-up with a sample order amount.</p></div></div><div className="demo-controls"><label htmlFor="amount">Order amount</label><div className="amount-wrap"><span>$</span><input id="amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" /></div><button className="primary-button" disabled={busy || !currentWorkflow} onClick={() => currentWorkflow && trigger(currentWorkflow.id)}>▶ <span>Trigger workflow</span></button></div></section>
        <section className="flow-preview"><div className="flow-title"><div><h3>Workflow preview</h3><p>High-value order follow-up</p></div><span className="demo-tag">DEMO</span></div><div className="flow-steps"><div className="flow-step"><span className="flow-node trigger-node">⌁</span><strong>New order</strong><small>Trigger</small></div><span className="connector"/><div className="flow-step"><span className="flow-node condition-node">◇</span><strong>Amount &gt; $500?</strong><small>Condition</small></div><span className="connector"/><div className="flow-step"><span className="flow-node wait-node">◷</span><strong>Wait 5 seconds</strong><small>Delay</small></div><span className="connector"/><div className="flow-step"><span className="flow-node message-node">✉</span><strong>Send follow-up</strong><small>Message</small></div></div></section>
        <section className="section-head lower-head" id="runs"><div><h2>Recent runs</h2><p>Execution history across your workflows.</p></div><span className="subtle-count">{runs.length} total</span></section><section className="table-card"><div className="table-scroll"><table><thead><tr><th>WORKFLOW</th><th>TRIGGER DATA</th><th>STATUS</th><th>STARTED</th><th></th></tr></thead><tbody>{runs.slice(0, 8).map((run) => <tr key={run.id} onClick={async () => setSelected(await api(`/runs/${run.id}`))}><td><strong>{workflows.find((w) => w.id === run.workflow_id)?.name || `Workflow ${run.workflow_id}`}</strong><small>Run #{run.id}</small></td><td>Order · ${run.trigger_data.amount ?? '—'}</td><td><span className={`run-status ${run.status}`}>{run.status}</span></td><td>{date(run.created_at)}</td><td className="arrow">›</td></tr>)}{!runs.length && <tr><td colSpan="5" className="empty-row">No runs yet. Trigger a workflow to see it here.</td></tr>}</tbody></table></div></section>
        <section className="section-head lower-head" id="messages"><div><h2>Sent messages</h2><p>Simulated follow-ups created by workflow runs.</p></div><span className="subtle-count">{messages.length} total</span></section><section className="message-list">{messages.slice(0, 5).map((message) => <div className="message-row" key={message.id}><span className="message-icon">✉</span><div className="message-content"><strong>Follow-up · Run #{message.run_id}</strong><p>{message.message}</p><small>{date(message.created_at)}</small></div></div>)}{!messages.length && <div className="empty-row">No messages sent yet.</div>}</section><footer>Workflow Engine <span>·</span> Running locally with SQLite</footer>
      </div></main>
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="run-modal" onClick={(event) => event.stopPropagation()}><div className="modal-header"><div><div className="eyebrow">RUN #{selected.id}</div><h2>Execution details</h2></div><button onClick={() => setSelected(null)}>×</button></div><div className="modal-summary"><span className={`run-status ${selected.status}`}>{selected.status}</span><span>Started {date(selected.created_at)}</span></div><div className="modal-data"><strong>Trigger data</strong><pre>{JSON.stringify(selected.trigger_data, null, 2)}</pre></div><div className="log-list"><strong>Activity log</strong>{selected.logs.map((log, index) => <div className="log-item" key={index}><span className="log-dot"/><div><p>{log.message}</p><small>{date(log.at)}</small></div></div>)}{!selected.logs.length && <p className="muted">No log entries yet.</p>}</div></section></div>}
  </div>
}
export default App
