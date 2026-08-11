const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const MIN_NODE_VERSION = "22.18.0";

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version, minimum) {
  const parsed = parseVersion(version);
  const min = parseVersion(minimum);
  if (!parsed || !min) return false;

  for (let i = 0; i < 3; i++) {
    if (parsed[i] !== min[i]) return parsed[i] > min[i];
  }
  return true;
}

function run(entryFile) {
  if (!versionAtLeast(process.versions.node, MIN_NODE_VERSION)) {
    console.error(
      `typegraph-mcp requires Node >=${MIN_NODE_VERSION}.\n` +
        `Current Node is ${process.version} at ${process.execPath}.\n` +
        "Run `nvm use`, `fnm use`, or otherwise put a compatible Node on PATH, then retry.",
    );
    process.exit(1);
  }

  const jsFile = entryFile.replace(/\.ts$/, ".js");
  const runtimeFile = fs.existsSync(path.join(__dirname, jsFile)) ? jsFile : entryFile;

  import(pathToFileURL(path.join(__dirname, runtimeFile)).href).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { MIN_NODE_VERSION, run, versionAtLeast };
