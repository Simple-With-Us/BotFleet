#!/usr/bin/env node
import { renderLinuxInstallScript } from "../../server/vm-cli-install.ts";

const environment = process.argv[2] === "local-vm" ? "local-vm" : "cloud";
process.stdout.write(renderLinuxInstallScript(environment));
