# Persistent assistant

A personal assistant with one Letta identity and memory, shared across text chat,
voice calls, and background work. The repository contains the web app, gateway,
LiveKit voice agent, Android WebView wrapper, and deployment configuration.

## Start here

- [Architecture](docs/architecture.md) explains how the services and shared conversation fit together.
- [Development](docs/development.md) covers local setup, commands, and Android builds.
- [Deployment](docs/deployment.md) covers Compose, persistent data, HTTPS, and Coolify operations.
- [Providers](docs/providers.md) documents model and voice provider configuration.
- [Connected devices](devices/README.md) describes the optional device bridge.
- [Android app](mobile/README.md) explains installation and wrapper behavior.

Copy `.env.example` to `.env` and set local credentials before starting services.
Production needs separate persistent workspace and backend-data roots and unique
secrets; see the deployment guide before using the production Compose override.
