import path from 'path'
import fs from 'fs'
import readPkgUp from 'read-pkg-up'
import minimatch from 'minimatch'
import resolve from 'eslint-module-utils/resolve'
import importType from '../core/importType'
import isStaticRequire from '../core/staticRequire'
import docsUrl from '../docsUrl'

function hasKeys(obj = {}) {
  return Object.keys(obj).length > 0
}

function extractDepFields(pkg) {
  return {
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
    optionalDependencies: pkg.optionalDependencies || {},
    peerDependencies: pkg.peerDependencies || {},
  }
}

function assignDeps(fromDeps, toDeps) {
  Object.assign(fromDeps.dependencies, toDeps.dependencies)
  Object.assign(fromDeps.devDependencies, toDeps.devDependencies)
  Object.assign(fromDeps.peerDependencies, toDeps.peerDependencies)
  Object.assign(fromDeps.optionalDependencies, toDeps.optionalDependencies)
}

function getDependencies(context, packageDir) {
  const files = []

  try {
    const closest = readPkgUp.sync({cwd: context.getFilename(), normalize: false})
    files.push(closest.path)

    const deps = (packageDir ? [].concat(packageDir) : [])
      .reduce((allDeps, dir) => {
        const pkgFile = path.resolve(dir, 'package.json')

        if (files.indexOf(pkgFile) === -1) {
          files.push(pkgFile)

          assignDeps(
            allDeps,
            extractDepFields(JSON.parse(fs.readFileSync(pkgFile, 'utf8')))
          )
        }

        return allDeps
      }, extractDepFields(closest.pkg))

    if ([
      deps.dependencies,
      deps.devDependencies,
      deps.optionalDependencies,
      deps.peerDependencies,
    ].some(hasKeys)) {
      return deps
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      context.report({
        message: 'The package.json file could not be found.',
        loc: { line: 0, column: 0 },
      })
    } else if (e.name === 'JSONError' || e instanceof SyntaxError) {
      context.report({
        message: 'The package.json file could not be parsed: ' + e.message,
        loc: { line: 0, column: 0 },
      })
    } else {
      context.report({
        message: e.message,
        loc: { line: 0, column: 0 },
      })
    }
  }
}

function missingErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies. ` +
    `Run 'npm i -S ${packageName}' to add it`
}

function devDepErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies, not devDependencies.`
}

function optDepErrorMessage(packageName) {
  return `'${packageName}' should be listed in the project's dependencies, ` +
    `not optionalDependencies.`
}

function reportIfMissing(context, deps, depsOptions, node, name) {
  // Do not report when importing types
  if (node.importKind === 'type') {
    return
  }

  if (importType(name, context) !== 'external') {
    return
  }

  const resolved = resolve(name, context)
  if (!resolved) { return }

  const splitName = name.split('/')
  const packageName = splitName[0][0] === '@'
    ? splitName.slice(0, 2).join('/')
    : splitName[0]
  const isInDeps = deps.dependencies[packageName] !== undefined
  const isInDevDeps = deps.devDependencies[packageName] !== undefined
  const isInOptDeps = deps.optionalDependencies[packageName] !== undefined
  const isInPeerDeps = deps.peerDependencies[packageName] !== undefined

  if (isInDeps ||
    (depsOptions.allowDevDeps && isInDevDeps) ||
    (depsOptions.allowPeerDeps && isInPeerDeps) ||
    (depsOptions.allowOptDeps && isInOptDeps)
  ) {
    return
  }

  if (isInDevDeps && !depsOptions.allowDevDeps) {
    context.report(node, devDepErrorMessage(packageName))
    return
  }

  if (isInOptDeps && !depsOptions.allowOptDeps) {
    context.report(node, optDepErrorMessage(packageName))
    return
  }

  context.report(node, missingErrorMessage(packageName))
}

function testConfig(config, filename) {
  // Simplest configuration first, either a boolean or nothing.
  if (typeof config === 'boolean' || typeof config === 'undefined') {
    return config
  }
  // Array of globs.
  return config.some(c => (
    minimatch(filename, c) ||
    minimatch(filename, path.join(process.cwd(), c))
  ))
}

module.exports = {
  meta: {
    docs: {
      url: docsUrl('no-extraneous-dependencies'),
    },

    schema: [
      {
        'type': 'object',
        'properties': {
          'devDependencies': { 'type': ['boolean', 'array'] },
          'optionalDependencies': { 'type': ['boolean', 'array'] },
          'peerDependencies': { 'type': ['boolean', 'array'] },
          'packageDir': { 'type': ['string', 'array'] },
        },
        'additionalProperties': false,
      },
    ],
  },

  create: function (context) {
    const options = context.options[0] || {}
    const filename = context.getFilename()
    const deps = getDependencies(context, options.packageDir)

    if (!deps) {
      return {}
    }

    const depsOptions = {
      allowDevDeps: testConfig(options.devDependencies, filename) !== false,
      allowOptDeps: testConfig(options.optionalDependencies, filename) !== false,
      allowPeerDeps: testConfig(options.peerDependencies, filename) !== false,
    }

    // todo: use module visitor from module-utils core
    return {
      ImportDeclaration: function (node) {
        reportIfMissing(context, deps, depsOptions, node, node.source.value)
      },
      CallExpression: function handleRequires(node) {
        if (isStaticRequire(node)) {
          reportIfMissing(context, deps, depsOptions, node, node.arguments[0].value)
        }
      },
    }
  },
}
