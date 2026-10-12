"""Basic media controls using playerctl, macOS Music, or Windows media keys."""
import shutil
import subprocess
import sys


def register(args):
    playerctl = shutil.which('playerctl') if sys.platform.startswith('linux') else None
    osascript = shutil.which('osascript') if sys.platform == 'darwin' else None
    windows = sys.platform == 'win32'
    if not playerctl and not osascript and not windows:
        raise RuntimeError('The media scope requires playerctl on Linux, Music/osascript on macOS, or Windows media controls.')

    def control(arguments):
        action = arguments.get('action')
        if action not in ('play', 'pause', 'play_pause', 'info', 'volume', 'volume_up', 'volume_down'):
            raise ValueError('action must be play, pause, play_pause, info, volume, volume_up, or volume_down')
        volume = arguments.get('volume')
        if action == 'volume' and (not isinstance(volume, (int, float)) or isinstance(volume, bool) or not 0 <= volume <= 100):
            raise ValueError('volume must be a number from 0 to 100')
        if windows:
            if action in ('info', 'play', 'pause', 'play_pause'):
                powershell = shutil.which('powershell') or shutil.which('pwsh')
                if not powershell: raise RuntimeError('PowerShell is required for Windows media controls')
                script = "Add-Type -AssemblyName System.Runtime.WindowsRuntime; $null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]; $m=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync().GetAwaiter().GetResult(); $s=$m.GetCurrentSession(); if($null -eq $s){throw 'No active media session'}; if('" + action + "' -eq 'info'){$p=$s.TryGetMediaPropertiesAsync().GetAwaiter().GetResult(); $s.GetPlaybackInfo().PlaybackStatus.ToString() + ' | ' + $p.Artist + ' | ' + $p.Title} elseif('" + action + "' -eq 'play'){$s.TryPlayAsync().GetAwaiter().GetResult()} elseif('" + action + "' -eq 'pause'){$s.TryPauseAsync().GetAwaiter().GetResult()} elseif($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing'){$s.TryPauseAsync().GetAwaiter().GetResult()} else {$s.TryPlayAsync().GetAwaiter().GetResult()}"
                result = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=15, check=False)
                if result.returncode: raise RuntimeError(result.stderr.strip() or 'Unable to read Windows media session')
                return {'content': [{'type': 'text', 'text': result.stdout.strip() or f'{action} completed.'}]}
            if action == 'volume':
                # Set an absolute system volume with Windows Core Audio's endpoint API.
                powershell = shutil.which('powershell') or shutil.which('pwsh')
                if not powershell: raise RuntimeError('PowerShell is required to set volume on Windows')
                script = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; [ComImport,Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] class MMDeviceEnumerator{} [Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDeviceEnumerator{int EnumAudioEndpoints(int d,int s,out IntPtr p);int GetDefaultAudioEndpoint(int d,int r,out IMMDevice p);} [Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice{int Activate(ref Guid id,int ctx,IntPtr p,out IAudioEndpointVolume v);} [Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IAudioEndpointVolume{int RegisterControlChangeNotify(IntPtr p);int UnregisterControlChangeNotify(IntPtr p);int GetChannelCount(out uint p);int SetMasterVolumeLevel(float v,Guid c);int SetMasterVolumeLevelScalar(float v,Guid c);int GetMasterVolumeLevel(out float v);int GetMasterVolumeLevelScalar(out float v);}' -ErrorAction Stop; $e=New-Object MMDeviceEnumerator; $d=$null; [void]$e.GetDefaultAudioEndpoint(0,1,[ref]$d); $id=[Guid]'5CDF2C82-841E-4546-9722-0CF74078229A'; $v=$null; [void]$d.Activate([ref]$id,23,[IntPtr]::Zero,[ref]$v); [void]$v.SetMasterVolumeLevelScalar(" + str(volume / 100) + ",[Guid]::Empty)"
                result = subprocess.run([powershell, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=15, check=False)
                if result.returncode: raise RuntimeError(result.stderr.strip() or 'Unable to set Windows volume')
                return {'content': [{'type': 'text', 'text': f'Set system volume to {round(volume)}.'}]}
            import ctypes
            vk = {'volume_up': 0xAF, 'volume_down': 0xAE}[action]
            ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
            ctypes.windll.user32.keybd_event(vk, 0, 2, 0)
            return {'content': [{'type': 'text', 'text': f'{action} media key sent.'}]}
        if playerctl:
            if action == 'info': command = [playerctl, 'metadata', '--format', '{{playerName}} | {{status}} | {{artist}} | {{title}}']
            elif action == 'volume': command = [playerctl, 'volume', str(volume / 100)]
            elif action in ('volume_up', 'volume_down'): command = [playerctl, 'volume', '0.05+' if action == 'volume_up' else '0.05-']
            else: command = [playerctl, action.replace('_', '-')]
        else:
            scripts = {
                'play': 'tell application "Music" to play', 'pause': 'tell application "Music" to pause',
                'play_pause': 'tell application "Music" to playpause',
                'info': 'tell application "Music" to get (name of current track) & " — " & (artist of current track)',
                'volume': f'tell application "Music" to set sound volume to {round(volume)}',
                'volume_up': 'tell application "Music" to set v to (sound volume + 5); if v > 100 then set v to 100; set sound volume to v',
                'volume_down': 'tell application "Music" to set v to (sound volume - 5); if v < 0 then set v to 0; set sound volume to v',
            }
            command = [osascript, '-e', scripts[action]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
        if result.returncode: raise RuntimeError(result.stderr.strip() or 'Media command failed')
        return {'content': [{'type': 'text', 'text': result.stdout.strip() or f'{action} completed.'}]}

    tool = {'name': 'media_control', 'description': 'Control the current media player or read its current track. Volume uses a 0–100 scale.', 'inputSchema': {'type': 'object', 'properties': {'action': {'type': 'string', 'enum': ['play', 'pause', 'play_pause', 'info', 'volume', 'volume_up', 'volume_down']}, 'volume': {'type': 'number', 'minimum': 0, 'maximum': 100}}, 'required': ['action'], 'additionalProperties': False}, 'annotations': {'readOnlyHint': False}}
    return [tool], {'media_control': control}
