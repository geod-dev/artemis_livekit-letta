"""Interactive scope selection menu."""
import os
import sys

AVAILABLE_SCOPES = ('browser', 'media', 'filesystem', 'terminal', 'screenshot')

def select_scopes():
    """Show a small keyboard-driven multi-select menu in an interactive terminal."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError('Choose scopes with --scopes when running without an interactive terminal.')

    selected = {'browser'}
    cursor = 0
    labels = [
        'Browser — open HTTP(S) URLs',
        'Media — control playback and volume',
        'Filesystem — list, read, and write files',
        'Terminal — run any installed command',
        'Screenshot — capture the desktop',
    ]
    lines = []

    def render(first=False):
        nonlocal lines
        current = [
            'Select Device scopes (↑/↓ move, Space toggles, Enter confirms, q cancels)',
            '',
        ]
        current.extend(f"{'❯' if index == cursor else ' '} [{'x' if scope in selected else ' '}] {label}"
                       for index, (scope, label) in enumerate(zip(AVAILABLE_SCOPES, labels)))
        current.extend(['', 'Browser is selected by default. Terminal can run any installed command.'])
        if not first:
            sys.stdout.write(f'\x1b[{len(lines)}A')
        for line in current:
            sys.stdout.write('\r\x1b[2K' + line + '\n')
        sys.stdout.flush()
        lines = current

    def read_key():
        if os.name == 'nt':
            import msvcrt
            key = msvcrt.getwch()
            if key in ('\x00', '\xe0'):
                return {'H': 'up', 'P': 'down'}.get(msvcrt.getwch(), '')
            if key == '\x03': raise KeyboardInterrupt
            if key == '\r': return 'enter'
            if key == ' ': return 'space'
            return key.casefold()

        import termios
        import tty
        fd = sys.stdin.fileno()
        previous = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            key = sys.stdin.read(1)
            if key == '\x03': raise KeyboardInterrupt
            if key == '\x1b':
                sequence = sys.stdin.read(2)
                return {'\x1b[A': 'up', '\x1b[B': 'down'}.get(key + sequence, '')
            if key in ('\r', '\n'): return 'enter'
            if key == ' ': return 'space'
            return key.casefold()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous)

    sys.stdout.write('\x1b[?25l')
    try:
        render(first=True)
        while True:
            key = read_key()
            if key == 'up': cursor = (cursor - 1) % len(AVAILABLE_SCOPES)
            elif key == 'down': cursor = (cursor + 1) % len(AVAILABLE_SCOPES)
            elif key == 'space':
                scope = AVAILABLE_SCOPES[cursor]
                if scope in selected: selected.remove(scope)
                else: selected.add(scope)
            elif key == 'enter':
                return [scope for scope in AVAILABLE_SCOPES if scope in selected]
            elif key == 'q':
                raise SystemExit(0)
            render()
    finally:
        sys.stdout.write('\x1b[?25h\x1b[0m\n')
        sys.stdout.flush()

