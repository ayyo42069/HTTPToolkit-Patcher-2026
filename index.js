// @ts-check
import { spawn } from 'child_process'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'
import asar from '@electron/asar'
import prompts from 'prompts'
import yargs from 'yargs'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs'
import os from 'os'

const argv = await yargs(process.argv.slice(2))
  .usage(`Usage: ${process.argv0} . <command> [options]`)
  .command('patch', 'Patch HTTP Toolkit using the specified script')
  .command('restore', 'Restore HTTP Toolkit files to their original state')
  .command('start', 'Start HTTP Toolkit')
  .option('path', {
    type: 'string',
    describe: 'Path to the HTTP Toolkit installation (the install dir or its resources folder)'
  })
  .demandCommand(1, 'You need at least one command before moving on')
  .alias('h', 'help')
  .parse()

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

const userAgent = process.env.npm_config_user_agent
const pm = userAgent ? userAgent.split('/')[0] : 'npm'
const installCmd = pm === 'npm' ? 'install' : 'add'

// Try to find where HTTP Toolkit is installed
const getAppPath = () => {
  if (argv.path) {
    return /resources$/i.test(argv.path) ? argv.path : path.join(argv.path, isMac ? 'Contents/Resources' : 'resources')
  }
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const candidates = isWin
    ? [
      path.join(localAppData, 'Programs', 'HTTP Toolkit', 'resources'), // current default
      path.join(localAppData, 'Programs', 'httptoolkit', 'HTTP Toolkit', 'resources'),
      path.join(localAppData, 'Programs', 'httptoolkit', 'resources'), // older default
      path.join(process.env.PROGRAMFILES ?? '', 'HTTP Toolkit', 'resources'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'HTTP Toolkit', 'resources')
    ]
    : isMac
      ? ['/Applications/HTTP Toolkit.app/Contents/Resources']
      : [
        '/opt/HTTP Toolkit/resources',
        '/opt/httptoolkit/resources',
        '/usr/lib/httptoolkit',
        '/usr/share/httptoolkit/resources'
      ]
  for (const p of candidates) {
    if (p && fs.existsSync(path.join(p, 'app.asar'))) return p
  }
  return candidates[0]
}

const appPath = getAppPath()

const exePath =
  isWin ? path.join(path.dirname(appPath), 'HTTP Toolkit.exe')
    : isMac ? path.join(path.dirname(appPath), 'MacOS', 'HTTP Toolkit')
      : path.join(path.dirname(appPath), 'httptoolkit')

const isSudo = !isWin && (process.getuid || (() => process.env.SUDO_UID ? 0 : null))() === 0

// The bundled node server that backs MCP / remote control. It lives next to the
// asar (not inside it), so we patch it directly on disk.
const serverBundlePath = path.join(appPath, 'httptoolkit-server', 'bundle', 'index.js')
const patcherPort = process.env.PATCHER_PORT || 5067

if (+(process.versions.node.split('.')[0]) < 15) {
  console.error(chalk.redBright`Node.js version 15 or higher is recommended, you are using version {bold ${process.versions.node}}`)
}

if (!fs.existsSync(path.join(appPath, 'app.asar'))) {
  console.error(chalk.redBright`Couldn't find HTTP Toolkit! Make sure it's installed.`)
  process.exit(1)
}

console.log(chalk.blueBright`Found HTTP Toolkit at {bold ${path.dirname(appPath)}}`)

// Helper to recursively delete directories
const rm = dirPath => {
  if (!fs.existsSync(dirPath)) return
  if (!fs.lstatSync(dirPath).isDirectory()) return fs.rmSync(dirPath, { force: true })
  for (const entry of fs.readdirSync(dirPath)) {
    const entryPath = path.join(dirPath, entry)
    if (fs.lstatSync(entryPath).isDirectory()) rm(entryPath)
    else fs.rmSync(entryPath, { force: true })
  }
}

/** @type {Array<import('child_process').ChildProcess>} */
const activeProcesses = []
let isCancelled = false

const cleanUp = async () => {
  isCancelled = true
  console.log(chalk.redBright`Cancelled! Cleaning up...`)
  if (activeProcesses.length) {
    console.log(chalk.yellowBright`Stopping active processes...`)
    for (const proc of activeProcesses) {
      proc.kill('SIGINT')
      console.log(chalk.yellowBright`Process {bold ${proc.pid ? proc.pid + ' ' : ''}}stopped`)
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const paths = [
    path.resolve(os.tmpdir(), 'httptoolkit-patch'),
    path.resolve(appPath, 'app')
  ]
  try {
    for (const p of paths) {
      if (fs.existsSync(p)) {
        console.log(chalk.yellowBright`Removing {bold ${p}}`)
        rm(p)
      }
    }
  } catch (e) {
    console.error(chalk.redBright`Error while cleaning up`, e)
  }
  process.exit(1)
}

const patchApp = async () => {
  const filePath = path.join(appPath, 'app.asar')
  const tempPath = path.join(appPath, 'app')

  if (fs.readFileSync(filePath).includes('Injected by HTTP Toolkit Patcher')) {
    console.log(chalk.greenBright`App is already patched!`)
    return
  }

  const globalProxy = process.env.PROXY

  console.log(chalk.blueBright`Starting the patch process...`)

  if (globalProxy) {
    if (!globalProxy.match(/^https?:/)) {
      console.error(chalk.redBright`Global proxy must start with http:// or https://`)
      process.exit(1)
    }
    console.log(chalk.yellowBright`Using custom proxy: {bold ${globalProxy}}`)
  }

  console.log(chalk.yellowBright`Extracting app files...`)

    ;['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, cleanUp))

  try {
    rm(tempPath)
    asar.extractAll(filePath, tempPath)
  } catch (e) {
    if (!isSudo && /** @type {any} */ (e).errno === -13) { // Permission denied
      console.error(chalk.redBright`Permission denied${!isWin ? ', try running with sudo' : ', try running node as administrator'}`)
      process.exit(1)
    }
    console.error(chalk.redBright`Error extracting app`, e)
    process.exit(1)
  }

  // Replace @prisma/instrumentation with a stub - it has a broken nested node_modules
  // reference to @opentelemetry/instrumentation that causes a crash after repacking.
  // @sentry/node's prisma integration imports from it, so we can't just delete it —
  // we need a stub that exports the expected symbols as noops.
  const prismaInstrPath = path.join(tempPath, 'node_modules', '@prisma', 'instrumentation')
  if (fs.existsSync(prismaInstrPath)) {
    rm(prismaInstrPath)
    fs.mkdirSync(prismaInstrPath, { recursive: true })
    fs.writeFileSync(path.join(prismaInstrPath, 'package.json'), JSON.stringify({
      name: '@prisma/instrumentation',
      version: '0.0.0-stub',
      main: 'index.js',
      type: 'module'
    }, null, 2))
    fs.writeFileSync(path.join(prismaInstrPath, 'index.js'),
      [
        'export class PrismaInstrumentation {',
        '  constructor(config) { this._config = config; }',
        '  instrumentationName = "@prisma/instrumentation";',
        '  instrumentationVersion = "0.0.0";',
        '  enable() {}',
        '  disable() {}',
        '  setTracerProvider() {}',
        '  setMeterProvider() {}',
        '  getConfig() { return this._config || {}; }',
        '}',
        'export default PrismaInstrumentation;',
        ''
      ].join('\n')
    )
    console.log(chalk.yellowBright`Replaced broken @prisma/instrumentation with stub`)
  }

  const indexPath = path.join(tempPath, 'build', 'index.js')
  if (!fs.existsSync(indexPath)) {
    console.error(chalk.redBright`Couldn't find index.js file`)
    cleanUp()
  }
  const data = fs.readFileSync(indexPath, 'utf-8')
    ;['SIGINT', 'SIGTERM'].forEach(signal => process.off(signal, cleanUp))

  const { email } = await prompts({
    type: 'text',
    name: 'email',
    message: 'Enter an email for the pro plan',
    validate: value => value.includes('@') || 'Invalid email'
  })

  if (!email || typeof email !== 'string') {
    console.error(chalk.redBright`No email provided`)
    cleanUp()
  }

  ;['SIGINT', 'SIGTERM'].forEach(signal => process.on(signal, cleanUp))
  const patchContent = fs.readFileSync('patch.js', 'utf-8')

  // Separate imports from the rest of the patch code
  const patchImportsMatch = patchContent.match(/\/\/ --- Patcher Imports[\s\S]*?\/\/ --- End Patcher Imports ---\n?/)
  const patchImports = patchImportsMatch ? patchImportsMatch[0] : ''
  const patchCode = patchContent.replace(patchImports, '')

  // Find where to put our imports (right after the last existing import)
  const lastImportMatch = data.match(/^import .+$/gm)
  const lastImport = lastImportMatch ? lastImportMatch[lastImportMatch.length - 1] : null

  let patchedData = data

  // Inject imports at the top
  if (patchImports && lastImport) {
    patchedData = patchedData.replace(lastImport, `${lastImport}\n// ------- Patcher Imports -------\n${patchImports.trim()}\n// ------- End Patcher Imports -------`)
  }

  // Inject the main patch code where APP_URL is defined
  patchedData = patchedData
    .replace('const APP_URL =', `// ------- Injected by HTTP Toolkit Patcher -------\nconst email = \`${email.replace(/`/g, '\\`')}\`\nconst globalProxy = process.env.PROXY ?? \`${globalProxy ? globalProxy.replace(/`/g, '\\`') : ''}\`\n${patchCode}\n// ------- End patched content -------\nconst APP_URL =`)

  if (data === patchedData || !patchedData) {
    console.error(chalk.redBright`Patch failed - couldn't find injection point`)
    cleanUp()
  }

  fs.writeFileSync(indexPath, patchedData, 'utf-8')
  console.log(chalk.greenBright`Patched index.js successfully`)
  console.log(chalk.yellowBright`Installing dependencies...`)

  try {
    const proc = spawn(`${pm} ${installCmd} express https-proxy-agent`, { cwd: tempPath, stdio: 'inherit', shell: true })
    activeProcesses.push(proc)
    await new Promise(resolve =>
      proc.on('close', resolve)
    )
    activeProcesses.splice(activeProcesses.indexOf(proc), 1)
    if (isCancelled) return
  } catch (e) {
    console.error(chalk.redBright`Error installing dependencies`, e)
    cleanUp()
  }

  rm(path.join(tempPath, 'package-lock.json'))
  rm(path.join(tempPath, 'yarn.lock'))
  rm(path.join(tempPath, 'pnpm-lock.yaml'))
  rm(path.join(tempPath, 'bun.lockb'))
  fs.copyFileSync(filePath, `${filePath}.bak`)
  console.log(chalk.greenBright`Created backup at {bold ${filePath}.bak}`)

  console.log(chalk.yellowBright`Repacking the app...`)
  await asar.createPackage(tempPath, filePath)
  rm(tempPath)
  console.log(chalk.greenBright`App patched!`)

  // Patch the node server so the MCP / remote-control bridge works with our UI
  patchServerBundle()

  // Drop any cached UI so main.js is re-fetched and re-patched (picks up the
  // MCP userJwt fix in patch.js on next launch).
  rm(path.join(os.tmpdir(), 'httptoolkit-patch'))

  // Disable ASAR integrity checks so Electron doesn't complain
  await flipElectronFuses()
}

// Patch the bundled node server so the MCP / remote-control bridge accepts our
// patched UI. Three edits, all in httptoolkit-server/bundle/index.js:
//   1. Add our proxy origin to the server's ALLOWED_ORIGINS allow-list, so the
//      UI's /ui-operations WebSocket (served from localhost) isn't rejected. NOTE:
//      this widens a deliberate security control (it normally only trusts
//      app.httptoolkit.tech, to stop other local apps/sites driving your proxy).
//   2. Make the bridge's WebSocket auth succeed for any JWT — we hand the UI a
//      dummy token (see patch.js) since the faked Pro user has no real account JWT.
//   3. Force the bridge's isPaidUser() true so Pro-only MCP operations are allowed.
// These strings are minified and version-specific: if HTTP Toolkit updates and a
// pattern no longer matches, we warn and skip rather than fail the whole patch —
// the Pro unlock still works, only MCP remote control is affected.
const patchServerBundle = () => {
  if (!fs.existsSync(serverBundlePath)) {
    console.log(chalk.yellowBright`Server bundle not found at ${serverBundlePath}, skipping MCP bridge patch`)
    return
  }

  const edits = [
    {
      name: 'allow proxy origin',
      from: 'ei?[/^https:\\/\\/app\\.httptoolkit\\.tech$/]:',
      to: `ei?[/^https:\\/\\/app\\.httptoolkit\\.tech$/,/^http:\\/\\/localhost:${patcherPort}$/]:`
    },
    {
      name: 'accept bridge auth',
      from: 'if(!1===A.jwt){e.user=void 0,r&&this.completeInitialAuth(e)',
      to: 'if(!0){e.user=void 0,r&&this.completeInitialAuth(e)'
    },
    {
      name: 'force bridge isPaidUser',
      from: 'key:"isPaidUser",value:function(){',
      to: 'key:"isPaidUser",value:function(){return!0;'
    }
  ]

  let data = fs.readFileSync(serverBundlePath, 'utf-8')

  if (edits.every(e => data.includes(e.to))) {
    console.log(chalk.greenBright`Server bundle already patched for MCP`)
    return
  }

  // Keep an original copy so `restore` can put it back.
  const bundleBak = `${serverBundlePath}.bak`
  if (!fs.existsSync(bundleBak)) fs.copyFileSync(serverBundlePath, bundleBak)

  let applied = 0
  for (const edit of edits) {
    if (data.includes(edit.to)) { applied++; continue }
    const count = data.split(edit.from).length - 1
    if (count !== 1) {
      console.error(chalk.yellowBright`Couldn't apply MCP patch '${edit.name}' (pattern changed?) - skipping`)
      continue
    }
    data = data.replace(edit.from, edit.to)
    applied++
  }

  if (applied === 0) {
    console.error(chalk.yellowBright`No MCP bridge patches applied - remote control may be unavailable`)
    return
  }

  fs.writeFileSync(serverBundlePath, data, 'utf-8')
  console.log(chalk.greenBright`Patched server bundle for MCP (${applied}/${edits.length} edits)`)
}

const restoreServerBundle = () => {
  const bundleBak = `${serverBundlePath}.bak`
  if (fs.existsSync(bundleBak)) {
    fs.copyFileSync(bundleBak, serverBundlePath)
    fs.rmSync(bundleBak, { force: true })
    console.log(chalk.greenBright`Restored original server bundle`)
  }
}

const flipElectronFuses = async () => {
  console.log(chalk.yellowBright`Disabling ASAR integrity checks...`)

  if (!fs.existsSync(exePath)) {
    console.log(chalk.yellowBright`Executable not found at ${exePath}, skipping fuse flipping`)
    return
  }

  try {
    await flipFuses(exePath, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    })
    console.log(chalk.greenBright`Integrity checks disabled successfully`)
  } catch (e) {
    console.error(chalk.yellowBright`Failed to flip fuses (might already be done or not supported): ${/** @type {Error} */ (e).message}`)
  }
}

switch (argv._[0]) {
  case 'patch':
    await patchApp()
    break
  case 'restore':
    try {
      console.log(chalk.blueBright`Restoring app...`)
      if (!fs.existsSync(path.join(appPath, 'app.asar.bak')))
        console.error(chalk.redBright`Backup file not found - maybe the app wasn't patched?`)
      else {
        fs.copyFileSync(path.join(appPath, 'app.asar.bak'), path.join(appPath, 'app.asar'))
        console.log(chalk.greenBright`App restored successfully`)
      }
      restoreServerBundle()
      rm(path.join(os.tmpdir(), 'httptoolkit-patch'))
    } catch (e) {
      if (!isSudo && /** @type {any} */ (e).errno === -13) { // Permission denied
        console.error(chalk.redBright`Permission denied${!isWin ? ', try running with sudo' : ', try running node as administrator'}`)
        process.exit(1)
      }
      console.error(chalk.redBright`Error restoring app`, e)
      process.exit(1)
    }
    break
  case 'start':
    console.log(chalk.blueBright`Starting HTTP Toolkit...`)
    try {
      const command =
        isWin ? `"${path.resolve(appPath, '..', 'HTTP Toolkit.exe')}"`
          : isMac ? 'open -a "HTTP Toolkit"'
            : 'httptoolkit'
      const proc = spawn(command, { stdio: 'inherit', shell: true })
      proc.on('close', code => process.exit(code))
    } catch (e) {
      console.error(chalk.redBright`Error starting app`, e)
      if (isSudo) console.error(chalk.redBright`Try running without sudo`)
      process.exit(1)
    }
    break
  default:
    console.error(chalk.redBright`Unknown command`)
    process.exit(1)
}

if (!isCancelled) console.log(chalk.greenBright`All done!`)
