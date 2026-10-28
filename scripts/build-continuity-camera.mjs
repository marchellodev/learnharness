/**
 * build-continuity-camera.mjs — compile the macOS Continuity Camera addon
 * (electron/native/continuity-camera.mm → continuity-camera.node).
 *
 * Plain clang, no node-gyp: the addon uses only Node-API (ABI-stable), so
 * one build loads in every Electron version, and the headers come from the
 * node-api-headers dev dependency. Universal (arm64 + x86_64) so an Intel
 * build needs nothing extra. A no-op off macOS; the app falls back to the
 * plain file picker whenever the addon is missing.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

if (process.platform !== "darwin") process.exit(0);

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "electron", "native", "continuity-camera.mm");
const OUT = path.join(ROOT, "electron", "native", "continuity-camera.node");
const HEADERS = path.join(ROOT, "node_modules", "node-api-headers", "include");

execFileSync("xcrun", [
	"clang++", "-std=c++17", "-ObjC++", "-fobjc-arc", "-O2", "-Wall", "-Werror",
	"-bundle", "-undefined", "dynamic_lookup",
	"-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=12.0",
	"-DNAPI_VERSION=8", "-DNODE_GYP_MODULE_NAME=continuity_camera",
	"-I", HEADERS, "-framework", "AppKit",
	SOURCE, "-o", OUT,
], { stdio: "inherit" });
console.log(`[build-continuity-camera] ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes)`);
