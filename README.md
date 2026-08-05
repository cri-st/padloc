# Padloc

Simple, secure password and data management for individuals and teams.

[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/padloc/padloc/tree/main)

## About

This repo is split into multiple packages:

| Package Name                            | Description                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [@padloc/core](packages/core)           | Core Logic                                                                                       |
| [@padloc/app](packages/app)             | Web-based UI components                                                                          |
| [@padloc/worker](packages/worker)       | The Cloudflare Worker backend                                                                    |
| [@padloc/pwa](packages/pwa)             | The Web Client, a [Progressive Web App](https://developers.google.com/web/progressive-web-apps). |
| [@padloc/locale](packages/locale)       | Package containing translations and other localization-related things                            |
| [@padloc/electron](packages/electron)   | The Desktop App, built with Electron                                                             |
| [@padloc/cordova](packages/cordova)     | Cordova project for building iOS and Android app.                                                |
| [@padloc/tauri](packages/tauri)         | Cross-platform native app, powered by [Tauri](https://github.com/tauri-apps/tauri)               |
| [@padloc/extension](packages/extension) | Padloc browser extension                                                                         |

## How to use

As you can see in the [About](#about) section, there are lots of different
components to play with! But at a minimum, in order to set up and use your own
instance of Padloc you'll need to run the
[Cloudflare Worker backend](packages/worker) and [Web Client](packages/pwa). In
practice, there are few different ways to do this, but if you just want to
install and test Padloc locally, doing so is really quite easy:

```sh
git clone git@github.com:padloc/padloc.git
cd padloc
npm ci
npm start
```

The web client is now available at `http://localhost:8080`!

In-depth guides on how to host your own "productive" version of Padloc and how
to build and distribute your own versions of the desktop and mobile apps are
coming soon!

## Contributing

All kinds of contributions are welcome!

If you want to **report a bug or have a feature request**, please
[create an issue](https://github.com/padloc/padloc/issues).

If you **have question, feedback or would just like to chat**, head over to the
[discussions](https://github.com/padloc/padloc/discussions) section.

If you want to **contribute to Padloc directly** by implementing a new feature
or fixing an existing issue, feel free to
[create a pull request](https://github.com/padloc/padloc/pulls)! However if you
plan to work on anything non-trivial, please do talk to us first, either by
commenting on an existing issue, creating a new issue or by pinging us in the
dissusions section!

To learn how to get started working on Padloc, refer to the
[Development](#development) section of the readme.

## Security

For a security design overview, check out the
[security whitepaper](security.md).

## HQ Observability

Padloc Worker HQ instrumentation lives in
`packages/worker/src/hq-instrumentation.ts`. It is optional and off by default:
it stays disabled unless the Worker secrets `HQ_SENTRY_DSN` and
`HQ_OTLP_ENDPOINT` are set (with derived vars `HQ_ENVIRONMENT`, `HQ_RELEASE`,
`HQ_SERVICE_NAME`), and validates them against the fixed host allowlist in that
file. Leave the secrets unset to keep it off.

Telemetry surface:

-   Sentry-compatible envelopes for reportable Worker errors
-   OTLP JSON traces for request/lifecycle spans
-   Fail-loud mis-wire, visible-warn graceful degrade on HQ outage

## Development

### Setup

Setting up your dev environment for working with Padloc is as simple as:

```sh
git clone git@github.com:padloc/padloc.git
cd padloc
npm ci
```

This may take a minute, so maybe grab a cup of ☕️.

### Dev Mode

To start "dev mode", simply run

```sh
npm run dev
```

from the root of the project. This will start the Cloudflare Worker backend on
`http://127.0.0.1:8787`, as well as the PWA (available on
`http://localhost:8080`) by default.

The worker and PWA port can be changed via the `PL_WORKER_PORT` and
`PL_PWA_PORT` environment variables, respectively. For more configuration
options, check out the worker config in `packages/worker/wrangler.toml` and the
[pwa](packages/pwa#configuration).

### Formatting

This project is formatted with [Prettier](https://prettier.io/). To re-format
all files using our [.prettierrc.json](.prettierrc.json) specification, run the
following from the root of the project.

```sh
npm run format
```

To simply check whether everything is formatted correctly, you can use the
following command:

```sh
npm run format:check
```

### Testing

To run unit tests, use:

```sh
npm run test
```

Cypress end-to-end tests can be run via:

```sh
npm run test:e2e
```

And to start cypress tests in "dev mode":

```ssh
npm run test:e2e:dev
```

### Browser Extension

To build the unpacked extension:

```sh
npm run web-extension:build
```

The resulting `dist/` folder can be loaded as an unpacked Chrome extension. See
[packages/extension/README.md](packages/extension/README.md) for build options
and full feature documentation.

To build and run the extension Playwright test harness (runtime smoke tests):

```sh
npm run test:extension
```

For iteration, use changed-only CH5 planning first:

```sh
npm run test:changed -- --since hq/main
```

The extension harness is headless by default. For visual debugging only:

```sh
PADLOC_EXTENSION_HEADFUL=1 npm run test:extension
```

The extension harness requires Chromium. Install it via:

```sh
cd packages/extension && npx playwright install chromium
```

### Adding / removing dependencies

Since this is a monorepo consisting of multiple packages, adding/removing
to/from a single package can be less than straightforward. The following
commands are meant to make this easier.

To add a dependency to a package, run:

```sh
scope=[package_name] npm run add [dependency]
```

And to remove one:

```sh
scope=[package_name] npm run remove [dependency]
```

For example, here is how you would add `typescript` to the `@padloc/server`
package:

```sh
scope=server npm run add typescript
```

**Note**: We're trying to keep the number and size of third-party dependencies
to a minumum, so before you add a dependency, please think twice if it is really
needed! Pull requests with unnecessary dependencies will very likely be
rejected.

### Updating The Version

The Padloc project consists of many different subpackages. To simplify
versioning, we use a global version for all them. This means that when releasing
a new version, the version of all subpackages needs to be updated, regardless of
whether there have been changes in them or not. To update the global version
accross the project, you can use the following command:

```sh
npm run version [semver_version]
```

### Deployment / Publishing

Padloc has a lot of different components that all need to be
built/released/published in different ways. To manage this complexity, we have
compiled all deployment steps for all components in a single Forgejo workflow.
To release a new version, simply:

1. [Update project version](#updating-the-version)
2. Commit and push.
3. Push to `main`; the [Docker Publish (GHCR)](.github/workflows/docker-publish.yml) workflow builds and pushes the images.

## Licensing

This software is published under the
[GNU Affero General Public License](LICENSE). If you wish to acquire a
commercial license, please contact us as
[sales@padloc.app](mailto:sales@padloc.app?subject=Padloc%20Commercial%20License).
