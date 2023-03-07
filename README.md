# Web Workflow CI/CD

WIP

# Mobile Workflow CI/CD

The mobile workflow is designed to publish code during all phases of development to make testing easier without having to dive into the developer workflow.  It utilizes public actions created by [Expo](https://github.com/expo/expo-github-action) and [Nearform](https://github.com/nearform/optic-release-automation-action).

## Quick Start

1. Copy the files from the `examples/mobile` folder and put them in the repository's `.github/workflows` folder.
1. Install the [optic-release-automation](https://github.com/apps/optic-release-automation) GitHub app to your organization (or selected repositories)
1. In the `package.json`, ensure there is a `version` string property that follows semantic versioning, and a `versionCode` number property 
1. In the `release.yml` workflow, make sure there is a build-command input in the `optic-release-automation-action` action that will increment the version code when run (we ended up using a node script that can be found in the examples folder)
1. Profit

## Mobile CI Reusable Workflow

This workflow will handle creating PR channels for testing and also push the master branch code into the "preview" channel when updated. It will also create iOS an Android builds if it is inside of a release automation PR. This workflow should be called when a PR is created against master or if code is pushed to master

### Example

```yaml
on:
  push:
    branches:
      - master
  pull_request:
    branches:
      - master
jobs:
  cd:
    uses: oncoursesystems/reusable-workflows/.github/workflows/mobile-ci@master
    secrets: inherit
```

## Mobile CD Reusable Workflow 

This workflow will submit the latest build to the app stores and also publish the code in the master branch to the "production" channel.  This workflow should be called using the release-published event

### Example 

```yaml
on:
  release:
    types: [published]
jobs:
  cd:
    uses: oncoursesystems/reusable-workflows/.github/workflows/mobile-cd@master
    secrets: inherit
```

## Expo EAS Build Action 

Action for queuing a new build for the given platform and profile.  This action assumes any platform-specific configuration is setup in the `eas.json`

### Inputs

#### `platform`

**Optional** An optional platform to target for the build

**Default** `all`

#### `profile`

**Optional** An optional profile to use for the build

**Default** `production`

#### `submit`

**Optional** An optional flag which will auto-submit the build when finished

**Default** `false`

#### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

### Example

```yaml
# TODO
```

## Expo EAS Submit Action 

Action for submitting the latest application build to the given platform app store.  This action assumes any platform-specific configuration is setup in the `eas.json`

### Inputs

#### `platform`

**Optional** An optional platform to target for the submission

**Default** `all`

#### `profile`

**Optional** An optional profile to use for the submission

**Default** `production`

#### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

### Example

```yaml
# TODO
```

## Expo EAS Clean Action

Action for cleaning up items in the Expo EAS account during the development workflow.  Typically used when a pull request is closed in order to delete the associated channel and branch.

### Inputs

#### `channel`

**Required** The channel/branch name to delete

#### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

### Example

```yaml
name: my-cleanup

on:
  pull_request:
    types: [closed]

jobs:
  clean:
    uses: oncoursesystems/reusable-workflows/.github/workflows/expo-eas-cleanup.yml@master
    with:
      channel: ${{ format('pr-{0}', github.event.number) }}
      runs-on: self-hosted
```

### Expo EAS Update Action

Action for publishing an update to the given channel.

### Inputs

#### `channel`

**Required** The channel to publish to

#### `message`

**Optional** An optional message describing the update

**Default** ``

#### `runs-on`

**Optional** An optional operating system on which to run the workflow

**Default** `self-hosted`

### Example

```yaml
# TODO
```