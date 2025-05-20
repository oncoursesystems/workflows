# web-ci

The `web-ci` workflow is located at [.github/workflows/web-ci.yml](/oncoursesystems/workflows/tree/main/.github/workflows/web-ci.yml).

This workflow handles Continuous Integration (CI) for web applications that use .NET and/or Node.js. It supports building and testing both .NET and Node.js projects, with configurable versions and project paths.

This depends on the following actions:
- [actions/checkout](https://github.com/marketplace/actions/checkout)
- [actions/setup-dotnet](https://github.com/marketplace/actions/setup-dotnet)
- [actions/setup-node](https://github.com/marketplace/actions/setup-node)
- [oven-sh/setup-bun](https://github.com/marketplace/actions/setup-bun)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `self-hosted`

### `sparse-checkout`

**Optional** Paths to sparse checkout from the repository

### `dotnet-version`

**Optional** Version of .NET to use

**Default** `8.0.x`

### `dotnet-project-path`

**Optional** Path to the .NET project

**Default** `.`

### `dotnet-project-file`

**Optional** Specific .NET project file to build

### `bun-version`

**Optional** Version of Bun to use

**Default** `latest`

### `nodejs-version`

**Optional** Version of Node.js to use

**Default** `20.x`

### `nodejs-project-path`

**Optional** Path to the Node.js project

**Default** `.`

## Environment Variables

- `DOTNET_INSTALL_DIR`: "./.dotnet" (Needed for k8s runner permissions)
- `DOTNET_CLI_HOME`: "/tmp"
- `DOTNET_SKIP_FIRST_TIME_EXPERIENCE`: 1 (Suppresses welcome message)
- `CI`: 1 (Disables Husky and prevents npm install during dotnet build)

## Usage

```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  ci:
    uses: oncoursesystems/workflows/.github/workflows/web-ci.yml@main
    with:
      dotnet-version: 8.0.x
      dotnet-project-path: src/MyApp
      nodejs-version: 20.x
      nodejs-project-path: src/MyApp/ClientApp
```

This will:
1. Set up the specified development environments (.NET, Node.js, Bun)
2. Build and test the .NET project if specified
3. Build and test the Node.js project if specified
4. Run both in parallel when both are specified
