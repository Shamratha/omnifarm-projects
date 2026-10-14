#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
const artifacts = ["index.html", "styles.css", "lab-core.js", "app.js"];

fs.mkdirSync(output, { recursive: true });
for (const name of fs.readdirSync(output)) {
  const target = path.join(output, name);
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

for (const name of artifacts) {
  const source = path.join(root, name);
  if (!fs.existsSync(source)) throw new Error(`Missing build input: ${name}`);
  fs.copyFileSync(source, path.join(output, name));
}

const missing = artifacts.filter(name => !fs.existsSync(path.join(output, name)));
if (missing.length) throw new Error(`Build output missing: ${missing.join(", ")}`);
console.log(`Built ${artifacts.length} local static artifacts in ${path.relative(root, output)}/`);
