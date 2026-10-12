"""Built-in, opt-in scopes for the Artemis device bridge."""
from . import browser, filesystem, media, screenshot, terminal

SCOPE_MODULES = {'browser': browser, 'media': media, 'filesystem': filesystem, 'terminal': terminal, 'screenshot': screenshot}

def build_scopes(args):
    tools, handlers = [], {}
    for scope in args.scopes:
        scope_tools, scope_handlers = SCOPE_MODULES[scope].register(args)
        tools.extend(scope_tools)
        handlers.update(scope_handlers)
    return tools, handlers
