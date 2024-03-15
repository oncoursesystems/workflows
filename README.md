# GitHub Reusable Workflows

## Web Workflow CI/CD

The web workflow is designed to build and publish Docker images to a registry and deploy them to a Kubernetes cluster.

### Quick Start

1. Copy the files from the `examples/web` folder and put them in the repository's `.github/workflows` folder.
2. For the PR preview workflows, copy the template yaml files from the `examples/web/errata` folder and put them in the repositories `.github/workflows` folder.
3. For the PR preview workflows, you will need to base64 encode the kubeconfig file (typically in `~/.kube/config`) and create an environment secret called `KUBECONFIG_FILE` with the contents.
4. To release a new website version, use the `create-release` workflow. It should automatically create a GitHub release and a Docker image with the current timestamp as the tag.
5. If the GitOps system is working properly, you should see a new PR created in the [Devops repository](https://github.com/oncoursesystems/devops). Merge the PR to deploy the new version to the cluster.
6. Profit!

### Actions

- [create-release](.github/workflows/create-release.yml) ([docs](docs/create-release.md)) - Creates a GitHub release and publishes a Docker image with the current timestamp as the tag
- [docker-build](.github/workflows/docker-build.yml) ([docs](docs/docker-build.md)) - builds a Docker image and pushes it to a registry
- [pr-preview-cleanup](.github/workflows/pr-preview-cleanup.yml) ([docs](docs/pr-preview-cleanup.md)) - Removes a PR preview deployment from the cluster when the PR is closed
- [pr-preview-deploy](.github/workflows/pr-preview-deploy.yml) ([docs](docs/pr-preview-deploy.md)) - Deploys a PR preview to the cluster when given the `preview` label
- [web-cd](.github/workflows/web-cd.yml) ([docs](docs/web-cd.md)) - Manages publishing a web application release
- [web-ci](.github/workflows/web-ci.yml) ([docs](docs/web-ci.md)) - Manages building of a web application during the development lifecycle

## Mobile Workflow CI/CD

The mobile workflow is designed to publish code during all phases of development to make testing easier without having to dive into the developer workflow. It utilizes public actions created by [Expo](https://github.com/expo/expo-github-action) and [Nearform](https://github.com/nearform/optic-release-automation-action).

### Quick Start

1. Copy the files from the `examples/mobile` folder and put them in the repository's `.github/workflows` folder.
1. Install the [optic-release-automation](https://github.com/apps/optic-release-automation) GitHub app to your organization (or selected repositories)
1. In the `package.json`, ensure there is a `version` string property that follows semantic versioning, and a `versionCode` number property.
1. In the `release.yml` workflow, make sure there is a build-command input in the `optic-release-automation-action` action that will increment the version code when run (we ended up using a node script that can be found in the examples folder).
1. Add a repository secret `EXPO_TOKEN` that contains a token generated in EAS that has permission to the project.
1. Profit

### Actions

- [expo-eas-build](.github/workflows/expo-eas-build.yml) ([docs](docs/expo-eas-build.md)) - queues a build in Expo EAS
- [expo-eas-clean](.github/workflows/expo-eas-clean.yml) ([docs](docs/expo-eas-clean.md)) - cleans up old branches/channels in EAS
- [expo-eas-submit](.github/workflows/expo-eas-submit.yml) ([docs](docs/expo-eas-submit.md)) - submits builds to the app stores
- [expo-eas-update](.github/workflows/expo-eas-update.yml) ([docs](docs/expo-eas-update.md)) - publishes changes to a channel via Expo EAS
- [mobile-cd](.github/workflows/mobile-cd.yml) ([docs](docs/mobile-cd.md)) - manages publishing a mobile application release
- [mobile-ci](.github/workflows/mobile-ci.yml) ([docs](docs/mobile-ci.md)) - manages publishing of a mobile application during the development lifecycle
