# docker-build

The `docker-build` workflow is located at [.github/workflows/docker-build.yml](/oncoursesystems/workflows/tree/main/.github/workflows/docker-build.yml).

This workflow handles building and pushing Docker images to a container registry. It supports both GitHub Container Registry (GHCR) and other container registries, with configurable platform support and tagging rules.

This depends on the following actions:
- [docker/setup-buildx-action](https://github.com/marketplace/actions/docker-setup-buildx)
- [docker/login-action](https://github.com/marketplace/actions/docker-login)
- [docker/metadata-action](https://github.com/marketplace/actions/docker-metadata-action)
- [docker/build-push-action](https://github.com/marketplace/actions/build-and-push-docker-images)

## Inputs

### `context`

**Optional** Docker context (path) to start build from. To set to a subdir, use format of "{{defaultContext}}:mysubdir"

### `registry`

**Optional** Server address of the container registry. If not set then will default to GitHub

**Default** `ghcr.io`

### `image-name`

**Optional** The docker image name

**Default** `${{ github.repository }}`

### `runs-on`

**Optional** Defines the type of machine to run the workflow on

**Default** `self-hosted`

### `push`

**Optional** Enables pushing of the image to the container registry

**Default** `true`

### `platforms`

**Optional** The platforms to build for, comma-delimited

**Default** `linux/amd64`

### `tag-rules`

**Optional** Defines rules for creating tags

**Default**
```
type=ref,event=pr,priority=100
type=raw,value={{tag}},priority=100
type=raw,value=latest,enable={{is_default_branch}},priority=100
```

## Secrets

### `docker-username`

**Optional** Container registry username (if not using GitHub)

### `docker-password`

**Optional** Container registry password or personal access token (if not using GitHub)

## Usage

```yaml
name: Build Docker Image

on:
  push:
    tags:
      - 'v*'
    branches:
      - main
  pull_request:
    branches:
      - main

jobs:
  build:
    uses: oncoursesystems/workflows/.github/workflows/docker-build.yml@main
    with:
      platforms: linux/amd64,linux/arm64
    secrets:
      # Only needed if not using GitHub Container Registry
      docker-username: ${{ secrets.DOCKER_USERNAME }}
      docker-password: ${{ secrets.DOCKER_PASSWORD }}
```

This will:
1. Set up Docker Buildx for multi-platform builds
2. Log in to the container registry
3. Generate Docker metadata (tags, labels)
4. Build and push the Docker image according to the specified configuration
