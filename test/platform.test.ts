import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableNames, gitRoot, shellCommand, spawnable } from '../src/core/platform'

const win = process.platform === 'win32'

describe('spawning a CLI', () => {
  it('runs an executable as it is', () => {
    expect(spawnable('/usr/local/bin/claude', ['-p', 'a b'])).toEqual({ file: '/usr/local/bin/claude', args: ['-p', 'a b'], verbatim: false })
  })

  it.runIf(win)('looks for the Windows names of a command, never the bare shell script', () => {
    expect(executableNames('codex')).toContain('codex.cmd')
    expect(executableNames('codex')).toContain('codex.exe')
    expect(executableNames('codex')).not.toContain('codex')
    const before = process.env['PATHEXT']
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.PY'
    expect(executableNames('codex')).toEqual(['codex.com', 'codex.exe', 'codex.bat', 'codex.cmd'])
    process.env['PATHEXT'] = before
  })

  // A .cmd that isn't an npm shim still goes through cmd.exe: each argument has to reach the
  // program intact, including Codex's -c TOML values with quotes, & and %.
  it.runIf(win)('passes arguments through any other .cmd script unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    const echo = join(dir, 'echo-args.js')
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const shim = join(dir, 'fake cli.cmd')
    writeFileSync(shim, `@"${process.execPath}" "${echo}" %*\r\n`)
    const args = ['exec', '--json', '-c', 'mcp_servers.tucano.url="http://127.0.0.1:5000/mcp/a?b=1&c=2"', 'two words', '100%', '%PATH%', 'a^b', '(x)|<y>', 'back\\slash\\', 'say "hi"', '']
    const s = spawnable(shim, args)
    expect(s.verbatim).toBe(true)
    const out = spawnSync(s.file, s.args, { windowsVerbatimArguments: true, encoding: 'utf8' }).stdout
    expect(JSON.parse(out)).toEqual(args)
  })

  // Claude and Pi get the system prompt as an argument, many lines long, before
  // the flags that keep them isolated: cmd.exe ends a command at a line break,
  // so an npm shim runs its script directly, as npm writes it.
  const npmShim = (target: string): string =>
    [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ''
    ].join('\r\n')
  const lines = ['--system-prompt', 'line one\nline two\r\n& echo pwned %PATH%', '--no-builtin-tools', '--offline']

  it.runIf(win)('runs an npm shim directly, so a multi-line argument and every flag after it arrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    mkdirSync(join(dir, 'node_modules', 'fake-cli'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'fake-cli', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    writeFileSync(join(dir, 'fake.cmd'), npmShim('node_modules\\fake-cli\\cli.js'))
    const s = spawnable(join(dir, 'fake.cmd'), lines)
    expect(s.verbatim).toBe(false)
    expect(s.args[0]).toBe(join(dir, 'node_modules', 'fake-cli', 'cli.js'))
    const out = spawnSync(s.file, s.args, { encoding: 'utf8', timeout: 10_000 }).stdout
    expect(JSON.parse(out)).toEqual(lines)
  })

  it.runIf(win)("runs a package's own .exe straight from its shim", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    mkdirSync(join(dir, 'node_modules', 'fake-cli', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'fake-cli', 'bin', 'fake.exe'), '')
    writeFileSync(join(dir, 'fake.cmd'), `@ECHO off\r\n"%~dp0\\node_modules\\fake-cli\\bin\\fake.exe"   %*\r\n`)
    expect(spawnable(join(dir, 'fake.cmd'), ['-p'])).toEqual({ file: join(dir, 'node_modules', 'fake-cli', 'bin', 'fake.exe'), args: ['-p'], verbatim: false })
  })

  it.runIf(win)('refuses a multi-line argument for any other script, instead of losing the flags after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano shim '))
    writeFileSync(join(dir, 'own.cmd'), `@"${process.execPath}" -e "" %*\r\n`)
    expect(() => spawnable(join(dir, 'own.cmd'), lines)).toThrow(/line breaks/)
  })
})

describe('the shell for an agent on this computer', () => {
  it.skipIf(win)('is bash on the Mac', () => {
    expect(shellCommand('ls')).toMatchObject({ file: '/bin/bash', args: ['-c', 'ls'], kind: 'bash' })
  })

  it.runIf(win && !!gitRoot())("is Git's own bash on Windows, set up as its launcher would", () => {
    const sh = shellCommand('echo "$MSYSTEM"', { PATH: 'C:\\Windows', SystemRoot: process.env['SystemRoot'] })
    expect(sh.file.toLowerCase()).toMatch(/\\usr\\bin\\bash\.exe$/)
    expect(sh.env['PATH']!.split(';').slice(-1)[0]).toBe('C:\\Windows')
    expect(execFileSync(sh.file, sh.args, { env: sh.env, encoding: 'utf8' }).trim()).toMatch(/^(UCRT64|MINGW64)$/)
  })
})
