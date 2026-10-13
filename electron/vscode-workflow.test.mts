import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeProjects, validateProjectFolder } from './vscode-workflow.mjs'

test('rejects opening the home folder as a VS Code project', () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))
  try {
    const project = join(home, 'project')
    mkdirSync(project)
    assert.throws(() => validateProjectFolder(home, home), /home folder is not a project/)
    assert.doesNotThrow(() => validateProjectFolder(project, home))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('lists only active VS Code projects with an approved folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-vscode-'))
  try {
    const approved = join(root, 'Documents'), alpha = join(approved, 'group', 'alpha')
    const outside = join(root, 'beta')
    mkdirSync(alpha, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(approved, 'beta'))
    const status = '  112 window [1] (main.ts — alpha)\n  113 window [2] (notes.md — beta)\n'
    assert.deepEqual(activeProjects(status, [approved]), [{ name: 'alpha', path: alpha }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})