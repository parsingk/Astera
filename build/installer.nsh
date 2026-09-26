; Custom NSIS hooks. electron-builder picks this file up as `nsis.include` by default.
;
; ---------------------------------------------------------------------------------------------
; customCheckAppRunning — close Astera, and keep it closed long enough to install over it.
;
; Replaces electron-builder's own check (see allowOnlyOneInstallerInstance.nsh: defining this macro
; takes the place of _CHECK_APP_RUNNING). Its version gives up too early for this app.
;
; Astera runs a Host process that outlives the app, so that sessions survive closing and reopening
; it. Up to and including 1.3.19 the Host was the app's own executable run as node — same file, same
; directory — so it pinned `Astera.exe`, and no installer can write over a running image. It had to go
; before we copy.
;
; From 1.3.20 the Host runs from its own Node under %LOCALAPPDATA% and pins nothing here, so this
; macro finds nothing and returns on its first pass. **It stays anyway**, for the people this ships
; for: everyone updating *from* a version whose Host is still inside $INSTDIR. It also remains the net
; under the app's own retire, which that fallback path still performs.
;
; That much the stock check already does: it kills everything whose path is under $INSTDIR, Host
; included. What defeats it is that **the app puts the Host back**. Lose the connection and the app
; starts a new Host a second later, by design — so a kill that lands while the app is still dying is
; undone before the check looks again. The stock check looks twice, about a second apart, and then
; tells the person the app cannot be closed. That is the failure this macro exists to end.
;
; So: kill, wait longer than the app's own retry, and look again — several times. The app dies on the
; first pass and cannot start anything after that, so this converges immediately in practice; the
; rounds are there for the case where it does not.
!macro customCheckAppRunning
  DetailPrint "Closing ${PRODUCT_NAME}…"

  ; One PowerShell for the whole loop rather than one per round: the rounds are ~1s apart and
  ; starting a shell each time would cost more than the wait it is measuring.
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$d = '$INSTDIR'; for ($$i = 0; $$i -lt 10; $$i++) { $$p = @(Get-CimInstance Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith($$d, 'CurrentCultureIgnoreCase') }); if ($$p.Count -eq 0) { exit 0 }; $$p | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 1200 }; if (@(Get-CimInstance Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith($$d, 'CurrentCultureIgnoreCase') }).Count -eq 0) { exit 0 } else { exit 1 }"`
  Pop $R0

  ; A missing or blocked PowerShell lands here too, with a non-zero code. taskkill by image name is
  ; the fallback: coarser — it cannot tell this install from another copy of Astera — but it is only
  ; reached where the precise path could not run at all.
  ${if} $R0 != 0
    nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
    Sleep 1500
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ; findstr says 0 when it FOUND a line, so a match here means something is still running.
    ${if} $R0 == 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK
      Quit
    ${endIf}
  ${endIf}
!macroend

; ---------------------------------------------------------------------------------------------
; customUnInstall — take away the public `astera` shuttle that Settings installed (docs/cli.md).
;
; The Install button writes `astera.cmd` and `astera` into %LOCALAPPDATA%\astera\bin. Uninstalling
; the app leaves them pointing at an Astera.exe that is gone, so they go with it.
;
; **Only those two files, and only when Astera wrote them.** %LOCALAPPDATA%\astera is a shared folder
; (the Host's runtime and other state live there), so nothing here deletes a folder, and a file of the
; same name whose content is not the shuttle's exact shape is someone else's and stays. The shapes are
; the ones isShuttleContent (src/core/orchestration/exec/shuttle.ts) recognises; `\x22` is a double
; quote, written that way so the command line needs no escaping. -cmatch, because -match ignores case.
;
; **Not during an update.** electron-builder runs the old version's uninstaller before installing the
; new one; removing the shuttle then would take the command away from everyone who updates. The new
; app rewrites it to point at itself when it starts.
;
; %LOCALAPPDATA% is read from the environment rather than NSIS's $LOCALAPPDATA, which follows the
; shell var context and names another folder in an all-users uninstall.
;
; Tested by src/core/orchestration/exec/shuttle.nsis.test.ts, which runs this exact command.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "$$d = Join-Path $$env:LOCALAPPDATA 'astera\bin'; $$w = @{ 'astera.cmd' = '^@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n\x22[^\x22\r\n]*\x22 \x22[^\x22\r\n]*\x22 %\*\r\n\z'; 'astera' = '^#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec \x22[^\x22\n]*\x22 \x22[^\x22\n]*\x22 \x22\$$@\x22\n\z' }; foreach ($$n in $$w.Keys) { $$f = Join-Path $$d $$n; if ((Test-Path -LiteralPath $$f -PathType Leaf) -and ([IO.File]::ReadAllText($$f) -cmatch $$w[$$n])) { Remove-Item -LiteralPath $$f -Force -ErrorAction SilentlyContinue } }"`
    Pop $R0
  ${endIf}
!macroend
