#!/usr/bin/env node
import { parseVmCliShellEnvironment } from "../../server/vm-cli-manifest.ts";
import { renderLinuxInstallScript } from "../../server/vm-cli-install.ts";

const environment = parseVmCliShellEnvironment(process.argv[2]);
process.stdout.write(renderLinuxInstallScript(environment));
