"""Built-in, opt-in scopes for the Artemis device bridge."""

from . import browser, filesystem, media, screenshot, terminal
from .settings import ScopeSettings

SCOPE_MODULES = {
    "browser": browser,
    "media": media,
    "filesystem": filesystem,
    "terminal": terminal,
    "screenshot": screenshot,
}
# The one list of scope names: the CLI choices and the interactive menu both read it.
AVAILABLE_SCOPES = tuple(SCOPE_MODULES)


def build_scopes(scopes: list[str], settings: ScopeSettings):
    tools, handlers = [], {}
    for scope in scopes:
        scope_tools, scope_handlers = SCOPE_MODULES[scope].register(settings)
        tools.extend(scope_tools)
        handlers.update(scope_handlers)
    return tools, handlers
