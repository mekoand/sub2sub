import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './files.mjs';

// WMI starts in the same user's session, outside the management host's job.
// A normal detached child is still reaped with Windows SSH and some GUI hosts.
export async function launchWindowsNode(entry, root, options) {
  const startupFile = path.join(root, `startup-${randomUUID()}.json`);
  await writeJson(startupFile, options);
  let pid;
  try {
    const command = [process.execPath, entry, '--startup-file', startupFile].map(arg => `"${arg}"`).join(' ');
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop'
$startup=([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow=0
$startup.EnvironmentVariables=@([Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
$result=([wmiclass]'Win32_Process').Create(${quote(command)},${quote(root)},$startup)
if($result.ReturnValue -ne 0){throw "Windows node startup failed (WMI code $($result.ReturnValue))"}
Write-Output $result.ProcessId`;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
    pid = Number(stdout.trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Windows did not return the sharing node process ID.');
    const until = performance.now() + 30000;
    for (;;) {
      const startup = await readJson(startupFile);
      if (startup.error) throw new Error(startup.error);
      if (startup.result?.status === 'sharing') return;
      if (performance.now() >= until) throw new Error(`Windows sharing startup timed out. Check ${path.join(root, 'node.log')}.`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) {
    if (pid) { try { process.kill(pid); } catch (stopError) { if (stopError.code !== 'ESRCH') throw new AggregateError([error, stopError], 'Windows sharing startup and shutdown failed.'); } }
    throw error;
  } finally { await fs.rm(startupFile, { force: true }); }
}
