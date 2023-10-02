# Package development notes

To use and debug package locally you don't need publish it to NPM registry:

```shell script
$ cd <package-location>
$ npm install && npm run build && npm link
```

After that you have to create symlink to your package in your project folder:

```shell script
$ cd <project-location>
$ npm link @khulnasoft/code-client
```

## Publishing

### Before publishing make sure test pass

Test variables:

- `KHULNASOFT_API_HOST` is the API server host (by default: https://deeproxy.dev.khulnasoft.com)
- `KHULNASOFT_AUTH_HOST` is the Khulnasoft authentication server host (by default: https://dev.khulnasoft.com)
- `KHULNASOFT_API_KEY` is a sessionToken of a user with access to the Khulnasoft

```shell script
$ cd <package-location>
$ KHULNASOFT_API_HOST=... KHULNASOFT_AUTH_HOST=... KHULNASOFT_API_KEY=... npm run test
```

#### Publish

Make sure you checked documentation about [semantic release prefixes](https://github.com/semantic-release/semantic-release)

For example, to make a major version your message must follow this format:

```
feat: <short message>

BREAKING CHANGE: <longer description>
```

No need to do anything else. We have CircleCI CI/CD pipeline with automatic semantic versioning.
