# GitHub Reusable Workflows

## Web Workflow CI/CD

WIP

## Mobile Workflow CI/CD

The mobile workflow is designed to publish code during all phases of development to make testing easier without having to dive into the developer workflow.  It utilizes public actions created by [Expo](https://github.com/expo/expo-github-action) and [Nearform](https://github.com/nearform/optic-release-automation-action).

### Quick Start

1. Copy the files from the `examples/mobile` folder and put them in the repository's `.github/workflows` folder.
1. Install the [optic-release-automation](https://github.com/apps/optic-release-automation) GitHub app to your organization (or selected repositories)
1. In the `package.json`, ensure there is a `version` string property that follows semantic versioning, and a `versionCode` number property.
1. In the `release.yml` workflow, make sure there is a build-command input in the `optic-release-automation-action` action that will increment the version code when run (we ended up using a node script that can be found in the examples folder).
1. Add a repository secret `EXPO_TOKEN` that contains a token generated in EAS that has permission to the project.
1. Profit

### Actions

- [expo-eas-build](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-build.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/expo-eas-build.md)) - queues a build in Expo EAS
- [expo-eas-clean](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-clean.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/expo-eas-clean.md)) - cleans up old branches/channels in EAS
- [expo-eas-submit](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-submit.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/expo-eas-submit.md)) - submits builds to the app stores
- [expo-eas-update](/oncoursesystems/workflows/tree/main/.github/workflows/expo-eas-update.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/expo-eas-update.md)) - publishes changes to a channel via Expo EAS
- [mobile-cd](/oncoursesystems/workflows/tree/main/.github/workflows/mobile-cd.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/mobile-cd.md)) - manages publishing a mobile application release
- [mobile-ci](/oncoursesystems/workflows/tree/main/.github/workflows/mobile-ci.yml) ([docs](/oncoursesystems/workflows/tree/main/docs/mobile-ci.md)) - manages publishing of a mobile application during the development lifecycle