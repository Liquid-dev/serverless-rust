"use strict";

// https://serverless.com/blog/writing-serverless-plugins/
// https://serverless.com/framework/docs/providers/aws/guide/plugins/
// https://github.com/softprops/lambda-rust/

const { spawnSync } = require("child_process");
const { homedir } = require("os");
const path = require("path");

const DEFAULT_DOCKER_TAG = "latest";
const DEFAULT_DOCKER_IMAGE = "softprops/lambda-rust";
const RUST_RUNTIME = "rust";
const BASE_RUNTIME = "provided.al2";
const NO_OUTPUT_CAPTURE = { stdio: ["ignore", process.stdout, process.stderr] };

function includeInvokeHook(serverlessVersion) {
  let [major, minor] = serverlessVersion.split(".");
  let majorVersion = parseInt(major);
  let minorVersion = parseInt(minor);
  return majorVersion === 1 && minorVersion >= 38 && minorVersion < 40;
}

/** assumes docker is on the host's execution path for containerized builds
 *  assumes cargo is on the host's execution path for local builds
 */
class RustPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.servicePath = this.serverless.config.servicePath || "";
    this.hooks = {
      "before:package:createDeploymentArtifacts": this.build.bind(this),
      "before:deploy:function:packageFunction": this.build.bind(this),
      "before:offline:start": this.build.bind(this),
      "before:offline:start:init": this.build.bind(this),
    };
    if (includeInvokeHook(serverless.version)) {
      this.hooks["before:invoke:local:invoke"] = this.build.bind(this);
    }
    this.custom = Object.assign(
      {
        cargoFlags: "",
        dockerTag: DEFAULT_DOCKER_TAG,
        dockerImage: DEFAULT_DOCKER_IMAGE,
        dockerless: false,
      },
      (this.serverless.service.custom && this.serverless.service.custom.rust) ||
        {}
    );

    // Docker can't access resources outside of the current build directory.
    // This poses a problem if the serverless yaml is inside a workspace,
    // and we want pull in other packages from the workspace
    this.srcPath = path.resolve(this.custom.dockerPath || this.servicePath);

    // By default, Serverless examines node_modules to figure out which
    // packages there are from dependencies versus devDependencies of a
    // package. While there will always be a node_modules due to Serverless
    // and this plugin being installed, it will be excluded anyway.
    // Therefore, the filtering can be disabled to speed up (~3.2s) the process.
    this.serverless.service.package.excludeDevDependencies = false;
  }

  dockerBuildArgs(
    cargoPackage,
    profile,
    srcPath,
    cargoRegistry,
    cargoDownloads,
    env
  ) {
    const defaultArgs = [
      "run",
      "--rm",
      "-t",
      "-e",
      `-v`,
      `${srcPath}:/code`,
      `-v`,
      `${cargoRegistry}:/cargo/registry`,
      `-v`,
      `${cargoDownloads}:/cargo/git`,
    ];
    const customArgs = (env["SLS_DOCKER_ARGS"] || "").split(" ") || [];
    let cargoFlags = this.custom.cargoFlags;
    if (profile) {
      // release or dev
      customArgs.push("-e", `PROFILE=${profile}`);
    }
    if (cargoPackage != undefined) {
      if (cargoFlags) {
        cargoFlags = `${cargoFlags} -p ${cargoPackage}`;
      } else {
        cargoFlags = ` -p ${cargoPackage}`;
      }
    }
    if (cargoFlags) {
      // --features awesome-feature, ect
      customArgs.push("-e", `CARGO_FLAGS=${cargoFlags}`);
    }

    return [
      ...defaultArgs,
      ...customArgs,
      `${this.custom.dockerTag}:${this.custom.dockerImage}`,
    ].filter((i) => i);
  }

  dockerBuild(cargoPackage, profile) {
    const cargoHome = process.env.CARGO_HOME || path.join(homedir(), ".cargo");
    const cargoRegistry = path.join(cargoHome, "registry");
    const cargoDownloads = path.join(cargoHome, "git");

    const dockerCLI = process.env["SLS_DOCKER_CLI"] || "docker";
    const args = this.dockerBuildArgs(
      cargoPackage,
      profile,
      this.srcPath,
      cargoRegistry,
      cargoDownloads,
      process.env
    );

    this.serverless.cli.log("Running containerized build");

    return spawnSync(dockerCLI, args, NO_OUTPUT_CAPTURE);
  }

  functions() {
    if (this.options.function) {
      return [this.options.function];
    } else {
      return this.serverless.service.getAllFunctions();
    }
  }

  /** the entry point for building functions */
  build() {
    const service = this.serverless.service;
    if (service.provider.name != "aws") {
      return;
    }
    let rustFunctionsFound = false;
    this.functions().forEach((funcName) => {
      const func = service.getFunction(funcName);
      const runtime = func.runtime || service.provider.runtime;
      if (runtime != RUST_RUNTIME) {
        // skip functions which don't apply to rust
        return;
      }
      rustFunctionsFound = true;
    });
    if (!rustFunctionsFound) {
      throw new Error(
        `Error: no Rust functions found. ` +
          `Use 'runtime: ${RUST_RUNTIME}' in global or ` +
          `function configuration to use this plugin.`
      );
    }

    const res = this.dockerBuild(this.custom.cargoPackage, this.custom.profile);
    if (res.error || res.status > 0) {
      this.serverless.cli.log(
        `Rust build encountered an error: ${res.error} ${res.status}.`
      );
      throw new Error(res.error);
    }
    
    this.functions().forEach((funcName) => {
      const func = service.getFunction(funcName);
      // If all went well, we should now have find a packaged compiled binary under `target/lambda/release`.
      //
      // The AWS "provided" lambda runtime requires executables to be named
      // "bootstrap" -- https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
      //
      // To avoid artifact naming conflicts when we potentially have more than one function
      // we leverage the ability to declare a package artifact directly
      // see https://serverless.com/framework/docs/providers/aws/guide/packaging/
      // for more information
      const artifactPath = path.join(
        this.srcPath,
        `target/lambda/${"dev" === profile ? "debug" : "release"}`,
        `${binary}.zip`
      );
      func.package = func.package || {};
      func.package.artifact = artifactPath;

      // Ensure the runtime is set to a sane value for other plugins
      if (func.runtime == RUST_RUNTIME) {
        func.runtime = BASE_RUNTIME;
      }
    });
    if (service.provider.runtime === RUST_RUNTIME) {
      service.provider.runtime = BASE_RUNTIME;
    }
  }
}

module.exports = RustPlugin;
