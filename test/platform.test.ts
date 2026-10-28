import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

  // npm installs codex, opencode and pi as .cmd shims: each argument has to reach the program intact
  // through cmd.exe, including Codex's -c TOML values with quotes, & and %.
  it.runIf(win)('passes arguments through an npm .cmd shim unchanged', () => {
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
