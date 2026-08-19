import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const runtime = process.argv[2]
const label = process.argv[3] ?? `${runtime}-dynamic`
const output = process.argv[4] ?? `/tmp/d6-runtime-ab-${label}-${Date.now()}.tsv`
if (!['webkit', 'chromium'].includes(runtime)) {
  throw new Error('Usage: node scripts/d6-runtime-ab-monitor.mjs webkit|chromium label [output.tsv]')
}
const schedule = label.includes('static') ? [0, 30, 60, 120, 180, 300] : [0, 30, 60, 120, 180, 300, 420, 600]

function allProcesses() {
  const text = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' })
  return text.trim().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3], args: match[4] }] : []
  })
}

function classify(process, all) {
  if (runtime === 'webkit') {
    if (process.command.startsWith('WebKitWebProces')) return 'webkit-renderer'
    if (process.command.startsWith('WebKitNetworkPr')) return 'webkit-network'
    if (process.args.includes('quadruped-robot-research')) return 'tauri-main'
    return null
  }
  const electronMain = all.find((item) => item.command === 'electron'
    && item.args.includes('electron-poc/main.cjs') && !item.args.includes('--type='))
  if (!electronMain) return null
  const descendant = (item) => {
    let current = item
    for (let depth = 0; depth < 5; depth += 1) {
      if (current.pid === electronMain.pid) return true
      current = all.find((candidate) => candidate.pid === current.ppid)
      if (!current) return false
    }
    return false
  }
  if (!descendant(process)) return null
  if (process.pid === electronMain.pid) return 'electron-main'
  if (process.args.includes('--type=renderer')) return 'chromium-renderer'
  if (process.args.includes('--type=gpu-process')) return 'chromium-gpu'
  if (process.args.includes('--type=utility')) {
    return process.args.includes('network.mojom.NetworkService') ? 'chromium-network' : 'chromium-utility'
  }
  return 'chromium-other'
}

function memory(pid) {
  const path = `/proc/${pid}/smaps_rollup`
  if (!existsSync(path)) return null
  const fields = Object.fromEntries(readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+) kB$/)
    return match ? [[match[1], Number(match[2])]] : []
  }))
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  return {
    rss: Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0),
    pss: fields.Pss ?? 0, privateDirty: fields.Private_Dirty ?? 0,
    anonymous: fields.Anonymous ?? 0,
    threads: Number(status.match(/^Threads:\s+(\d+)$/m)?.[1] ?? 0),
  }
}

function cpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch { return null }
}

writeFileSync(output, 'elapsed_s\tgroup\tpid\tppid\trss_kb\tpss_kb\tprivate_dirty_kb\tanonymous_kb\tthreads\tcpu_pct\tjs_heap_used_kb\tjs_heap_total_kb\tsource_telemetry\tsource_pose\tstore_telemetry_updates\tstore_pose_updates\trobot_panel_renders\tactive_timers\tconsole_errors\trenderer_gone\n')
const started = performance.now()
const previousCpu = new Map()
const tracked = new Map()
for (const target of schedule) {
  const remaining = target * 1000 - (performance.now() - started)
  if (remaining > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining))
  const all = allProcesses()
  let diagnostic = null
  if (runtime === 'chromium') {
    const mode = label.includes('static') ? 'static' : 'dynamic'
    const diagnosticPath = `/tmp/d6-chromium-poc-${mode}-diagnostics.json`
    if (existsSync(diagnosticPath)) {
      try { diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf8')) } catch { diagnostic = null }
    }
  }
  const current = all.flatMap((process) => {
    const group = classify(process, all)
    return group ? [{ ...process, group }] : []
  })
  if (current.length === 0) throw new Error(`No ${runtime} POC processes found`)
  for (const process of current) {
    const values = memory(process.pid)
    if (!values) continue
    const previousPid = tracked.get(process.group)
    if (previousPid != null && previousPid !== process.pid && !process.group.endsWith('-other')) {
      throw new Error(`${process.group} restarted: ${previousPid} -> ${process.pid}`)
    }
    tracked.set(process.group, process.pid)
    const ticks = cpuTicks(process.pid)
    const previous = previousCpu.get(process.pid)
    const cpu = previous && ticks != null
      ? ((ticks - previous.ticks) / 100) / Math.max(target - previous.elapsed, 0.001) * 100 : 0
    if (ticks != null) previousCpu.set(process.pid, { ticks, elapsed: target })
    const rendererDiagnostic = process.group === 'chromium-renderer' ? diagnostic?.renderer : null
    const workload = rendererDiagnostic?.workload
    appendFileSync(output, [target, process.group, process.pid, process.ppid, values.rss, values.pss,
      values.privateDirty, values.anonymous, values.threads, cpu.toFixed(2),
      Math.round((rendererDiagnostic?.heap?.used ?? 0) / 1024),
      Math.round((rendererDiagnostic?.heap?.total ?? 0) / 1024),
      workload?.sourceTelemetry ?? 0, workload?.sourcePose ?? 0,
      workload?.storeTelemetryUpdates ?? 0, workload?.storePoseUpdates ?? 0,
      workload?.robotPanelRenders ?? 0, workload?.activeTimers ?? 0,
      process.group === 'chromium-renderer' ? diagnostic?.consoleErrors ?? 0 : 0,
      process.group === 'chromium-renderer' && diagnostic?.rendererGone ? 1 : 0,
    ].join('\t') + '\n')
  }
  console.log(`D6_RUNTIME_AB_SAMPLE runtime=${runtime} elapsed_s=${target} output=${output}`)
}
console.log(output)
