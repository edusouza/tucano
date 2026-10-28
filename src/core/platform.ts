// What differs between macOS and Windows for the core: how a CLI is found and
// spawned, which shell runs an agent's commands, and how a process tree stops.
// Everything else in the core is written once, for both.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

export const isWin = process.platform === 'win32'

// The executable names a command may have on this system: on Windows, its PATHEXT
// variants (claude.exe, codex.cmd…). The bare name there is a shell script for Git
// Bash, which Windows can't run, so it is never a match. PATHEXT may also list
// .JS, .VBS or .PY, which open in a script host instead of running: those are skipped.
export function executableNames(cmd: string): string[] {
  if (!isWin) return [cmd]
  const exts = (process.env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => /^\.(com|exe|bat|cmd)$/i.test(e))
  return exts.map((e) => cmd + e.toLowerCase())
}

export const pathDirs = (): string[] => (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter).filter(Boolean)

// cmd.exe's special characters, escaped with ^ (the approach of cross-spawn).
const META = /([()\][%!^"`<>&|;, *?])/g

function cmdArg(arg: string, twice: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`.replace(META, '^$1')
  return twice ? a.replace(META, '^$1') : a
}

// The program on PATH with this name, as cmd.exe would find it.
function onPath(cmd: string): string | undefined {
  for (const dir of pathDirs()) for (const name of executableNames(cmd)) if (existsSync(join(dir, name))) return join(dir, name)
  return undefined
}

// What an npm shim runs. npm (and pnpm, yarn) write a .cmd that ends in
// `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`: node with the package's script,
// or the package's own .exe. Run that directly, and cmd.exe never sees the arguments.
function shimTarget(shim: string): { file: string; args: string[] } | undefined {
  let text: string
  try {
    text = readFileSync(shim, 'utf8')
  } catch {
    return undefined
  }
  const target = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"\s+%\*/g)].at(-1)?.[1]
  if (!target) return undefined
  const dir = dirname(shim)
  const file = join(dir, target)
  if (!existsSync(file)) return undefined
  if (/\.(exe|com)$/i.test(file)) return { file, args: [] }
  // The interpreter the shim would use: its own node.exe, else the one its shebang named (node, bun…) on PATH.
  const named = /SET "_prog=([\w.-]+)"/i.exec(text)?.[1] ?? 'node'
  const prog = existsSync(join(dir, 'node.exe')) ? join(dir, 'node.exe') : onPath(named.replace(/\.exe$/i, ''))
  return prog ? { file: prog, args: [file] } : undefined
}

// How to spawn `bin args`. Node won't spawn a .cmd or .bat directly on Windows
// (npm installs codex, opencode and pi that way). An npm shim runs its target
// directly. Any other script goes through cmd.exe, with each argument escaped
// for it (the script parses them a second time, hence the double escaping);
// cmd.exe ends a command at a line break, which would drop every argument after
// it (an engine's isolation flags), so a multi-line argument is refused there.
export function spawnable(bin: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (!isWin || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, args, verbatim: false }
  const direct = shimTarget(bin)
  if (direct) return { file: direct.file, args: [...direct.args, ...args], verbatim: false }
  if (args.some((a) => /[\r\n]/.test(a))) throw new Error(`${bin} is a script that cmd.exe would run, and cmd.exe can't take an argument with line breaks`)
  const line = [bin.replace(META, '^$1'), ...args.map((a) => cmdArg(a, true))].join(' ')
  return { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

// Stops a process and its children. POSIX: the process group (spawned detached).
// Windows has no groups and no signals: taskkill takes the whole tree.
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (isWin) {
    void killWindowsTree(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    /* already gone */
  }
}

// Git Bash emulates fork: a job sent to the background (`server &`) gets a Windows
// parent that is gone at once, so taskkill /t never finds it, and it would keep
// the output pipe open forever. Git's own ps still knows it by the shell's process
// group, with its Windows pid: those go too.
async function killWindowsTree(pid: number): Promise<void> {
  const pids = new Set([pid])
  const root = gitRoot()
  if (root) {
    const out = await new Promise<string>((resolve) => execFile(join(root, 'usr', 'bin', 'ps.exe'), [], { windowsHide: true, timeout: 5000 }, (_e, so) => resolve(String(so ?? ''))))
    // PID PPID PGID WINPID …, sometimes after a status letter.
    const rows = out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/).filter((c, i) => i > 0 || /^\d+$/.test(c)).map(Number))
    const group = rows.find((r) => r[3] === pid)?.[2]
    if (group) for (const r of rows) if (r[2] === group && r[3]) pids.add(r[3])
  }
  await new Promise<void>((resolve) => {
    const k = spawn('taskkill', [...[...pids].flatMap((p) => ['/pid', String(p)]), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    k.on('error', () => resolve())
    k.on('exit', () => resolve())
  })
}

// Git for Windows, whose bash agents' commands run in (the same one Claude Code
// uses there). WSL's bash in System32 is a different machine, with other paths.
let gitDir: string | null | undefined
export function gitRoot(): string | undefined {
  if (gitDir !== undefined) return gitDir ?? undefined
  const launcher = [
    process.env['CLAUDE_CODE_GIT_BASH_PATH'],
    ...pathDirs().flatMap((d) => (/\\git\\(cmd|bin|mingw64\\bin|ucrt64\\bin|usr\\bin)$/i.test(d) ? [join(dirname(d), 'bin', 'bash.exe'), join(dirname(dirname(d)), 'bin', 'bash.exe')] : [])),
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env['LOCALAPPDATA'] || '', 'Programs', 'Git', 'bin', 'bash.exe')
  ].find((c): c is string => !!c && existsSync(c))
  // <root>\bin\bash.exe is a launcher; the shell itself is <root>\usr\bin\bash.exe.
  const root = launcher ? dirname(dirname(launcher)) : undefined
  gitDir = root && existsSync(join(root, 'usr', 'bin', 'bash.exe')) ? root : null
  return gitDir ?? undefined
}

// The environment with dirs put first on PATH, whatever its spelling (Windows: Path).
function withPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [key]: [...dirs, env[key]].filter(Boolean).join(delimiter) }
}

// How to run one command line in the user's shell: bash on the Mac; on Windows,
// Git's bash, or cmd.exe when Git isn't installed. Git's bash runs without its
// launcher, so a stop knows the shell's own pid; the env is what the launcher
// would set (the MSYS system and its tools first on PATH).
export function shellCommand(command: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; verbatim: boolean; kind: 'bash' | 'cmd'; env: NodeJS.ProcessEnv } {
  if (!isWin) return { file: '/bin/bash', args: ['-c', command], verbatim: false, kind: 'bash', env }
  const root = gitRoot()
  if (root) {
    const system = existsSync(join(root, 'ucrt64', 'bin')) ? 'ucrt64' : 'mingw64'
    const shellEnv = withPath({ ...env, MSYSTEM: env['MSYSTEM'] || system.toUpperCase() }, [join(root, system, 'bin'), join(root, 'usr', 'bin')])
    return { file: join(root, 'usr', 'bin', 'bash.exe'), args: ['-c', command], verbatim: false, kind: 'bash', env: shellEnv }
  }
  return { file: process.env['ComSpec'] || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true, kind: 'cmd', env }
}

// Google Chrome, where it is installed on this system.
export function chromePath(): string {
  if (!isWin) return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const tail = join('Google', 'Chrome', 'Application', 'chrome.exe')
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter((r): r is string => !!r)
  return roots.map((r) => join(r, tail)).find(existsSync) ?? join(roots[0] ?? 'C:\\Program Files', tail)
}
