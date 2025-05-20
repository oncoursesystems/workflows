# web-cd

The `web-cd` workflow is located at [.github/workflows/web-cd.yml](/oncoursesystems/workflows/tree/main/.github/workflows/web-cd.yml).

This workflow handles Continuous Deployment (CD) for web applications. It's a simple wrapper around the docker-build workflow that builds and publishes Docker images.

This depends on the following workflows:
- [docker-build](.github/workflows/docker-build.yml)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `self-hosted`

## Usage

```yaml
name: CD

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    uses: oncoursesystems/workflows/.github/workflows/web-cd.yml@main
    with:
      runs-on: self-hosted
```

This will:
1. Trigger the docker-build workflow to build and publish a Docker image
2. The image will be tagged based on the git tag that triggered the workflow
