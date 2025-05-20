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

