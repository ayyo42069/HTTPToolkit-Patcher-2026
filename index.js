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
  .demandCommand(1, 'You need at least one command before moving on')
  .alias('h', 'help')
  .parse()

const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

// Try to find where HTTP Toolkit is installed
const appPath =
  isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'HTTP Toolkit', 'resources')
    : isMac ? '/Applications/HTTP Toolkit.app/Contents/Resources'
      : fs.existsSync('/opt/HTTP Toolkit/resources') ? '/opt/HTTP Toolkit/resources'
        : '/opt/httptoolkit/resources'

const exePath =
  isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'HTTP Toolkit', 'HTTP Toolkit.exe')
    : isMac ? '/Applications/HTTP Toolkit.app/Contents/MacOS/HTTP Toolkit'
      : fs.existsSync('/opt/HTTP Toolkit/httptoolkit') ? '/opt/HTTP Toolkit/httptoolkit'
        : '/opt/httptoolkit/httptoolkit'

const isSudo = !isWin && (process.getuid || (() => process.env.SUDO_UID ? 0 : null))() === 0

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
      console.log(chalk.yellowBright`Process {bold ${proc.pid ? process.pid + ' ' : ''}}stopped`)
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
    const proc = spawn('npm install express https-proxy-agent', { cwd: tempPath, stdio: 'inherit', shell: true })
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
  fs.copyFileSync(filePath, `${filePath}.bak`)
  console.log(chalk.greenBright`Created backup at {bold ${filePath}.bak}`)

  console.log(chalk.yellowBright`Repacking the app...`)
  await asar.createPackage(tempPath, filePath)
  rm(tempPath)
  console.log(chalk.greenBright`App patched!`)

  // Disable ASAR integrity checks so Electron doesn't complain
  await flipElectronFuses()
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
