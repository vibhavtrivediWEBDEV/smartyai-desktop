import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { z } from 'zod'

const proposalSchema = z.strictObject({ summary: z.string().min(1).max(400), code: z.string().min(1).max(5000) })
export type PythonProposal = z.infer<typeof proposalSchema> & { id: string }

export class PythonActions {
  private pending = new Map<string, { proposal: PythonProposal, expires: number }>()

  constructor(private readonly generate: (prompt: string, signal: AbortSignal) => Promise<string>) {}

  async propose(request: unknown): Promise<PythonProposal> {
    if (typeof request !== 'string' || !request.trim() || request.length > 1000) throw new Error('Describe a Python action in at most 1,000 characters.')
    const response = await this.generate(
      `Return ONLY a JSON object with exactly "summary" (plain-language description of what the code will do) and "code" (complete Python 3.9 code). The code runs with /usr/bin/python3 -I and must use the Python 3.9 standard library only: no third-party packages such as requests. For HTTP use urllib.request. No markdown. If the task is unclear or unsafe to describe precisely, do not return code. User request: ${JSON.stringify(request)}`,
      AbortSignal.timeout(60_000),
    )
    let parsed: unknown
    try { parsed = JSON.parse(response) } catch { throw new Error('GLM-5 did not return a valid Python proposal. Nothing was run.') }
    const result = proposalSchema.safeParse(parsed)
    if (!result.success) throw new Error('GLM-5 did not return a valid Python proposal. Nothing was run.')
    const proposal = { ...result.data, id: randomUUID() }
    this.pending.clear()
    this.pending.set(proposal.id, { proposal, expires: Date.now() + 5 * 60_000 })
    return proposal
  }

  async execute(id: unknown): Promise<string> {
    if (typeof id !== 'string') throw new Error('Invalid Python approval.')
    const pending = this.pending.get(id)
    this.pending.delete(id)
    if (!pending || pending.expires <= Date.now()) throw new Error('Python approval expired or was already used. Request a new proposal.')
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/python3', ['-I', '-B', '-c', pending.proposal.code], {
        cwd: tmpdir(), env: { PATH: '/usr/bin:/bin', HOME: tmpdir() }, timeout: 10_000, maxBuffer: 32_768,
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().slice(0, 2000) || error.message
          const missingModule = detail.match(/ModuleNotFoundError: No module named '([^']+)'/)
          reject(new Error(missingModule
            ? `Python did not complete: ${detail}\nJarvis runs /usr/bin/python3 in isolated mode; '${missingModule[1]}' is unavailable there. Request a new proposal using only the Python 3.9 standard library (urllib.request for HTTP).`
            : `Python did not complete: ${detail}`))
        }
        else resolve(`Python completed.${stdout.trim() ? ` Output: ${stdout.trim()}` : ''}${stderr.trim() ? ` Errors: ${stderr.trim()}` : ''}`)
      })
    })
  }

  reject(id: unknown): void {
    if (typeof id === 'string') this.pending.delete(id)
  }
}