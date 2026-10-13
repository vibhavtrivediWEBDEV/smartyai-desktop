import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSearch, parseScreenshotDate } from './file-search.mjs'
import { PermissionManager } from './permissions.mjs'

test('asks folder by folder, skips denial, and only searches approved scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop'), downloads = join(root, 'Downloads')
    await mkdir(desktop)
    await mkdir(downloads)
    await writeFile(join(downloads, 'report.txt'), 'secret')
    await symlink(downloads, join(desktop, 'linked'))
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }, { name: 'Downloads', path: downloads }])
    const first = await search.start('report')
    assert.equal(first.folder, 'Desktop')
    assert.deepEqual(first.matches, [])
    assert.equal(permissions.isAllowed('files.read', desktop), false)
    const second = await search.decide(first.id, true)
    assert.equal(second.folder, 'Downloads')
    assert.deepEqual(second.matches, [])
    assert.equal(permissions.isAllowed('files.read', desktop), true)
    assert.equal(permissions.isAllowed('files.read', downloads), false)
    await assert.rejects(() => search.decide(first.id, true), /no longer active/)
    const done = await search.decide(second.id, true)
    assert.equal(done.status, 'done')
    assert.deepEqual(done.matches, [join(downloads, 'report.txt')])
    await assert.rejects(() => search.decide(done.id, true), /no longer active/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('opening an ordinary search result requires a current result and an active folder grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const downloads = join(root, 'Downloads')
    await mkdir(downloads)
    const spreadsheet = join(downloads, 'budget.xlsx')
    const unlisted = join(downloads, 'private.xlsx')
    await writeFile(spreadsheet, 'spreadsheet')
    await writeFile(unlisted, 'private')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    const grant = await permissions.grantFolder(downloads)
    const search = new FileSearch(permissions, [{ name: 'Downloads', path: downloads }], async () => [spreadsheet])
    assert.deepEqual((await search.start('budget')).matches, [spreadsheet])
    assert.equal(search.reveal(spreadsheet), spreadsheet)
    assert.throws(() => search.reveal(unlisted), /not available/)
    await permissions.revoke(grant.id)
    assert.throws(() => search.reveal(spreadsheet), /not available/)
    await search.start('missing')
    assert.throws(() => search.reveal(spreadsheet), /not available/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('denied folders are skipped and stale approvals cannot be replayed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop'), downloads = join(root, 'Downloads')
    await mkdir(desktop)
    await mkdir(downloads)
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }, { name: 'Downloads', path: downloads }])
    const first = await search.start('report')
    const second = await search.decide(first.id, false)
    assert.equal(second.folder, 'Downloads')
    assert.equal(permissions.isAllowed('files.read', desktop), false)
    const done = await search.decide(second.id, false)
    assert.equal(done.status, 'done')
    assert.deepEqual(done.checked, ['Desktop: skipped', 'Downloads: skipped'])
    await assert.rejects(() => search.decide(first.id, true), /no longer active/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('indexed search finds deep filenames without accepting outside paths or symlinks', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const documents = join(root, 'Documents'), outside = join(root, 'outside')
    const deep = join(documents, 'one', 'two', 'three', 'four', 'five')
    await mkdir(deep, { recursive: true })
    await mkdir(outside)
    const match = join(deep, 'VIBHAV.pdf'), hidden = join(outside, 'VIBHAV.pdf'), link = join(documents, 'VIBHAV.pdf')
    await writeFile(match, 'expected')
    await writeFile(hidden, 'out of scope')
    await symlink(hidden, link)
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    const search = new FileSearch(permissions, [{ name: 'Documents', path: documents }], async (folder, filename) => {
      assert.equal(folder, documents)
      assert.equal(filename, 'VIBHAV.pdf')
      return [hidden, link, match]
    })
    const pending = await search.start('VIBHAV.pdf')
    assert.equal(pending.folder, 'Documents')
    const done = await search.decide(pending.id, true)
    assert.equal(done.status, 'done')
    assert.deepEqual(done.matches, [match])
    assert.deepEqual(done.checked, ['Documents: searched'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('continues through Downloads and ranks its exact root match before a deep project asset', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const documents = join(root, 'Documents'), downloads = join(root, 'Downloads')
    const deep = join(documents, 'vibhav', 'smarty', 'SmartyAI', 'public')
    await mkdir(deep, { recursive: true })
    await mkdir(downloads)
    const asset = join(deep, 'VIBHAV.pdf'), downloaded = join(downloads, 'VIBHAV.pdf')
    await writeFile(asset, 'project asset')
    await writeFile(downloaded, 'downloaded file')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    const search = new FileSearch(permissions, [{ name: 'Documents', path: documents }, { name: 'Downloads', path: downloads }], async (folder) => folder === documents ? [asset] : [downloaded])
    const first = await search.start('VIBHAV.pdf')
    const next = await search.decide(first.id, true)
    assert.equal(next.status, 'permission-required')
    assert.equal(next.folder, 'Downloads')
    assert.deepEqual(next.matches, [asset])
    const done = await search.decide(next.id, true)
    assert.equal(done.status, 'done')
    assert.deepEqual(done.matches, [downloaded, asset])
    assert.deepEqual(done.checked, ['Documents: searched', 'Downloads: searched'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('find last screenshot matches screenshot filenames through the index', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop')
    await mkdir(desktop)
    const screenshot = join(desktop, 'Screenshot 2026-10-13 at 1.00 PM.png')
    await writeFile(screenshot, 'image')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }], async (_folder, filename) => {
      assert.ok(filename === 'screenshot' || filename === 'screen shot')
      return filename === 'screenshot' ? [screenshot] : []
    })
    const done = await search.start('last screenshot')
    assert.deepEqual(done.matches, [screenshot])
    assert.deepEqual(done.errors, [])
    assert.deepEqual(done.checked, ['Desktop: searched'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dated search finds Screen Shot filenames through the index', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop')
    await mkdir(desktop)
    const screenshot = join(desktop, 'Screen Shot 2026-10-13 at 1.00 PM.png')
    await writeFile(screenshot, 'image')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }], async (_folder, term) => term === 'screen shot' ? [screenshot] : [], () => new Date(2026, 9, 13))
    const done = await search.start("today's screenshots")
    assert.deepEqual(done.matches, [screenshot])
    assert.deepEqual(done.checked, ['Desktop: searched'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('last screenshot returns the newest indexed match even after twenty older matches', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop'), downloads = join(root, 'Downloads')
    await mkdir(desktop)
    await mkdir(downloads)
    const older = await Promise.all(Array.from({ length: 21 }, async (_, index) => {
      const file = join(desktop, `Screenshot old ${index}.png`)
      await writeFile(file, 'old')
      await utimes(file, new Date(2020, 0, 1), new Date(2020, 0, 1))
      return file
    }))
    const newest = join(downloads, 'Screenshot newest.png')
    await writeFile(newest, 'new')
    const sameDay = join(downloads, 'Screenshot same day.png')
    await writeFile(sameDay, 'same day')
    const screenshotDay = new Date(2026, 9, 13, 12)
    await utimes(newest, screenshotDay, screenshotDay)
    await utimes(sameDay, new Date(2026, 9, 13, 11), new Date(2026, 9, 13, 11))
    const decoy = join(downloads, 'screenshotClip.d.ts')
    await writeFile(decoy, 'newer code')
    const unlisted = join(downloads, 'private.png')
    await writeFile(unlisted, 'not a result')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    const downloadGrant = await permissions.grantFolder(downloads)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }, { name: 'Downloads', path: downloads }], async (folder) => folder === desktop ? older : [decoy, sameDay, newest])
    const done = await search.start('last screenshot')
    assert.equal(done.matches[0], newest)
    assert.deepEqual(done.matches, [newest, sameDay])
    assert.deepEqual(done.errors, [])
    assert.equal(search.reveal(newest), newest)
    assert.equal(search.preview(newest), newest)
    assert.throws(() => search.reveal(decoy), /not available/)
    assert.throws(() => search.reveal(unlisted), /not available/)
    assert.throws(() => search.preview(unlisted), /not available/)
    await permissions.revoke(downloadGrant.id)
    assert.throws(() => search.reveal(newest), /not available/)
    assert.throws(() => search.preview(newest), /not available/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('todays screenshots returns every image modified on the local calendar day, newest first', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop'), downloads = join(root, 'Downloads')
    await mkdir(desktop)
    await mkdir(downloads)
    const files = [join(desktop, 'Screenshot morning.png'), join(downloads, 'Screenshot evening.jpg'), join(desktop, 'Screenshot yesterday.png'), join(downloads, 'screenshotClip.d.ts')]
    for (const file of files) await writeFile(file, 'content')
    const today = new Date(2026, 9, 13, 22)
    await utimes(files[0], new Date(2026, 9, 13, 8), new Date(2026, 9, 13, 8))
    await utimes(files[1], today, today)
    await utimes(files[2], new Date(2026, 9, 12, 23), new Date(2026, 9, 12, 23))
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    await permissions.grantFolder(downloads)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }, { name: 'Downloads', path: downloads }], async (folder) => folder === desktop ? [files[2], files[0]] : [files[3], files[1]], () => new Date(2026, 9, 13, 23))
    const done = await search.start('todays screenshot')
    assert.deepEqual(done.matches, [files[1], files[0]])
    assert.deepEqual(done.errors, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('dated screenshot search uses filename date even when copied later and does not crawl an indexed folder with no matches', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop')
    await mkdir(desktop)
    const wanted = join(desktop, 'Screenshot 2026-10-12 at 8.00 AM.png')
    const other = join(desktop, 'Screenshot 2026-10-13 at 8.00 AM.png')
    await writeFile(wanted, 'image')
    await writeFile(other, 'image')
    await utimes(wanted, new Date(2026, 9, 13, 8), new Date(2026, 9, 13, 8))
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }], async () => [wanted, other], () => new Date(2026, 9, 13, 12))
    const day = await search.start('screenshots on 2026-10-12')
    assert.deepEqual(day.matches, [wanted])
    assert.deepEqual(day.errors, [])
    const empty = await search.start('screenshots on 2026-10-11')
    assert.deepEqual(empty.matches, [])
    assert.deepEqual(empty.errors, [])
    assert.deepEqual(empty.checked, ['Desktop: searched'])
    assert.throws(() => parseScreenshotDate('screenshots on 2026-02-30', new Date()), /Invalid screenshot date/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('screenshot time ranges use filename capture time and reject invalid windows', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-search-'))
  try {
    const desktop = join(root, 'Desktop')
    await mkdir(desktop)
    const morning = join(desktop, 'Screenshot 2026-10-12 at 9.15.00 AM.png')
    const midday = join(desktop, 'Screenshot 2026-10-12 at 12.15.00 PM.png')
    const previous = join(desktop, 'Screenshot 2026-10-11 at 9.45.00 AM.png')
    for (const file of [morning, midday, previous]) await writeFile(file, 'image')
    const permissions = new PermissionManager(join(root, 'grants.json'))
    await permissions.load()
    await permissions.grantFolder(desktop)
    const search = new FileSearch(permissions, [{ name: 'Desktop', path: desktop }], async () => [previous, midday, morning])
    const result = await search.start('screenshots on 2026-10-12 between 09:00 and 11:00')
    assert.equal(result.date, '2026-10-12')
    assert.deepEqual(result.matches, [morning])
    assert.deepEqual(result.errors, [])
    await assert.rejects(() => search.start('screenshots on 2026-10-12 between 12:00 and 09:00'), /end time/)
    await assert.rejects(() => search.start('screenshots on 2026-10-12 between 25:00 and 26:00'), /Invalid screenshot time/)
  } finally { await rm(root, { recursive: true, force: true }) }
})