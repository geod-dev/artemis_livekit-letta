"""Built-in, opt-in scopes for the Artemis device bridge."""
from .settings import ScopeSettings
from . import browser, filesystem, media, screenshot, terminal

SCOPE_MODULES = {'browser': browser, 'media': media, 'filesystem': filesystem, 'terminal': terminal, 'screenshot': screenshot}

def build_scopes(scopes: list[str], settings: ScopeSettings):
    tools, handlers = [], {}
    for scope in scopes:
        scope_tools, scope_handlers = SCOPE_MODULES[scope].register(settings)
        tools.extend(scope_tools)
        handlers.update(scope_handlers)
    return tools, handlers
