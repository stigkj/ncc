const resolve = require("resolve");
const fs = require("graceful-fs");
const crypto = require("crypto");
const { join, dirname, resolve: pathResolve, basename, extname } = require("path");
const webpack = require("webpack");
const MemoryFS = require("memory-fs");
const terser = require("terser");
const tsconfigPaths = require("tsconfig-paths");
const TsconfigPathsPlugin = require("tsconfig-paths-webpack-plugin");
const shebangRegEx = require('./utils/shebang');
const nccCacheDir = require("./utils/ncc-cache-dir");
const { version: nccVersion } = require('../package.json');

// support glob graceful-fs
fs.gracefulify(require("fs"));

const nodeBuiltins = new Set([...require("repl")._builtinLibs, "constants", "module", "timers", "console", "_stream_writable", "_stream_readable", "_stream_duplex"]);

const SUPPORTED_EXTENSIONS = [".js", ".json", ".node", ".mjs", ".ts", ".tsx"];

const hashOf = name => {
  return crypto
		.createHash("md4")
		.update(name)
		.digest("hex")
		.slice(0, 10);
}

const defaultPermissions = 0o666;

const relocateLoader = eval('require(__dirname + "/loaders/relocate-loader.js")');

module.exports = (
  entry,
  {
    cache,
    externals = [],
    minify = false,
    sourceMap = false,
    sourceMapRegister = true,
    sourceMapBasePrefix = '../',
    watch = false,
    v8cache = false,
    quiet = false,
    debugLog = false
  } = {}
) => {
  const processedEntry = Object.create(null);
  if (entry instanceof Array) {
    entry.forEach(file => {
      processedEntry[basename(file)] = pathResolve(file);
    });
  }
  else if (typeof entry === 'object') {
    Object.keys(entry).forEach(item => {
      if (!item.endsWith('.js') && !item.endsWith('.mjs'))
        processedEntry[item + '.js'] = pathResolve(entry[item]);
      else
        processedEntry[item] = pathResolve(entry[item]);
    });
  }
  else if (typeof entry === 'string') {
    processedEntry['index.js'] = pathResolve(entry);
  }
  if (!quiet) {
    console.log(`ncc: Version ${nccVersion}`);
    console.log(`ncc: Compiling file${Object.keys(processedEntry).length > 1 ? 's' : ''} ${Object.values(processedEntry).join(', ')}`);
  }
  // How to handle for multi-entry case?
  process.env.TYPESCRIPT_LOOKUP_PATH = Object.values(processedEntry)[0];
  const mfs = new MemoryFS();

  const resolvePlugins = [];
  // add TsconfigPathsPlugin to support `paths` resolution in tsconfig
  // we need to catch here because the plugin will
  // error if there's no tsconfig in the working directory
  try {
    resolvePlugins.push(new TsconfigPathsPlugin({ silent: true }));

    const tsconfig = tsconfigPaths.loadConfig();
    if (tsconfig.resultType === "success") {
      tsconfigMatchPath = tsconfigPaths.createMatchPath(tsconfig.absoluteBaseUrl, tsconfig.paths);
    }
  } catch (e) {}

  resolvePlugins.push({
    apply(resolver) {
      const resolve = resolver.resolve;
      resolver.resolve = function (context, path, request, resolveContext, callback) {
        resolve.call(resolver, context, path, request, resolveContext, function (err, result) {
          if (!err) return callback(null, result);
          if (!err.missing || !err.missing.length)
            return callback(err);
          // make not found errors runtime errors
          callback(null, __dirname + '/@@notfound.js' + '?' + (externalMap.get(request) || request));
        });
      };
    }
  });

  const externalMap = new Map();

  if (externals instanceof Array)
    externals.forEach(external => externalMap.set(external, external));
  else if (typeof externals === 'object')
    Object.keys(externals).forEach(external => externalMap.set(external, externals[external]));

  let watcher, watchHandler, rebuildHandler;

  const compiler = webpack({
    entry: processedEntry,
    cache: cache === false ? undefined : {
      type: "filesystem",
      cacheDirectory: typeof cache === 'string' ? cache : nccCacheDir,
      name: `ncc_${hashOf(JSON.stringify(entry))}`,
      version: nccVersion
    },
    amd: false,
    optimization: {
      nodeEnv: false,
      minimize: false,
      moduleIds: 'deterministic',
      chunkIds: 'deterministic',
      mangleExports: false,
      splitChunks: typeof entry === 'object' && Object.keys(entry).length > 1 ? {
        chunks: 'all'
      } : false
    },
    devtool: sourceMap ? "source-map" : false,
    mode: "production",
    target: "node",
    output: {
      path: "/",
      filename: "[name]",
      libraryTarget: "commonjs2"
    },
    resolve: {
      extensions: SUPPORTED_EXTENSIONS,
      // webpack defaults to `module` and `main`, but that's
      // not really what node.js supports, so we reset it
      mainFields: ["main"],
      plugins: resolvePlugins
    },
    // https://github.com/zeit/ncc/pull/29#pullrequestreview-177152175
    node: false,
    externals: async ({ context, request }, callback) => {
      if (externalMap.has(request)) return callback(null, `commonjs ${externalMap.get(request)}`);
      return callback();
    },
    module: {
      rules: [
        {
          test: /@@notfound\.js$/,
          use: [{
            loader: eval('__dirname + "/loaders/notfound-loader.js"')
          }]
        },
        {
          test: /\.(js|mjs|tsx?|node)$/,
          use: [{
            loader: eval('__dirname + "/loaders/empty-loader.js"')
          }, {
            loader: eval('__dirname + "/loaders/relocate-loader.js"'),
            options: {
              outputAssetBase: 'assets',
              escapeNonAnalyzableRequires: true,
              wrapperCompatibility: true,
              debugLog
            }
          }]
        },
        {
          test: /\.tsx?$/,
          use: [{
            loader: eval('__dirname + "/loaders/uncacheable.js"')
          },
          {
            loader: eval('__dirname + "/loaders/ts-loader.js"'),
            options: {
              compiler: eval('__dirname + "/typescript.js"'),
              compilerOptions: {
                outDir: '//',
                noEmit: false
              }
            }
          }]
        },
        {
          parser: { amd: false },
          exclude: /\.node$/,
          use: [{
            loader: eval('__dirname + "/loaders/shebang-loader.js"')
          }]
        }
      ]
    },
    plugins: [
      {
        apply(compiler) {
          // override "not found" context to try built require first
          compiler.hooks.compilation.tap("ncc", compilation => {
            compilation.moduleTemplates.javascript.hooks.render.tap(
              "ncc",
              (
                moduleSourcePostModule,
                module,
                options,
                dependencyTemplates
              ) => {
                if (
                  module._contextDependencies &&
                  moduleSourcePostModule._value.match(
                    /webpackEmptyAsyncContext|webpackEmptyContext/
                  )
                ) {
                  // ensure __webpack_require__ is added to wrapper
                  module.type = 'custom';
                  return moduleSourcePostModule._value.replace(
                    "var e = new Error",
                    `if (typeof req === 'number' && __webpack_require__.m[req])\n` +
                    `  return __webpack_require__(req);\n` +
                    `try { return require(req) }\n` + 
                    `catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }\n` +
                    `var e = new Error`
                  );
                }
              }
            );
          });
          compiler.hooks.compilation.tap("relocate-loader", relocateLoader.initAssetPermissionsCache);
          compiler.hooks.watchRun.tap("ncc", () => {
            if (rebuildHandler)
              rebuildHandler();
          });
          compiler.hooks.normalModuleFactory.tap("ncc", NormalModuleFactory => {
            function handler(parser) {
              parser.hooks.assign.for("require").intercept({
                register: tapInfo => {
                  if (tapInfo.name !== "CommonJsPlugin") {
                    return tapInfo;
                  }
                  tapInfo.fn = () => {};
                  return tapInfo;
                }
              });
            }
            NormalModuleFactory.hooks.parser
              .for("javascript/auto")
              .tap("ncc", handler);
            NormalModuleFactory.hooks.parser
              .for("javascript/dynamic")
              .tap("ncc", handler);

            return NormalModuleFactory;
          });
        }
      }
    ]
  });
  compiler.outputFileSystem = mfs;
  if (!watch) {
    return new Promise((resolve, reject) => {
      compiler.run((err, stats) => {
        if (err) return reject(err);
        compiler.close(err => {
          if (err) return reject(err);
          if (stats.hasErrors()) {
            const errLog = stats.compilation.errors.map(err => err.message).join('\n');
            return reject(new Error(errLog));
          }
          resolve(stats);
        });
      });
    })
    .then(finalizeHandler);
  }
  else {
    if (typeof watch === 'object') {
      if (!watch.watch)
        throw new Error('Watcher class must be a valid Webpack WatchFileSystem class instance (https://github.com/webpack/webpack/blob/master/lib/node/NodeWatchFileSystem.js)');
      compiler.watchFileSystem = watch;
      watch.inputFileSystem = compiler.inputFileSystem;
    }
    let cachedResult;
    watcher = compiler.watch({}, (err, stats) => {
      if (err)
        return watchHandler({ err });
      if (stats.hasErrors())
        return watchHandler({ err: stats.toString() });
      const returnValue = finalizeHandler(stats);
      if (watchHandler)
        watchHandler(returnValue);
      else
        cachedResult = returnValue;
    });
    let closed = false;
    return {
      close () {
        if (!watcher)
          throw new Error('No watcher to close.');
        if (closed)
          throw new Error('Watcher already closed.');
        closed = true;
        watcher.close();
      },
      handler (handler) {
        if (watchHandler)
          throw new Error('Watcher handler already provided.');
        watchHandler = handler;
        if (cachedResult) {
          handler(cachedResult);
          cachedResult = null;
        }
      },
      rebuild (handler) {
        if (rebuildHandler)
          throw new Error('Rebuild handler already provided.');
        rebuildHandler = handler;
      }
    };
  }

  function finalizeHandler (stats) {
    const files = Object.create(null);
    const symlinks = Object.create(null);
    getFlatFiles(mfs.data, files, relocateLoader.getAssetPermissions);
    for (const [key, value] of Object.entries(relocateLoader.getSymlinks())) {
      const resolved = join(dirname(key), value);
      if (resolved in files && key in files === false)
        symlinks[key] = value;
    }

    for (const chunk of stats.compilation.chunks) {
      finalizeOutput(chunk.files[0]);
    }

    function finalizeOutput (filename) {
      let code = mfs.readFileSync(`/${filename}`, "utf8");
      let map = sourceMap ? mfs.readFileSync(`/${filename}.map`, "utf8") : null;
  
      if (map) {
        map = JSON.parse(map);
        // make source map sources relative to output
        map.sources = map.sources.map(source => {
          // webpack:///webpack:/// happens too for some reason
          while (source.startsWith('webpack:///'))
            source = source.substr(11);
          if (source.startsWith('./'))
            source = source.substr(2);
          if (source.startsWith('webpack/'))
            return '/webpack/' + source.substr(8);
          return sourceMapBasePrefix + source;
        });
      }
  
      if (minify) {
        const result = terser.minify(code, {
          compress: false,
          mangle: {
            keep_classnames: true,
            keep_fnames: true
          },
          sourceMap: sourceMap ? {
            content: map,
            filename,
            url: `${filename}.map`
          } : false
        });
        // For some reason, auth0 returns "undefined"!
        // custom terser phase used over Webpack integration for this reason
        if (result.code !== undefined)
          ({ code, map } = { code: result.code, map: result.map });
      }
  
      if (v8cache) {
        const { Script } = require('vm');
        files[filename + '.cache'] = { source: new Script(code).createCachedData(), permissions: defaultPermissions };
        files[filename + '.cache.js'] = { source: code, permissions: defaultPermissions };
        if (map) {
          files[filename + '.map'] = { source: JSON.stringify(map), permissions: defaultPermissions };
          map = undefined;
        }
        code =
          `if (process.pkg || require('process').platform === 'win32') {\n` +
            `module.exports=require('./${filename}.cache.js');\n` +
          `} else {\n` +
            `const { readFileSync, writeFileSync } = require('fs'), { Script } = require('vm'), { wrap } = require('module');\n` +
            `const source = readFileSync(__dirname + '/${filename}.cache.js', 'utf-8'), cachedData = readFileSync(__dirname + '/${filename}.cache');\n` +
            `const script = new Script(wrap(source), { cachedData });\n` +
            `(script.runInThisContext())(exports, require, module, __filename, __dirname);\n` +
            `process.on('exit', () => { try { writeFileSync(__dirname + '/${filename}.cache', script.createCachedData()); } catch(e) {} });\n` +
          `}`;
      }
  
      if (sourceMap && sourceMapRegister) {
        code = `require('./sourcemap-register.js');` + code;
        files['sourcemap-register.js'] = { source: fs.readFileSync(__dirname + "/sourcemap-register.js.cache.js"), permissions: defaultPermissions };
      }
  
      const entryPath = processedEntry[filename];
      let shebangMatch;
      try {
        shebangMatch = fs.readFileSync(entryPath).toString().match(shebangRegEx);
      }
      catch (e) {
        try {
          shebangMatch = fs.readFileSync(entryPath + '.js').toString().match(shebangRegEx);
        }
        catch (e) {}
      }
      if (shebangMatch) {
        code = shebangMatch[0] + code;
        // add a line offset to the sourcemap
        if (map)
          map.mappings = ";" + map.mappings;
      }

      files[filename].source = code;
      if (sourceMap && map)
        files[filename + '.map'].source = JSON.stringify(map);
    }

    return { files, symlinks };
  }
};

// this could be rewritten with actual FS apis / globs, but this is simpler
function getFlatFiles(mfsData, output, getAssetPermissions, curBase = "") {
  for (const path of Object.keys(mfsData)) {
    const item = mfsData[path];
    const curPath = `${curBase}/${path}`;
    // directory
    if (item[""] === true) getFlatFiles(item, output, getAssetPermissions, curPath);
    // file
    else if (!curPath.endsWith("/")) {
      output[curPath.substr(1)] = {
        source: mfsData[path],
        permissions: getAssetPermissions(curPath.substr(1)) || defaultPermissions
      };
    }
  }
}
