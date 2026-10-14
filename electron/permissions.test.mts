import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionManager, websiteScope } from './permissions.mjs'

test('grants stay in scope, survive restart, and revoke permanently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const folder = join(root, 'work')
    const other = join(root, 'work-extra')
    const file = join(root, 'permissions.json')
    await mkdir(folder)
    await mkdir(other)
    const manager = new PermissionManager(file)
    await manager.load()
    assert.equal(manager.isAllowed('files.read', folder), false)
    const grant = await manager.grantFolder(folder)
    assert.equal(manager.isAllowed('files.read', folder), true)
    assert.equal(manager.isAllowed('files.read', other), false)
    assert.equal(manager.isAllowed('files.delete', folder), false)
    assert.equal(manager.isAllowed('files.read', join(folder, '..', 'work-extra')), false)
    assert.equal(manager.isAllowed('files.read', join(folder, 'missing')), false)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.isAllowed('files.read', folder), true)
    await restarted.revoke(grant.id)
    assert.equal(restarted.isAllowed('files.read', folder), false)
    const afterRevocation = new PermissionManager(file)
    await afterRevocation.load()
    assert.equal(afterRevocation.isAllowed('files.read', folder), false)
    assert.ok(afterRevocation.list()[0].revokedAt)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('website grants are scoped to an HTTPS origin and can be revoked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const manager = new PermissionManager(join(root, 'permissions.json'))
    await manager.load()
    assert.equal(websiteScope('https://example.com/report'), 'https://example.com')
    assert.throws(() => websiteScope('file:///etc/passwd'), /HTTPS/)
    assert.throws(() => websiteScope('https://user:pass@example.com'), /HTTPS/)
    const grant = await manager.grantWebsite('https://example.com/report')
    assert.equal(manager.isAllowed('browser.open', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.read', 'https://example.com'), false)
    const read = await manager.grantWebsiteRead('https://example.com/report')
    assert.equal(manager.isAllowed('browser.read', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.interact', 'https://example.com'), false)
    const interact = await manager.grantWebsiteInteract('https://example.com/report')
    assert.equal(manager.isAllowed('browser.interact', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.interact', 'https://other.example.com'), false)
    assert.equal(manager.isAllowed('browser.read', 'https://other.example.com'), false)
    await manager.revoke(read.id)
    assert.equal(manager.isAllowed('browser.read', 'https://example.com'), false)
    await manager.revoke(interact.id)
    assert.equal(manager.isAllowed('browser.interact', 'https://example.com'), false)
    assert.equal(manager.isAllowed('browser.open', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.open', 'https://other.example.com'), false)
    assert.equal(manager.isAllowed('browser.open', 'http://example.com'), false)
    await manager.revoke(grant.id)
    assert.equal(manager.isAllowed('browser.open', 'https://example.com'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('public reads are automatic but revoked or denied origins stay blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    assert.equal(await manager.allowPublicRead('https://example.com/page'), true)
    assert.equal(await manager.allowPublicRead('https://example.com/other'), true)
    assert.equal(manager.list().filter((item) => item.capability === 'browser.read').length, 1)
    const read = manager.list().find((item) => item.capability === 'browser.read')!
    assert.equal(read.source, 'automatic-public-read')
    assert.equal(manager.isAllowed('browser.read', 'https://other.example.com'), false)
    await manager.revoke(read.id)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(await restarted.allowPublicRead('https://example.com'), false)
    assert.equal(restarted.isAllowed('browser.read', 'https://example.com'), false)
    await restarted.grantWebsiteRead('https://example.com')
    assert.equal(await restarted.allowPublicRead('https://example.com'), true)
    await assert.rejects(restarted.allowPublicRead('http://example.com'), /HTTPS/)
    await assert.rejects(restarted.allowPublicRead('https://127.0.0.1'), /private/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('browser scroll and click grants persist and revoke independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    const scroll = await manager.grantBrowserAction('https://example.com/page', 'scroll')
    const click = await manager.grantBrowserAction('https://example.com/page', 'click')
    assert.equal(manager.isAllowed('browser.scroll', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.click', 'https://other.example.com'), false)
    assert.equal(manager.isAllowed('browser.read', 'https://example.com'), false)
    await manager.revoke(scroll.id)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.isAllowed('browser.scroll', 'https://example.com'), false)
    assert.equal(restarted.isAllowed('browser.click', 'https://example.com'), true)
    await restarted.revoke(click.id)
    assert.equal(restarted.isAllowed('browser.click', 'https://example.com'), false)
    await assert.rejects(manager.grantBrowserAction('https://example.com', 'input' as 'click'), /Invalid browser action/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('signed-in research defaults off and requires independent origin grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    assert.equal(manager.useSignedInProfile(), false)
    const anonymous = await manager.grantWebsiteRead('https://example.com/page')
    assert.equal(manager.isAllowed('browser.readSignedIn', 'https://example.com'), false)
    await manager.setSignedInProfile(true)
    const signedIn = await manager.grantWebsiteSignedInRead('https://example.com/page')
    assert.equal(manager.isAllowed('browser.readSignedIn', 'https://example.com'), true)
    assert.equal(manager.isAllowed('browser.readSignedIn', 'https://other.example.com'), false)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.useSignedInProfile(), true)
    await restarted.revoke(signedIn.id)
    assert.equal(restarted.isAllowed('browser.readSignedIn', 'https://example.com'), false)
    assert.equal(restarted.isAllowed('browser.read', 'https://example.com'), true)
    await restarted.revoke(anonymous.id)
    await restarted.setSignedInProfile(false)
    const disabled = new PermissionManager(file)
    await disabled.load()
    assert.equal(disabled.useSignedInProfile(), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('symlink escapes, denied and expired records never authorize access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const folder = join(root, 'work')
    const outside = join(root, 'private')
    const file = join(root, 'permissions.json')
    await mkdir(folder)
    await mkdir(outside)
    await symlink(outside, join(folder, 'shortcut'))
    const manager = new PermissionManager(file)
    await manager.load()
    await manager.recordDenial('files.read', folder)
    assert.equal(manager.isAllowed('files.read', folder), false)
    await manager.grantFolder(folder)
    assert.equal(manager.isAllowed('files.read', folder), true)
    await manager.recordDenial('files.delete', folder)
    assert.equal(manager.isAllowed('files.read', join(folder, 'shortcut')), false)
    assert.equal(manager.isAllowed('files.delete', folder), false)
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    persisted.permissions.find((record: { state: string }) => record.state === 'granted').expiresAt = new Date(Date.now() - 1000).toISOString()
    await writeFile(file, JSON.stringify(persisted))
    const expired = new PermissionManager(file)
    await expired.load()
    assert.equal(expired.isAllowed('files.read', folder), false)
    await rm(folder, { recursive: true })
    await symlink(outside, folder)
    assert.equal(manager.isAllowed('files.read', outside), false)
    assert.equal(manager.isAllowed('files.read', folder), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('VS Code permission is scoped, persisted and revocable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    assert.equal(manager.isAllowed('apps.open', 'vscode'), false)
    const grant = await manager.grantVSCode()
    assert.equal(manager.isAllowed('apps.open', 'vscode'), true)
    assert.equal(manager.isAllowed('apps.open', 'other'), false)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.isAllowed('apps.open', 'vscode'), true)
    await restarted.revoke(grant.id)
    assert.equal(restarted.isAllowed('apps.open', 'vscode'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Terminal permission is scoped independently from VS Code and revocable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    assert.equal(manager.isAllowed('apps.open', 'terminal'), false)
    const grant = await manager.grantTerminal()
    assert.equal(manager.isAllowed('apps.open', 'terminal'), true)
    assert.equal(manager.isAllowed('apps.open', 'vscode'), false)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.isAllowed('apps.open', 'terminal'), true)
    await restarted.revoke(grant.id)
    assert.equal(restarted.isAllowed('apps.open', 'terminal'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('named app grants are independent, persisted, and revocable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    const grant = await manager.grantApp('Photos')
    assert.equal(grant.scope, 'photos')
    assert.equal(manager.isAllowed('apps.open', 'photos'), true)
    assert.equal(manager.isAllowed('apps.open', 'terminal'), false)
    assert.equal((await manager.grantApp('PHOTOS')).id, grant.id)
    await assert.rejects(() => manager.grantApp('../Photos'), /valid application name/)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.isAllowed('apps.open', 'photos'), true)
    await restarted.revoke(grant.id)
    assert.equal(restarted.isAllowed('apps.open', 'photos'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('malformed stores fail closed and concurrent grants do not overwrite each other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    await writeFile(file, '{ invalid')
    await assert.rejects(() => new PermissionManager(file).load(), /could not be loaded safely/)
    await rm(file)
    const manager = new PermissionManager(file)
    await manager.load()
    const folders = [join(root, 'one'), join(root, 'two')]
    await Promise.all(folders.map((folder) => mkdir(folder)))
    await Promise.all(folders.map((folder) => manager.grantFolder(folder)))
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(restarted.list().length, 2)
    assert.ok(folders.every((folder) => restarted.isAllowed('files.read', folder)))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('retired research permission is backed up and removed without losing other grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-permissions-'))
  try {
    const file = join(root, 'permissions.json')
    const manager = new PermissionManager(file)
    await manager.load()
    const grant = await manager.grantWebsiteRead('https://example.com')
    const retired = { ...grant, id: 'ea9878de-7812-4a05-a315-6975dcb39587', capability: 'browser.research-autopilot', scope: 'public-https' }
    const original = JSON.stringify({ version: 1, permissions: [grant, retired] })
    await writeFile(file, original)

    const migrated = new PermissionManager(file)
    await migrated.load()
    assert.equal(migrated.isAllowed('browser.read', 'https://example.com'), true)
    assert.deepEqual(migrated.list(), [grant])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).permissions, [grant])
    const backups = (await readdir(root)).filter((name) => name.endsWith('.backup'))
    assert.equal(backups.length, 1)
    assert.equal(await readFile(join(root, backups[0]), 'utf8'), original)

    await writeFile(file, JSON.stringify({ version: 1, permissions: [grant, { ...retired, scope: 'unrecognized' }] }))
    await assert.rejects(() => new PermissionManager(file).load(), /could not be loaded safely/)
  } finally { await rm(root, { recursive: true, force: true }) }
})