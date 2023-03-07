# mobile-ci

The `mobile-ci` action is located at [.github/workflows/mobile-ci.yml](/oncoursesystems/workflows/tree/main/.github/workflows/mobile-ci.yml).

This workflow will handle creating PR channels for testing and also push the main branch code into the "preview" channel when updated. It will also create iOS an Android builds if it is inside of a release automation PR. This workflow should be called when a PR is created against main or if code is pushed to main

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)


## Usage

```yaml
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
jobs:
  cd:
    uses: oncoursesystems/workflows/.github/workflows/mobile-ci@main
    secrets: inherit
```