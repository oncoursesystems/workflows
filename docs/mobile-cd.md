# mobile-cd

The `mobile-cd` action is located at [.github/workflows/mobile-cd.yml](/oncoursesystems/workflows/tree/main/.github/workflows/mobile-cd.yml).

This workflow will submit the latest build to the app stores and also publish the code in the main branch to the "production" channel.  This workflow should be called using the `release: published` event

This depends on the following actions:
- [expo-github-action](https://github.com/marketplace/actions/expo-github-action)


## Usage 

```yaml
on:
  release:
    types: [published]
jobs:
  cd:
    uses: oncoursesystems/workflows/.github/workflows/mobile-cd@main
    secrets: inherit
```