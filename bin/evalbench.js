#!/usr/bin/env node
// Registers the tsx loader so the TypeScript sources and TypeScript method
// files load without a build step, then hands over to the CLI.
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
